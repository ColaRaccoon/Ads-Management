import { createHash, createPrivateKey, createPublicKey, randomBytes, randomUUID, sign, verify } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = new Map();
for (const argument of process.argv.slice(2)) {
  const separator = argument.indexOf("=");
  if (!argument.startsWith("--") || separator < 3) fail("BOOTSTRAP_AUTHORIZATION_ARGUMENT_INVALID");
  const name = argument.slice(2, separator);
  if (name === "username") fail("BOOTSTRAP_USERNAME_ARGV_FORBIDDEN");
  if (args.has(name)) fail("BOOTSTRAP_AUTHORIZATION_ARGUMENT_DUPLICATE");
  args.set(name, argument.slice(separator + 1));
}
const mode = args.get("mode");
if (mode !== "bootstrap" && mode !== "recover") fail("BOOTSTRAP_AUTHORIZATION_MODE_INVALID");
const requestPath = absolute("request");
const runtimePath = absolute("runtime-config");
const filesystemPath = absolute("filesystem-evidence");
const boundaryPath = absolute("database-boundary-evidence");
const outputTokenPath = absolute("setup-token-output");
const ledgerPath = absolute("ledger");
const privateKeyPath = absolute("private-key");
const publicKeyPath = absolute("public-key");
const outputPath = absolute("output");
const expectedRequestSha256 = shaArgument("expected-request-sha256");
const expectedRuntimeSha256 = shaArgument("expected-runtime-config-sha256");
const expectedFilesystemSha256 = shaArgument("expected-filesystem-evidence-sha256");
const expectedBoundarySha256 = shaArgument("expected-database-boundary-evidence-sha256");
const expectedPrivateKeySha256 = shaArgument("expected-private-key-sha256");
const expectedPublicKeySha256 = shaArgument("expected-public-key-sha256");
const expectedSigningKeyId = shaArgument("expected-signing-key-id");
const expectedFilesystemDescriptorDigest = shaArgument("expected-filesystem-descriptor-digest");
const requestBytes = bounded(requestPath, 4 * 1024, expectedRequestSha256);
const runtimeBytes = bounded(runtimePath, 1024 * 1024, expectedRuntimeSha256);
const filesystemBytes = bounded(filesystemPath, 1024 * 1024, expectedFilesystemSha256);
const boundaryBytes = bounded(boundaryPath, 64 * 1024, expectedBoundarySha256);
const request = parse(requestBytes), runtime = parse(runtimeBytes), filesystem = parse(filesystemBytes);
exactKeys(request, ["authorizationPrivateKeySha256", "authorizationPublicKeySha256", "signingKeyId", "username", "version"]);
const username = normalizeUsername(request.username);
const database = object(runtime.database), release = object(runtime.release), hostSecurity = object(runtime.hostSecurity), lan = object(runtime.lan);
const roots = object(filesystem.classRoots);
if (request.version !== 2 || request.authorizationPrivateKeySha256 !== expectedPrivateKeySha256 ||
    request.authorizationPublicKeySha256 !== expectedPublicKeySha256 || request.signingKeyId !== expectedSigningKeyId ||
    database.provider !== "supabase_postgres" || database.port !== 5432 ||
    !/^[a-z]{20}$/.test(String(database.projectRef ?? "")) || !["direct", "session_pooler"].includes(String(database.connectionMode ?? "")) ||
    !/^[a-z][a-z0-9_]{0,62}$/.test(String(database.name ?? "")) || !/^[a-z][a-z0-9_]{0,62}$/.test(String(database.schema ?? "")) ||
    !/^[a-z0-9][a-z0-9._-]{0,62}$/.test(String(release.id ?? "")) || filesystem.result !== "PASS" || filesystem.exactAcl !== true ||
    filesystem.descriptorDigest !== expectedFilesystemDescriptorDigest || path.resolve(String(hostSecurity.filesystemEvidencePath ?? "")) !== filesystemPath ||
    path.resolve(String(database.boundaryEvidencePath ?? "")) !== boundaryPath) fail("BOOTSTRAP_AUTHORIZATION_INPUT_BINDING_INVALID");
