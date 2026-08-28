import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { createHash, createPublicKey, verify } from "node:crypto";
import path from "node:path";
import { normalizeUsername } from "./local-credentials";

const SHA256 = /^[0-9a-f]{64}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const AUTHORIZATION_KEYS = [
  "attestationSignature", "attestationType", "authorizationExpiresAt", "authorizationInstanceId",
  "authorizationIssuedAt", "authorizationNonce", "databaseBoundaryEvidenceSha256", "databaseConnectionMode",
  "databaseHost", "databaseName", "databasePort", "databaseProjectRef", "databaseSchema",
  "drainEvidenceSha256", "edgeReleaseManifestSha256", "edgeSigningPublicKeySha256", "filesystemDescriptorDigest", "filesystemEvidenceSha256", "ledgerPathSha256",
  "maintenanceEvidenceSha256", "mode", "prechangeBackupEvidenceSha256", "releaseId", "requestSha256",
  "result", "runtimeConfigPathSha256", "runtimeConfigSha256", "setupTokenOutputPathSha256", "signingKeyId",
  "nodeProgramSha256", "usernameSha256", "version"
] as const;

export type BootstrapAuthorizationMode = "bootstrap" | "recover";

type JsonRecord = Record<string, unknown>;

export type BootstrapAuthorizationInput = {
  mode: BootstrapAuthorizationMode;
  requestPath: string;
  expectedRequestSha256: string;
  authorizationPath?: string;
  expectedAuthorizationSha256?: string;
  authorizationPublicKeyPath?: string;
  expectedAuthorizationPublicKeySha256?: string;
  ledgerPath?: string;
  runtimeConfigPath: string;
  expectedRuntimeConfigSha256: string;
  filesystemEvidencePath: string;
  expectedFilesystemEvidenceSha256: string;
  expectedFilesystemDescriptorDigest: string;
  databaseBoundaryEvidencePath: string;
  expectedDatabaseBoundaryEvidenceSha256: string;
  setupTokenOutputPath: string;
  maintenanceEvidenceSha256?: string | null;
  drainEvidenceSha256?: string | null;
  prechangeBackupEvidenceSha256?: string | null;
  edgeSigningPublicKeySha256?: string | null;
  edgeReleaseManifestSha256?: string | null;
  nodeProgramSha256?: string | null;
  database: {
    projectRef: string;
    connectionMode: "direct" | "session_pooler";
    host: string;
    port: number;
    name: string;
    schema: string;
  };
  releaseId: string;
  dataRoot: string;
  now?: number;
  clock?: () => number;
};

export type LoadedBootstrapAuthorization = {
  username: string;
  usernameSha256: string;
  consume: () => void;
};

export function loadBootstrapRequest(input: BootstrapAuthorizationInput) {
  const context = loadTrustedContext(input);
  return { username: context.username, usernameSha256: context.usernameSha256 };
}

