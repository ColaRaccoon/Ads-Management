import { spawn } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createConnection } from "node:net";
import { request as httpRequest } from "node:http";
import path from "node:path";
import { uptime } from "node:os";
import { validateLocalRuntimeConfig } from "./runtime-config.mjs";
import { validateLocalApiConfigText } from "./api-config.mjs";
import { readJsonEvidence, readJsonEvidenceSnapshot } from "./evidence-reader.mjs";

const runtimeConfigPath = requiredEnvironment("LOCAL_RUNTIME_CONFIG_PATH");
const releaseRoot = path.resolve(requiredEnvironment("LOCAL_RELEASE_ROOT"));
const apiConfigPath = requiredEnvironment("CONFIG_PATH");
const runtimeConfigBytes = readBoundedRegularFile(runtimeConfigPath, 1_048_576, "LOCAL_RUNTIME_CONFIG");
const rawConfig = JSON.parse(runtimeConfigBytes.toString("utf8"));
const backupTargetSnapshot = readJsonEvidenceSnapshot(rawConfig.backup?.physicalTargetEvidencePath);
const config = validateLocalRuntimeConfig(rawConfig, {
  runtimeConfigPath,
  releaseRoot,
  clientTrustEvidence: readJsonEvidence(rawConfig.tls?.clientTrustEvidencePath),
  backupTargetEvidence: backupTargetSnapshot?.value ?? null,
  backupTargetEvidenceSha256: backupTargetSnapshot?.sha256 ?? null,
  backupScheduleEvidence: readJsonEvidence(rawConfig.backup?.scheduledTaskEvidencePath),
  latestBackupEvidence: readJsonEvidence(rawConfig.backup?.latestBackupEvidencePath),
  filesystemEvidence: readJsonEvidence(rawConfig.hostSecurity?.filesystemEvidencePath),
  databaseBoundaryEvidence: readJsonEvidence(rawConfig.database?.boundaryEvidencePath),
  firewallEvidence: readJsonEvidence(rawConfig.hostSecurity?.firewallEvidencePath),
  rebootEvidence: readJsonEvidence(rawConfig.hostSecurity?.rebootEvidencePath, { label: "REBOOT_EVIDENCE", allowMissingLeaf: true }),
  restoreEvidence: readJsonEvidence(rawConfig.backup?.restoreEvidencePath)
  ,recoveryEvidence: readJsonEvidence(rawConfig.backup?.recoveryEvidencePath)
  ,disasterRecoveryEvidence: readJsonEvidence(rawConfig.backup?.disasterRecoveryEvidencePath)
  ,runtimeConfigSha256: createHash("sha256").update(runtimeConfigBytes).digest("hex")
  ,bootedAt: Date.now()-uptime()*1000
  ,backupReceiptPublicKey: readKey(rawConfig.backup?.backupReceiptPublicKeyPath)
  ,restoreReceiptPublicKey: readKey(rawConfig.backup?.restoreReceiptPublicKeyPath)
});
const apiConfigBinding = validateLocalApiConfigText(readBoundedRegularFile(apiConfigPath, 1_048_576, "LOCAL_API_CONFIG").toString("utf8"), config);
const children = new Map();
let stopping = false;
const restartHistory = new Map();

await assertCorePortsFree(config.internalPorts);

start("api", path.join(releaseRoot, "api", "dist", "main.js"), {
  CONFIG_PATH: apiConfigPath,
  PORT: String(config.internalPorts.api),
  DEPLOYMENT_MODE: "local_lan",
  LOCAL_RELEASE_ID: config.release.id ?? "loopback-unreleased"
});
start("web", path.join(releaseRoot, "web", "server.js"), {
  PORT: String(config.internalPorts.web),
  HOSTNAME: "127.0.0.1",
  API_INTERNAL_PORT: String(config.internalPorts.api),
  HSTS_ENABLED: "false",
  LOCAL_RELEASE_ID: config.release.id ?? "loopback-unreleased"
});

try { await waitForCore(config.internalPorts, config.release.id ?? "loopback-unreleased", 60_000); }
catch { await stopAll(1); throw new Error("LOCAL_CORE_STARTUP_HEALTH_FAILED"); }

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => void stopAll(0));
process.stdout.write(`${JSON.stringify({ event: "local-core.ready", releaseId: config.release.id, apiConfigFingerprint: apiConfigBinding.publicFingerprint })}\n`);