for (const name of ["SIGNER_ONLY", "ADMIN_ONLY", "SHARED_RUNTIME", "ADMIN_EVIDENCE"]) classRoots(roots, name);
for (const candidate of [requestPath, outputTokenPath, ledgerPath, outputPath]) requireClass(candidate, roots.ADMIN_ONLY, "BOOTSTRAP_AUTHORIZATION_ADMIN_ONLY_REQUIRED");
requireClass(privateKeyPath, roots.SIGNER_ONLY, "BOOTSTRAP_AUTHORIZATION_PRIVATE_KEY_CLASS_REJECTED");
requireClass(publicKeyPath, roots.SHARED_RUNTIME, "BOOTSTRAP_AUTHORIZATION_PUBLIC_KEY_CLASS_REJECTED");
requireClass(runtimePath, roots.SHARED_RUNTIME, "BOOTSTRAP_AUTHORIZATION_RUNTIME_CLASS_REJECTED");
for (const candidate of [filesystemPath, boundaryPath]) requireClass(candidate, roots.ADMIN_EVIDENCE, "BOOTSTRAP_AUTHORIZATION_EVIDENCE_CLASS_REJECTED");
for (const output of [outputTokenPath, ledgerPath, outputPath]) assertSafeOutput(output);

const recovery = mode === "recover";
const maintenancePath = optionalAbsolute("maintenance-evidence", recovery);
const drainPath = optionalAbsolute("drain-evidence", recovery);
const backupPath = optionalAbsolute("prechange-backup-evidence", recovery);
const edgePublicKeyPath = optionalAbsolute("edge-signing-public-key", recovery);
const releaseManifestPath = optionalAbsolute("edge-release-manifest", recovery);
const nodeProgramPath = optionalAbsolute("node-program", recovery);
const expectedEdgePublicKeySha256 = optionalShaArgument("expected-edge-signing-public-key-sha256", recovery);
const expectedReleaseManifestSha256 = optionalShaArgument("expected-edge-release-manifest-sha256", recovery);
const expectedNodeProgramSha256 = optionalShaArgument("expected-node-program-sha256", recovery);
if(recovery){
  for(const candidate of [edgePublicKeyPath,releaseManifestPath,nodeProgramPath])requireClass(candidate,roots.SHARED_RUNTIME,"BOOTSTRAP_RECOVERY_IDENTITY_CLASS_REJECTED");
  const edgePublicKeyBytes=bounded(edgePublicKeyPath,16*1024,expectedEdgePublicKeySha256);const manifestBytes=bounded(releaseManifestPath,128*1024*1024,expectedReleaseManifestSha256);bounded(nodeProgramPath,1024*1024*1024,expectedNodeProgramSha256);
  const manifest=parse(manifestBytes),drain=parse(bounded(drainPath,1024*1024));
  exactKeys(drain,["activeRequests","attestationSignature","attestationType","completedAt","listenerAddress","listenerPort","nodeExecutableSha256","processId","releaseId","result","runtimeConfigSha256","signingKeyId","version"]);
  const edgePublicKey=createPublicKey(edgePublicKeyBytes);const edgeSigningKeyId=sha256(edgePublicKey.export({type:"spki",format:"der"}));const signature=drain.attestationSignature;const unsigned={...drain};delete unsigned.signingKeyId;delete unsigned.attestationSignature;
  const drainAt=Date.parse(String(drain.completedAt??""));const now=Date.now();
  if(edgePublicKey.asymmetricKeyType!=="ed25519"||drain.signingKeyId!==edgeSigningKeyId||typeof signature!=="string"||!verify(null,Buffer.from(canonicalJson(unsigned),"utf8"),edgePublicKey,Buffer.from(signature,"base64url"))||
    manifest.version!==4||manifest.releaseId!==release.id||manifest.runtimeSmokeVerified!==true||path.resolve(String(hostSecurity.edgeSigningPublicKeyPath??""))!==edgePublicKeyPath||hostSecurity.edgeSigningPublicKeySha256!==expectedEdgePublicKeySha256||path.resolve(String(hostSecurity.nodeProgramPath??""))!==nodeProgramPath||hostSecurity.nodeProgramSha256!==expectedNodeProgramSha256||
    drain.attestationType!=="edge-drain"||drain.version!==2||drain.result!=="DRAINED"||drain.releaseId!==release.id||drain.runtimeConfigSha256!==expectedRuntimeSha256||drain.nodeExecutableSha256!==expectedNodeProgramSha256||drain.listenerAddress!==lan.bindAddress||drain.listenerPort!==443||drain.activeRequests!==0||!Number.isInteger(drain.processId)||drain.processId<=0||!fresh(drainAt,now,30_000)||!processExists(drain.processId))fail("BOOTSTRAP_RECOVERY_EDGE_DRAIN_REJECTED");
}
const issuedAt = new Date();
const expiresAt = new Date(issuedAt.valueOf() + 10 * 60_000);
const privateKeyBytes = bounded(privateKeyPath, 16 * 1024, expectedPrivateKeySha256);
const publicKeyBytes = bounded(publicKeyPath, 16 * 1024, expectedPublicKeySha256);
const privateKey = createPrivateKey(privateKeyBytes);
if (privateKey.asymmetricKeyType !== "ed25519") fail("BOOTSTRAP_AUTHORIZATION_PRIVATE_KEY_INVALID");
const signingKeyId = sha256(createPublicKey(privateKey).export({ type: "spki", format: "der" }));
const publicKey = createPublicKey(publicKeyBytes);
if (publicKey.asymmetricKeyType !== "ed25519" || signingKeyId !== expectedSigningKeyId ||
    sha256(publicKey.export({ type: "spki", format: "der" })) !== signingKeyId) fail("BOOTSTRAP_AUTHORIZATION_SIGNING_KEY_MISMATCH");