export function loadBootstrapMutationAuthorization(input: BootstrapAuthorizationInput): LoadedBootstrapAuthorization {
  const context = loadTrustedContext(input);
  const authorizationPath = requiredAbsolute(input.authorizationPath, "BOOTSTRAP_AUTHORIZATION_PATH_REQUIRED");
  const publicKeyPath = requiredAbsolute(input.authorizationPublicKeyPath, "BOOTSTRAP_AUTHORIZATION_PUBLIC_KEY_PATH_REQUIRED");
  const ledgerPath = requiredAbsolute(input.ledgerPath, "BOOTSTRAP_AUTHORIZATION_LEDGER_PATH_REQUIRED");
  assertContained(authorizationPath, context.adminRoots, "BOOTSTRAP_AUTHORIZATION_NOT_ADMIN_ONLY");
  assertContained(ledgerPath, context.adminRoots, "BOOTSTRAP_LEDGER_NOT_ADMIN_ONLY");
  assertContained(publicKeyPath, context.sharedRuntimeRoots, "BOOTSTRAP_AUTHORIZATION_KEY_NOT_TRUSTED");
  assertNoReparseComponents(path.dirname(ledgerPath));

  const authorizationBytes = readPinnedFile(
    authorizationPath,
    requiredSha256(input.expectedAuthorizationSha256, "BOOTSTRAP_AUTHORIZATION_SHA256_REQUIRED"),
    64 * 1024,
    "BOOTSTRAP_AUTHORIZATION_INVALID"
  );
  const publicKeyBytes = readPinnedFile(
    publicKeyPath,
    requiredSha256(input.expectedAuthorizationPublicKeySha256, "BOOTSTRAP_AUTHORIZATION_PUBLIC_KEY_SHA256_REQUIRED"),
    16 * 1024,
    "BOOTSTRAP_AUTHORIZATION_PUBLIC_KEY_INVALID"
  );
  const authorization = parseObject(authorizationBytes, "BOOTSTRAP_AUTHORIZATION_INVALID");
  exactKeys(authorization, AUTHORIZATION_KEYS, "BOOTSTRAP_AUTHORIZATION_KEYS_INVALID");
  const publicKey = createPublicKey(publicKeyBytes);
  if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("BOOTSTRAP_AUTHORIZATION_PUBLIC_KEY_INVALID");
  const signingKeyId = sha256(publicKey.export({ type: "spki", format: "der" }));
  if (sha256(publicKeyBytes) !== context.authorizationPublicKeySha256 || signingKeyId !== context.signingKeyId) {
    throw new Error("BOOTSTRAP_AUTHORIZATION_SIGNING_KEY_NOT_PINNED");
  }
  const signature = authorization.attestationSignature;
  const unsigned = { ...authorization };
  delete unsigned.attestationSignature;
  if (authorization.signingKeyId !== signingKeyId || typeof signature !== "string" ||
      !/^[A-Za-z0-9_-]{80,128}$/.test(signature) ||
      !verify(null, Buffer.from(canonicalJson(unsigned), "utf8"), publicKey, Buffer.from(signature, "base64url"))) {
    throw new Error("BOOTSTRAP_AUTHORIZATION_SIGNATURE_INVALID");
  }

  const issuedAt = Date.parse(String(authorization.authorizationIssuedAt ?? ""));
  const expiresAt = Date.parse(String(authorization.authorizationExpiresAt ?? ""));
  assertAuthorizationTimeWindow(issuedAt, expiresAt, observedNow(input));
  if (authorization.attestationType !== "local-bootstrap-authorization" || authorization.version !== 2 ||
      authorization.result !== "APPROVED" || authorization.mode !== input.mode ||
      authorization.authorizationNonce === undefined || !SHA256.test(String(authorization.authorizationNonce)) ||
      !UUID_V4.test(String(authorization.authorizationInstanceId)) ||
      authorization.usernameSha256 !== context.usernameSha256 ||
      authorization.requestSha256 !== context.requestSha256 ||
      authorization.runtimeConfigPathSha256 !== pathSha256(input.runtimeConfigPath) ||
      authorization.runtimeConfigSha256 !== context.runtimeConfigSha256 ||
      authorization.filesystemEvidenceSha256 !== context.filesystemEvidenceSha256 ||
      authorization.filesystemDescriptorDigest !== input.expectedFilesystemDescriptorDigest ||
      authorization.databaseBoundaryEvidenceSha256 !== input.expectedDatabaseBoundaryEvidenceSha256 ||
      authorization.setupTokenOutputPathSha256 !== pathSha256(input.setupTokenOutputPath) ||
      authorization.ledgerPathSha256 !== pathSha256(ledgerPath) ||
      authorization.databaseProjectRef !== input.database.projectRef ||
      authorization.databaseConnectionMode !== input.database.connectionMode ||
      authorization.databaseHost !== input.database.host || authorization.databasePort !== input.database.port ||
      authorization.databaseName !== input.database.name || authorization.databaseSchema !== input.database.schema ||
      authorization.releaseId !== input.releaseId ||
      authorization.maintenanceEvidenceSha256 !== normalizedOptionalSha(input.maintenanceEvidenceSha256) ||
      authorization.drainEvidenceSha256 !== normalizedOptionalSha(input.drainEvidenceSha256) ||
      authorization.prechangeBackupEvidenceSha256 !== normalizedOptionalSha(input.prechangeBackupEvidenceSha256) ||
      authorization.edgeSigningPublicKeySha256 !== normalizedOptionalSha(input.edgeSigningPublicKeySha256) ||
      authorization.edgeReleaseManifestSha256 !== normalizedOptionalSha(input.edgeReleaseManifestSha256) ||
      authorization.nodeProgramSha256 !== normalizedOptionalSha(input.nodeProgramSha256)) {
    throw new Error("BOOTSTRAP_AUTHORIZATION_BINDING_REJECTED");
  }

  const authorizationSha256 = sha256(authorizationBytes);
  let consumed = false;
  return {
    username: context.username,
    usernameSha256: context.usernameSha256,
    consume() {
      if (consumed) throw new Error("BOOTSTRAP_AUTHORIZATION_REPLAY_REJECTED");
      const consumedAt = input.clock?.() ?? Date.now();
      assertAuthorizationTimeWindow(issuedAt, expiresAt, consumedAt);
      const currentRequest = readPinnedFile(input.requestPath, context.requestSha256, 4 * 1024, "BOOTSTRAP_REQUEST_CHANGED");
      if (sha256(currentRequest) !== context.requestSha256) throw new Error("BOOTSTRAP_REQUEST_CHANGED");
      let handle: number | undefined;
      try {
        handle = openSync(ledgerPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
        const record = Buffer.from(JSON.stringify({
          version: 1,
          authorizationType: "local-bootstrap-authorization",
          authorizationInstanceId: authorization.authorizationInstanceId,
          authorizationNonceSha256: sha256(Buffer.from(String(authorization.authorizationNonce), "utf8")),
          authorizationSha256,
          mode: input.mode,
          usernameSha256: context.usernameSha256,
          consumedAt: new Date(consumedAt).toISOString()
        }), "utf8");
        writeFileSync(handle, record);
        fsyncSync(handle);
        closeSync(handle);
        handle = undefined;
        unlinkSync(input.requestPath);
        consumed = true;
      } catch (error) {
        if (handle !== undefined) closeSync(handle);
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("BOOTSTRAP_AUTHORIZATION_REPLAY_REJECTED");
        throw error;
      }
    }
  };
}

function observedNow(input: BootstrapAuthorizationInput) {
  return input.clock?.() ?? input.now ?? Date.now();
}

function assertAuthorizationTimeWindow(issuedAt: number, expiresAt: number, now: number) {
  if (!Number.isFinite(now) || !Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt ||
      expiresAt - issuedAt > 10 * 60_000 || issuedAt > now + 60_000 || expiresAt < now) {
    throw new Error("BOOTSTRAP_AUTHORIZATION_EXPIRED");
  }
}

function loadTrustedContext(input: BootstrapAuthorizationInput) {
  const requestPath = requiredAbsolute(input.requestPath, "BOOTSTRAP_REQUEST_PATH_REQUIRED");
  const runtimeConfigPath = requiredAbsolute(input.runtimeConfigPath, "BOOTSTRAP_RUNTIME_CONFIG_PATH_REQUIRED");
  const filesystemEvidencePath = requiredAbsolute(input.filesystemEvidencePath, "BOOTSTRAP_FILESYSTEM_EVIDENCE_PATH_REQUIRED");
  const boundaryPath = requiredAbsolute(input.databaseBoundaryEvidencePath, "BOOTSTRAP_DATABASE_BOUNDARY_PATH_REQUIRED");
  const outputPath = requiredAbsolute(input.setupTokenOutputPath, "BOOTSTRAP_OUTPUT_PATH_REQUIRED");
  if (path.dirname(outputPath) !== path.resolve(input.dataRoot, "bootstrap-handoff")) {
    throw new Error("BOOTSTRAP_OUTPUT_PATH_INVALID");
  }
  const runtimeConfigSha256 = requiredSha256(input.expectedRuntimeConfigSha256, "BOOTSTRAP_RUNTIME_CONFIG_SHA256_REQUIRED");
  const filesystemEvidenceSha256 = requiredSha256(input.expectedFilesystemEvidenceSha256, "BOOTSTRAP_FILESYSTEM_EVIDENCE_SHA256_REQUIRED");
  requiredSha256(input.expectedDatabaseBoundaryEvidenceSha256, "BOOTSTRAP_DATABASE_BOUNDARY_SHA256_REQUIRED");
  requiredSha256(input.expectedFilesystemDescriptorDigest, "BOOTSTRAP_FILESYSTEM_DESCRIPTOR_REQUIRED");
  const runtime = parseObject(readPinnedFile(runtimeConfigPath, runtimeConfigSha256, 1024 * 1024, "BOOTSTRAP_RUNTIME_CONFIG_INVALID"), "BOOTSTRAP_RUNTIME_CONFIG_INVALID");
  const filesystem = parseObject(readPinnedFile(filesystemEvidencePath, filesystemEvidenceSha256, 1024 * 1024, "BOOTSTRAP_FILESYSTEM_EVIDENCE_INVALID"), "BOOTSTRAP_FILESYSTEM_EVIDENCE_INVALID");
  const adminRoots = stringRoots(filesystem, "ADMIN_ONLY");
  const sharedRuntimeRoots = stringRoots(filesystem, "SHARED_RUNTIME");
  const completedAt = Date.parse(String(filesystem.completedAt ?? ""));
  const runtimeDatabase = record(runtime.database), runtimeHost = record(runtime.hostSecurity), runtimeRelease = record(runtime.release), runtimeData = record(runtime.data);
  if (filesystem.result !== "PASS" || filesystem.exactAcl !== true || filesystem.descriptorDigest !== input.expectedFilesystemDescriptorDigest ||
      path.resolve(String(filesystem.dataRoot ?? "")) !== path.resolve(input.dataRoot) ||
      !Number.isFinite(completedAt) || completedAt > (input.now ?? Date.now()) + 5 * 60_000 || completedAt < (input.now ?? Date.now()) - 24 * 3600_000 ||
      path.resolve(String(runtimeHost.filesystemEvidencePath ?? "")) !== filesystemEvidencePath ||
      path.resolve(String(runtimeDatabase.boundaryEvidencePath ?? "")) !== boundaryPath ||
      path.resolve(String(runtimeData.root ?? "")) !== path.resolve(input.dataRoot) || runtimeRelease.id !== input.releaseId ||
      runtimeDatabase.provider !== "supabase_postgres" || runtimeDatabase.projectRef !== input.database.projectRef ||
      runtimeDatabase.connectionMode !== input.database.connectionMode || runtimeDatabase.host !== input.database.host ||
      runtimeDatabase.port !== input.database.port || runtimeDatabase.name !== input.database.name || runtimeDatabase.schema !== input.database.schema) {
    throw new Error("BOOTSTRAP_RUNTIME_OR_FILESYSTEM_BINDING_REJECTED");
  }
  if (input.mode === "recover" &&
      (runtimeHost.edgeSigningPublicKeySha256 !== input.edgeSigningPublicKeySha256 ||
       runtimeHost.nodeProgramSha256 !== input.nodeProgramSha256)) {
    throw new Error("BOOTSTRAP_RECOVERY_RUNTIME_IDENTITY_REJECTED");
  }
  for (const candidate of [requestPath, outputPath]) {
    assertContained(candidate, adminRoots, "BOOTSTRAP_ADMIN_ONLY_PATH_REQUIRED");
  }
  readPinnedFile(boundaryPath, input.expectedDatabaseBoundaryEvidenceSha256, 64 * 1024, "BOOTSTRAP_DATABASE_BOUNDARY_CHANGED");
  const requestBytes = readPinnedFile(requestPath, requiredSha256(input.expectedRequestSha256, "BOOTSTRAP_REQUEST_SHA256_REQUIRED"), 4 * 1024, "BOOTSTRAP_REQUEST_INVALID");
  const request = parseObject(requestBytes, "BOOTSTRAP_REQUEST_INVALID");
  exactKeys(request, ["authorizationPrivateKeySha256", "authorizationPublicKeySha256", "signingKeyId", "username", "version"], "BOOTSTRAP_REQUEST_KEYS_INVALID");
  if (request.version !== 2 || typeof request.username !== "string" ||
      typeof request.authorizationPrivateKeySha256 !== "string" || !SHA256.test(request.authorizationPrivateKeySha256) ||
      typeof request.authorizationPublicKeySha256 !== "string" || !SHA256.test(request.authorizationPublicKeySha256) ||
      typeof request.signingKeyId !== "string" || !SHA256.test(request.signingKeyId)) throw new Error("BOOTSTRAP_REQUEST_INVALID");
  const username = normalizeUsername(request.username);
  return {
    username,
    usernameSha256: sha256(Buffer.from(username, "utf8")),
    requestSha256: sha256(requestBytes),
    authorizationPublicKeySha256: request.authorizationPublicKeySha256,
    signingKeyId: request.signingKeyId,
    runtimeConfigSha256,
    filesystemEvidenceSha256,
    adminRoots,
    sharedRuntimeRoots
  };
}

function readPinnedFile(value: string, expected: string, maximum: number, code: string) {
  const full = requiredAbsolute(value, code);
  assertNoReparseComponents(full);
  const before = lstatSync(full);
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > maximum || before.nlink !== 1) throw new Error(code);
  const handle = openSync(full, constants.O_RDONLY);
  try {
    const opened = fstatSync(handle);
    const bytes = readFileSync(handle);
    const after = lstatSync(full);
    if (opened.size !== before.size || after.size !== before.size || bytes.length !== before.size ||
        opened.mtimeMs !== before.mtimeMs || after.mtimeMs !== before.mtimeMs || sha256(bytes) !== expected) throw new Error(code);
    return bytes;
  } finally { closeSync(handle); }
}