function start(name, entrypoint, extraEnv) {
  const child = spawn(process.execPath, [entrypoint], {
    cwd: releaseRoot,
    env: { ...baseEnvironment(), ...extraEnv },
    stdio: ["ignore", "inherit", "inherit"],
    windowsHide: true
  });
  if (children.has(name)) throw new Error(`LOCAL_CORE_DUPLICATE_CHILD_${name.toUpperCase()}`);
  children.set(name, child);
  child.once("exit", (code) => {
    if (children.get(name) === child) children.delete(name);
    if (!stopping) {
      process.stderr.write(`${JSON.stringify({ event: "local-bundle.child-exit", component: name, code: Number(code ?? -1) })}\n`);
      const now = Date.now();
      const recent = [...(restartHistory.get(name) ?? []), now].filter((at) => at >= now - 600_000);
      restartHistory.set(name, recent);
      if (recent.length >= 5) { void stopAll(1); return; }
      const delay = Math.min(60_000, 5_000 * recent.length);
      setTimeout(() => { if (!stopping) start(name, entrypoint, extraEnv); }, delay).unref();
    }
  });
}

function baseEnvironment() {
  const result = {};
  for (const key of ["PATH", "PATHEXT", "SystemRoot", "WINDIR", "TEMP", "TMP", "LANG", "TZ"]) {
    if (process.env[key] !== undefined) result[key] = process.env[key];
  }
  result.NODE_ENV = "production";
  return result;
}

async function stopAll(exitCode) {
  if (stopping) return;
  stopping = true;
  for (const child of [...children.values()].reverse()) if (!child.killed) child.kill("SIGTERM");
  const deadline = Date.now() + 15_000;
  while ([...children.values()].some((child) => child.exitCode === null) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  for (const child of children.values()) if (child.exitCode === null) child.kill("SIGKILL");
  process.exitCode = exitCode;
}

async function assertCorePortsFree(ports) {
  if (await portOpen(ports.api) || await portOpen(ports.web)) throw new Error("LOCAL_CORE_PORT_ALREADY_IN_USE");
}

async function waitForCore(ports, releaseId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const apiChild=children.get("api"),webChild=children.get("web");
    if (apiChild?.exitCode===null && webChild?.exitCode===null &&
        await releaseHealth(ports.api,"/api/health/live",releaseId) &&
        await releaseHealth(ports.web,"/backend-api/health/live",releaseId)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("LOCAL_CORE_STARTUP_TIMEOUT");
}
function releaseHealth(port, target, releaseId) {
  return new Promise((resolve) => {
    const request=httpRequest({host:"127.0.0.1",port,path:target,method:"GET",headers:{host:`127.0.0.1:${port}`},timeout:750},(response)=>{
      let body="";response.setEncoding("utf8");response.on("data",(chunk)=>{body+=chunk;if(body.length>4096)request.destroy()});
      response.on("end",()=>{try{const value=JSON.parse(body);resolve(response.statusCode===200&&value.status==="live"&&value.releaseId===releaseId)}catch{resolve(false)}});
    });
    request.once("timeout",()=>{request.destroy();resolve(false)});request.once("error",()=>resolve(false));request.end();
  });
}
function portOpen(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(500); socket.once("connect", () => finish(true)); socket.once("timeout", () => finish(false)); socket.once("error", () => finish(false));
  });
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function readKey(value) {
  if (typeof value !== "string" || !value) return null;
  const bytes = readBoundedRegularFile(value, 16_384, "LOCAL_PUBLIC_KEY");
  if (bytes.length < 32 || bytes.length > 16_384) throw new Error("LOCAL_PUBLIC_KEY_SIZE_INVALID");
  return bytes;
}
function readBoundedRegularFile(value, maximumBytes, label) {
  const resolved=path.resolve(value);let cursor=path.parse(resolved).root;
  for(const segment of resolved.slice(cursor.length).split(path.sep).filter(Boolean)){
    cursor=path.join(cursor,segment);const stat=lstatSync(cursor);
    if(stat.isSymbolicLink())throw new Error(`${label}_REPARSE_POINT_FORBIDDEN`);
  }
  const stat=lstatSync(resolved);
  if(!stat.isFile()||stat.size<1||stat.size>maximumBytes)throw new Error(`${label}_SIZE_INVALID`);
  return readFileSync(resolved);
}