const value = {
  attestationType: "local-bootstrap-authorization",
  version: 2,
  result: "APPROVED",
  mode,
  usernameSha256: sha256(Buffer.from(username, "utf8")),
  requestSha256: sha256(requestBytes),
  runtimeConfigPathSha256: pathSha256(runtimePath),
  runtimeConfigSha256: sha256(runtimeBytes),
  filesystemEvidenceSha256: sha256(filesystemBytes),
  filesystemDescriptorDigest: filesystem.descriptorDigest,
  databaseBoundaryEvidenceSha256: sha256(boundaryBytes),
  databaseProjectRef: database.projectRef,
  databaseConnectionMode: database.connectionMode,
  databaseHost: database.host,
  databasePort: database.port,
  databaseName: database.name,
  databaseSchema: database.schema,
  releaseId: release.id,
  setupTokenOutputPathSha256: pathSha256(outputTokenPath),
  ledgerPathSha256: pathSha256(ledgerPath),
  maintenanceEvidenceSha256: maintenancePath ? sha256(bounded(maintenancePath, 1024 * 1024)) : null,
  drainEvidenceSha256: drainPath ? sha256(bounded(drainPath, 1024 * 1024)) : null,
  prechangeBackupEvidenceSha256: backupPath ? sha256(bounded(backupPath, 1024 * 1024)) : null,
  edgeSigningPublicKeySha256: edgePublicKeyPath ? expectedEdgePublicKeySha256 : null,
  edgeReleaseManifestSha256: releaseManifestPath ? expectedReleaseManifestSha256 : null,
  nodeProgramSha256: nodeProgramPath ? expectedNodeProgramSha256 : null,
  authorizationNonce: randomBytes(32).toString("hex"),
  authorizationInstanceId: randomUUID(),
  authorizationIssuedAt: issuedAt.toISOString(),
  authorizationExpiresAt: expiresAt.toISOString(),
  signingKeyId
};
const attestationSignature = sign(null, Buffer.from(canonicalJson(value), "utf8"), privateKey).toString("base64url");
writeFileSync(outputPath, JSON.stringify({ ...value, attestationSignature }), { flag: "wx", mode: 0o600 });
process.stdout.write(`${JSON.stringify({ result: "AUTHORIZED", authorizationSha256: sha256(readFileSync(outputPath)), expiresAt: expiresAt.toISOString() })}\n`);

