import { lstatSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { uptime } from "node:os";
import path from "node:path";
import { startLocalHttpsEdge } from "./https-edge.mjs";

const configPath = process.env.LOCAL_RUNTIME_CONFIG_PATH;
if (!configPath) throw new Error("LOCAL_RUNTIME_CONFIG_PATH is required.");
const config = readJson(configPath);
const releaseRoot = fileURLToPath(new URL("../..", import.meta.url));
const evidence = () => {
  const backupTargetSnapshot = readEvidenceSnapshot(config.backup?.physicalTargetEvidencePath);
  return ({
  runtimeConfigPath: configPath,
  releaseRoot,
  clientTrustEvidence: readEvidence(config.tls?.clientTrustEvidencePath),
  backupTargetEvidence: backupTargetSnapshot?.value ?? null,
  backupTargetEvidenceSha256: backupTargetSnapshot?.sha256 ?? null,
  backupScheduleEvidence: readEvidence(config.backup?.scheduledTaskEvidencePath),
  latestBackupEvidence: readEvidence(config.backup?.latestBackupEvidencePath),
  filesystemEvidence: readEvidence(config.hostSecurity?.filesystemEvidencePath),
  databaseBoundaryEvidence: readEvidence(config.database?.boundaryEvidencePath),
  firewallEvidence: readEvidence(config.hostSecurity?.firewallEvidencePath),
  rebootEvidence: readEvidence(config.hostSecurity?.rebootEvidencePath),
  restoreEvidence: readEvidence(config.backup?.restoreEvidencePath)
  ,recoveryEvidence: readEvidence(config.backup?.recoveryEvidencePath)
  ,disasterRecoveryEvidence: readEvidence(config.backup?.disasterRecoveryEvidencePath)
  ,runtimeConfigSha256: createHash("sha256").update(readFileSync(configPath)).digest("hex")
  ,bootedAt: Date.now()-uptime()*1000
  ,backupReceiptPublicKey: readKey(config.backup?.backupReceiptPublicKeyPath)
  ,restoreReceiptPublicKey: readKey(config.backup?.restoreReceiptPublicKeyPath)
});
};
await startLocalHttpsEdge(config, { ...evidence(), readinessProvider: () => ({ rawConfig: readJson(configPath), evidence: evidence() }) });
process.stdout.write(`${JSON.stringify({ event: "https-edge.ready", port: 443 })}\n`);

function readEvidence(value) {
  if (typeof value !== "string" || !value) return null;
  return readJson(value);
}
function readEvidenceSnapshot(value) {
  if (typeof value !== "string" || !value) return null;
  const bytes = readBoundedRegularFile(value, 1_048_576, "LOCAL_EVIDENCE");
  return { value: JSON.parse(bytes.toString("utf8")), sha256: createHash("sha256").update(bytes).digest("hex") };
}
function readJson(value) {
  const bytes = readBoundedRegularFile(value, 1_048_576, "LOCAL_EVIDENCE");
  return JSON.parse(bytes.toString("utf8"));
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
