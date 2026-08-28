import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./new-bootstrap-authorization.mjs", import.meta.url));

test("bootstrap authorization producer signs exact digests without username argv or output", () => {
  const root = mkdtempSync(path.join(tmpdir(), "bootstrap-authorization-producer-"));
  try {
    const fixture = producerFixture(root);
    const { username, request, runtime, filesystem, boundary, privateKeyPath, publicKeyPath, output, argumentsList, publicKey } = fixture;
    assert.equal(argumentsList.some((value) => value.startsWith("--username=")), false);
    const result = spawnSync(process.execPath, [script, ...argumentsList], { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout.includes(username), false);
    assert.equal(result.stdout.includes(root), false);

    const authorization = JSON.parse(readFileSync(output, "utf8"));
    assert.deepEqual(Object.keys(authorization).sort(), AUTHORIZATION_KEYS);
    assert.equal(authorization.usernameSha256, sha256(Buffer.from(username)));
    assert.equal(authorization.requestSha256, sha256(readFileSync(request)));
    assert.equal(authorization.runtimeConfigSha256, sha256(readFileSync(runtime)));
    assert.equal(authorization.filesystemEvidenceSha256, sha256(readFileSync(filesystem)));
    assert.equal(authorization.databaseBoundaryEvidenceSha256, sha256(readFileSync(boundary)));
    const signature = authorization.attestationSignature;
    delete authorization.attestationSignature;
    assert.equal(verify(null, Buffer.from(canonicalJson(authorization)), publicKey, Buffer.from(signature, "base64url")), true);
    assert.equal(
      authorization.signingKeyId,
      sha256(createPublicKey(createPrivateKey(readFileSync(privateKeyPath))).export({ type: "spki", format: "der" }))
    );
    assert.equal(sha256(readFileSync(publicKeyPath)), fixture.publicKeySha256);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bootstrap authorization producer rejects cross-key, hard-link, and ancestor reparse inputs", () => {
  const roots = [];
  try {
    const crossRoot = mkdtempSync(path.join(tmpdir(), "bootstrap-cross-key-")); roots.push(crossRoot);
    const cross = producerFixture(crossRoot, { crossKey: true });
    assert.notEqual(run(cross.argumentsList).status, 0);

    const hardRoot = mkdtempSync(path.join(tmpdir(), "bootstrap-hard-link-")); roots.push(hardRoot);
    const hard = producerFixture(hardRoot);
    const linkedPrivate = path.join(hard.signerRoot, "private-linked.pem");
    linkSync(hard.privateKeyPath, linkedPrivate);
    assert.notEqual(run(replaceArgument(hard.argumentsList, "private-key", linkedPrivate)).status, 0);

    const reparseRoot = mkdtempSync(path.join(tmpdir(), "bootstrap-reparse-")); roots.push(reparseRoot);
    const reparse = producerFixture(reparseRoot);
    const alias = path.join(reparseRoot, "signer-alias");
    symlinkSync(reparse.signerRoot, alias, process.platform === "win32" ? "junction" : "dir");
    reparse.filesystemValue.classRoots.SIGNER_ONLY = [alias];
    writeFileSync(reparse.filesystem, JSON.stringify(reparse.filesystemValue));
    let reparseArgs = replaceArgument(reparse.argumentsList, "private-key", path.join(alias, path.basename(reparse.privateKeyPath)));
    reparseArgs = replaceArgument(reparseArgs, "expected-filesystem-evidence-sha256", sha256(readFileSync(reparse.filesystem)));
    assert.notEqual(run(reparseArgs).status, 0);
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
});

test("bootstrap authorization producer rejects username argv before reading files", () => {
  const marker = "forbidden.operator";
  const result = spawnSync(process.execPath, [script, `--username=${marker}`], { encoding: "utf8", windowsHide: true });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout.includes(marker), false);
  assert.equal(result.stderr.includes(marker), false);
});

test("recovery authorization requires a signed v2 edge drain bound to runtime, Node, and release",()=>{
  const root=mkdtempSync(path.join(tmpdir(),"bootstrap-recovery-"));
  try{
    const fixture=recoveryFixture(root);const accepted=run(fixture.argumentsList);assert.equal(accepted.status,0,accepted.stderr);
    const authorization=JSON.parse(readFileSync(fixture.output,"utf8"));assert.equal(authorization.version,2);assert.equal(authorization.edgeSigningPublicKeySha256,fixture.edgePublicKeySha256);assert.equal(authorization.edgeReleaseManifestSha256,fixture.releaseManifestSha256);assert.equal(authorization.nodeProgramSha256,fixture.nodeProgramSha256);
    rmSync(fixture.output);
    const forged={...fixture.drainValue,version:1};delete forged.signingKeyId;delete forged.attestationSignature;const invalid={...forged,signingKeyId:fixture.edgeSigningKeyId,attestationSignature:fixture.signDrain(forged)};writeFileSync(fixture.drain,JSON.stringify(invalid));
    assert.notEqual(run(fixture.argumentsList).status,0);
  }finally{rmSync(root,{recursive:true,force:true})}
});

function file(root, name, content) {
  const value = path.join(root, name);
  mkdirSync(path.dirname(value), { recursive: true });
  writeFileSync(value, content, { flag: "wx", mode: 0o600 });
  return value;
}

function producerFixture(root, options = {}) {
  const adminRoot = path.join(root, "admin"), signerRoot = path.join(root, "signer"), sharedRoot = path.join(root, "shared"), evidenceRoot = path.join(root, "evidence");
  for (const item of [adminRoot, signerRoot, sharedRoot, evidenceRoot]) mkdirSync(item, { recursive: true });
  const username = "local.operator";
  const privatePair = generateKeyPairSync("ed25519");
  const publicKey = options.crossKey ? generateKeyPairSync("ed25519").publicKey : privatePair.publicKey;
  const privateBytes = privatePair.privateKey.export({ type: "pkcs8", format: "pem" });
  const publicBytes = publicKey.export({ type: "spki", format: "pem" });
  const privateKeyPath = file(signerRoot, "authorization-private.pem", privateBytes);
  const publicKeyPath = file(sharedRoot, "authorization-public.pem", publicBytes);
  const privateKeySha256 = sha256(readFileSync(privateKeyPath)), publicKeySha256 = sha256(readFileSync(publicKeyPath));
  const signingKeyId = sha256(privatePair.publicKey.export({ type: "spki", format: "der" }));
  const request = file(adminRoot, "request.json", JSON.stringify({ version: 2, username, authorizationPrivateKeySha256: privateKeySha256, authorizationPublicKeySha256: publicKeySha256, signingKeyId }));
  const boundary = file(evidenceRoot, "boundary.json", JSON.stringify({ version: 6, result: "PASS" }));
  const filesystem = path.join(evidenceRoot, "filesystem.json");
  const filesystemValue = { result: "PASS", exactAcl: true, descriptorDigest: "a".repeat(64), classRoots: { SIGNER_ONLY: [signerRoot], ADMIN_ONLY: [adminRoot], SHARED_RUNTIME: [sharedRoot], ADMIN_EVIDENCE: [evidenceRoot] } };
  writeFileSync(filesystem, JSON.stringify(filesystemValue), { flag: "wx", mode: 0o600 });
  const runtime = file(sharedRoot, "runtime.json", JSON.stringify({
    database: { provider: "supabase_postgres", projectRef: "abcdefghijklmnopqrst", connectionMode: "direct", host: "db.example.invalid", port: 5432, name: "postgres", schema: "public", boundaryEvidencePath: boundary },
    release: { id: "release-1" }, hostSecurity: { filesystemEvidencePath: filesystem }
  }));
  const output = path.join(adminRoot, "authorization.json"), tokenOutput = path.join(adminRoot, "token.json"), ledger = path.join(adminRoot, "consumed.json");
  const argumentsList = [
    "--mode=bootstrap", `--request=${request}`, `--runtime-config=${runtime}`, `--filesystem-evidence=${filesystem}`,
    `--database-boundary-evidence=${boundary}`, `--setup-token-output=${tokenOutput}`, `--ledger=${ledger}`,
    `--private-key=${privateKeyPath}`, `--public-key=${publicKeyPath}`, `--output=${output}`,
    `--expected-request-sha256=${sha256(readFileSync(request))}`, `--expected-runtime-config-sha256=${sha256(readFileSync(runtime))}`,
    `--expected-filesystem-evidence-sha256=${sha256(readFileSync(filesystem))}`, `--expected-database-boundary-evidence-sha256=${sha256(readFileSync(boundary))}`,
    `--expected-private-key-sha256=${privateKeySha256}`, `--expected-public-key-sha256=${publicKeySha256}`,
    `--expected-signing-key-id=${signingKeyId}`, `--expected-filesystem-descriptor-digest=${filesystemValue.descriptorDigest}`
  ];
  return { username, request, runtime, filesystem, filesystemValue, boundary, privateKeyPath, publicKeyPath, privateKeySha256, publicKeySha256, signingKeyId, output, argumentsList, publicKey, signerRoot };
}

function recoveryFixture(root){
  const fixture=producerFixture(root);const sharedRoot=path.dirname(fixture.publicKeyPath),evidenceRoot=path.dirname(fixture.boundary);
  const edgePair=generateKeyPairSync("ed25519");const edgePublicKeyPath=file(sharedRoot,"edge-public.pem",edgePair.publicKey.export({type:"spki",format:"pem"}));const edgePublicKeySha256=sha256(readFileSync(edgePublicKeyPath));const edgeSigningKeyId=sha256(edgePair.publicKey.export({type:"spki",format:"der"}));
  const nodeProgram=file(sharedRoot,"node.exe","fixture-node");const nodeProgramSha256=sha256(readFileSync(nodeProgram));const releaseManifest=file(sharedRoot,"release-manifest.json",JSON.stringify({version:4,releaseId:"release-1",runtimeSmokeVerified:true}));const releaseManifestSha256=sha256(readFileSync(releaseManifest));
  const runtimeValue=JSON.parse(readFileSync(fixture.runtime,"utf8"));runtimeValue.lan={bindAddress:"192.168.50.2"};runtimeValue.hostSecurity={...runtimeValue.hostSecurity,edgeSigningPublicKeyPath:edgePublicKeyPath,edgeSigningPublicKeySha256:edgePublicKeySha256,nodeProgramPath:nodeProgram,nodeProgramSha256};writeFileSync(fixture.runtime,JSON.stringify(runtimeValue));const runtimeSha256=sha256(readFileSync(fixture.runtime));
  const unsigned={attestationType:"edge-drain",version:2,result:"DRAINED",processId:process.pid,releaseId:"release-1",runtimeConfigSha256:runtimeSha256,nodeExecutableSha256:nodeProgramSha256,listenerAddress:"192.168.50.2",listenerPort:443,activeRequests:0,completedAt:new Date().toISOString()};const signDrain=(value)=>sign(null,Buffer.from(canonicalJson(value)),edgePair.privateKey).toString("base64url");const drainValue={...unsigned,signingKeyId:edgeSigningKeyId,attestationSignature:signDrain(unsigned)};const drain=file(evidenceRoot,"drain.json",JSON.stringify(drainValue));const maintenance=file(evidenceRoot,"maintenance.json","{}");const backup=file(evidenceRoot,"backup.json","{}");
  let argumentsList=replaceArgument(fixture.argumentsList,"mode","recover");argumentsList=replaceArgument(argumentsList,"expected-runtime-config-sha256",runtimeSha256);argumentsList.push(`--maintenance-evidence=${maintenance}`,`--drain-evidence=${drain}`,`--prechange-backup-evidence=${backup}`,`--edge-signing-public-key=${edgePublicKeyPath}`,`--edge-release-manifest=${releaseManifest}`,`--node-program=${nodeProgram}`,`--expected-edge-signing-public-key-sha256=${edgePublicKeySha256}`,`--expected-edge-release-manifest-sha256=${releaseManifestSha256}`,`--expected-node-program-sha256=${nodeProgramSha256}`);
  return {...fixture,argumentsList,edgePublicKeySha256,edgeSigningKeyId,nodeProgramSha256,releaseManifestSha256,drain,drainValue,signDrain};
}

function replaceArgument(values, name, replacement) { return values.map((value) => value.startsWith(`--${name}=`) ? `--${name}=${replacement}` : value); }
function run(argumentsList) { return spawnSync(process.execPath, [script, ...argumentsList], { encoding: "utf8", windowsHide: true }); }

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const AUTHORIZATION_KEYS = [
  "attestationSignature", "attestationType", "authorizationExpiresAt", "authorizationInstanceId",
  "authorizationIssuedAt", "authorizationNonce", "databaseBoundaryEvidenceSha256", "databaseConnectionMode",
  "databaseHost", "databaseName", "databasePort", "databaseProjectRef", "databaseSchema", "drainEvidenceSha256", "edgeReleaseManifestSha256", "edgeSigningPublicKeySha256",
  "filesystemDescriptorDigest", "filesystemEvidenceSha256", "ledgerPathSha256", "maintenanceEvidenceSha256",
  "mode", "prechangeBackupEvidenceSha256", "releaseId", "requestSha256", "result", "runtimeConfigPathSha256",
  "runtimeConfigSha256", "setupTokenOutputPathSha256", "signingKeyId", "nodeProgramSha256", "usernameSha256", "version"
].sort();