function absolute(name) { const value = args.get(name); if (!value || !path.isAbsolute(value)) fail("BOOTSTRAP_AUTHORIZATION_ARGUMENT_INVALID"); return path.resolve(value); }
function optionalAbsolute(name, required) { const value = args.get(name); if (!value) { if (required) fail("BOOTSTRAP_RECOVERY_EVIDENCE_REQUIRED"); return null; } if (!path.isAbsolute(value)) fail("BOOTSTRAP_AUTHORIZATION_ARGUMENT_INVALID"); return path.resolve(value); }
function shaArgument(name) { const value = args.get(name); if (!/^[0-9a-f]{64}$/.test(String(value ?? ""))) fail("BOOTSTRAP_AUTHORIZATION_ARGUMENT_INVALID"); return value; }
function optionalShaArgument(name,required){const value=args.get(name);if(!value){if(required)fail("BOOTSTRAP_RECOVERY_IDENTITY_REQUIRED");return null;}if(!/^[0-9a-f]{64}$/.test(value))fail("BOOTSTRAP_AUTHORIZATION_ARGUMENT_INVALID");return value;}
function bounded(file, maximum, expected) { assertNoReparseComponents(file); const before = lstatSync(file); if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 1 || before.size > maximum) fail("BOOTSTRAP_AUTHORIZATION_INPUT_INVALID"); const handle = openSync(file, constants.O_RDONLY); try { const opened = fstatSync(handle), bytes = readFileSync(handle), after = lstatSync(file); if (opened.size !== before.size || after.size !== before.size || bytes.length !== before.size || opened.mtimeMs !== before.mtimeMs || after.mtimeMs !== before.mtimeMs || (expected && sha256(bytes) !== expected)) fail("BOOTSTRAP_AUTHORIZATION_INPUT_CHANGED"); return bytes; } finally { closeSync(handle); } }
function parse(bytes) { try { const value = JSON.parse(bytes.toString("utf8")); if (!value || typeof value !== "object" || Array.isArray(value)) fail("BOOTSTRAP_AUTHORIZATION_JSON_INVALID"); return value; } catch { fail("BOOTSTRAP_AUTHORIZATION_JSON_INVALID"); } }
function object(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function exactKeys(value, keys) { if (Object.keys(value).sort().join("\n") !== [...keys].sort().join("\n")) fail("BOOTSTRAP_REQUEST_KEYS_INVALID"); }
function classRoots(value, name) { const items = value[name]; if (!Array.isArray(items) || items.length < 1 || items.some((item) => typeof item !== "string" || !path.isAbsolute(item))) fail("BOOTSTRAP_AUTHORIZATION_FILESYSTEM_CLASSES_INVALID"); return items; }
function requireClass(candidate, values, code) { if (!values.some((root) => sameOrNested(candidate, root))) fail(code); }
function sameOrNested(candidate, root) { const relative = path.relative(path.resolve(root), path.resolve(candidate)); return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)); }
function assertSafeOutput(value) { assertNoReparseComponents(path.dirname(value)); const parent = lstatSync(path.dirname(value)); if (!parent.isDirectory() || parent.isSymbolicLink()) fail("BOOTSTRAP_AUTHORIZATION_OUTPUT_PARENT_INVALID"); }
function assertNoReparseComponents(value) { const full = path.resolve(value), parsed = path.parse(full); let current = parsed.root; for (const segment of full.slice(parsed.root.length).split(path.sep).filter(Boolean)) { current = path.join(current, segment); try { if (lstatSync(current).isSymbolicLink()) fail("BOOTSTRAP_AUTHORIZATION_REPARSE_REJECTED"); } catch (error) { if (error?.code === "ENOENT") continue; throw error; } } }
function normalizeUsername(value) { if (typeof value !== "string") fail("BOOTSTRAP_USERNAME_INVALID"); const normalized = value.normalize("NFKC").toLowerCase(); if (!/^[a-z][a-z0-9._-]{2,31}$/.test(normalized)) fail("BOOTSTRAP_USERNAME_INVALID"); return normalized; }
function pathSha256(value) { const normalized = path.resolve(value).replace(/[\\/]+$/, ""); return sha256(Buffer.from(process.platform === "win32" ? normalized.toLowerCase() : normalized, "utf8")); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function canonicalJson(value) { if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`; if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`; return JSON.stringify(value); }
function fresh(timestamp,now,maxAge){return Number.isFinite(timestamp)&&timestamp<=now+5*60_000&&timestamp>=now-maxAge;}
function processExists(pid){try{process.kill(pid,0);return true;}catch{return false;}}
function fail(code) { throw new Error(code); }
