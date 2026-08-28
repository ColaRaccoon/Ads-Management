import { createHash, createPrivateKey, createPublicKey, randomBytes, randomUUID, sign } from "node:crypto";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
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
const outputPath = absolute("output");
const requestBytes = bounded(requestPath, 4 * 1024);
const runtimeBytes = bounded(runtimePath, 1024 * 1024);
const filesystemBytes = bounded(filesystemPath, 1024 * 1024);
const boundaryBytes = bounded(boundaryPath, 64 * 1024);
const request = parse(requestBytes), runtime = parse(runtimeBytes), filesystem = parse(filesystemBytes);
exactKeys(request, ["username", "version"]);
const username = normalizeUsername(request.username);
const database = object(runtime.database), release = object(runtime.release), hostSecurity = object(runtime.hostSecurity);
if (request.version !== 1 || database.provider !== "supabase_postgres" || database.port !== 5432 ||
    !/^[a-z]{20}$/.test(String(database.projectRef ?? "")) || !["direct", "session_pooler"].includes(String(database.connectionMode ?? "")) ||
    !/^[a-z][a-z0-9_]{0,62}$/.test(String(database.name ?? "")) || !/^[a-z][a-z0-9_]{0,62}$/.test(String(database.schema ?? "")) ||
    !/^[a-z0-9][a-z0-9._-]{0,62}$/.test(String(release.id ?? "")) || filesystem.result !== "PASS" || filesystem.exactAcl !== true ||
    !/^[0-9a-f]{64}$/.test(String(filesystem.descriptorDigest ?? "")) || path.resolve(String(hostSecurity.filesystemEvidencePath ?? "")) !== filesystemPath ||
    path.resolve(String(database.boundaryEvidencePath ?? "")) !== boundaryPath) fail("BOOTSTRAP_AUTHORIZATION_INPUT_BINDING_INVALID");

const recovery = mode === "recover";
const maintenancePath = optionalAbsolute("maintenance-evidence", recovery);
const drainPath = optionalAbsolute("drain-evidence", recovery);
const backupPath = optionalAbsolute("prechange-backup-evidence", recovery);
const issuedAt = new Date();
const expiresAt = new Date(issuedAt.valueOf() + 10 * 60_000);
const privateKey = createPrivateKey(bounded(privateKeyPath, 16 * 1024));
if (privateKey.asymmetricKeyType !== "ed25519") fail("BOOTSTRAP_AUTHORIZATION_PRIVATE_KEY_INVALID");
const signingKeyId = sha256(createPublicKey(privateKey).export({ type: "spki", format: "der" }));
const value = {
  attestationType: "local-bootstrap-authorization",
  version: 1,
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
function bounded(file, maximum) { const stat = lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 1 || stat.size > maximum) fail("BOOTSTRAP_AUTHORIZATION_INPUT_INVALID"); const bytes = readFileSync(file); if (bytes.length !== stat.size) fail("BOOTSTRAP_AUTHORIZATION_INPUT_CHANGED"); return bytes; }
function parse(bytes) { try { const value = JSON.parse(bytes.toString("utf8")); if (!value || typeof value !== "object" || Array.isArray(value)) fail("BOOTSTRAP_AUTHORIZATION_JSON_INVALID"); return value; } catch { fail("BOOTSTRAP_AUTHORIZATION_JSON_INVALID"); } }
function object(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function exactKeys(value, keys) { if (Object.keys(value).sort().join("\n") !== [...keys].sort().join("\n")) fail("BOOTSTRAP_REQUEST_KEYS_INVALID"); }
function normalizeUsername(value) { if (typeof value !== "string") fail("BOOTSTRAP_USERNAME_INVALID"); const normalized = value.normalize("NFKC").toLowerCase(); if (!/^[a-z][a-z0-9._-]{2,31}$/.test(normalized)) fail("BOOTSTRAP_USERNAME_INVALID"); return normalized; }
function pathSha256(value) { const normalized = path.resolve(value).replace(/[\\/]+$/, ""); return sha256(Buffer.from(process.platform === "win32" ? normalized.toLowerCase() : normalized, "utf8")); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function canonicalJson(value) { if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`; if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`; return JSON.stringify(value); }
function fail(code) { throw new Error(code); }