function parseObject(bytes: Buffer, code: string): JsonRecord {
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
    return value as JsonRecord;
  } catch { throw new Error(code); }
}

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function stringRoots(evidence: JsonRecord, name: string) {
  const roots = record(evidence.classRoots)[name];
  if (!Array.isArray(roots) || roots.length < 1 || roots.some((item) => typeof item !== "string" || !path.isAbsolute(item))) {
    throw new Error("BOOTSTRAP_FILESYSTEM_EVIDENCE_INVALID");
  }
  return roots as string[];
}

function assertContained(candidate: string, roots: string[], code: string) {
  if (!roots.some((root) => sameOrNested(candidate, root))) throw new Error(code);
}

function sameOrNested(candidate: string, root: string) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function requiredAbsolute(value: string | undefined, code: string) {
  if (!value || !path.isAbsolute(value)) throw new Error(code);
  return path.resolve(value);
}

function requiredSha256(value: string | undefined, code: string) {
  if (!value || !SHA256.test(value)) throw new Error(code);
  return value;
}

function normalizedOptionalSha(value: string | null | undefined) {
  if (value === null || value === undefined) return null;
  return requiredSha256(value, "BOOTSTRAP_RECOVERY_EVIDENCE_SHA256_INVALID");
}

function exactKeys(value: JsonRecord, expected: readonly string[], code: string) {
  if (Object.keys(value).sort().join("\n") !== [...expected].sort().join("\n")) throw new Error(code);
}

function pathSha256(value: string) {
  const normalized = path.resolve(value).replace(/[\\/]+$/, "");
  return sha256(Buffer.from(process.platform === "win32" ? normalized.toLowerCase() : normalized, "utf8"));
}

function sha256(value: Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as JsonRecord;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function assertNoReparseComponents(target: string) {
  const parsed = path.parse(path.resolve(target));
  let current = parsed.root;
  for (const segment of path.resolve(target).slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error("BOOTSTRAP_REPARSE_REJECTED");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
}
