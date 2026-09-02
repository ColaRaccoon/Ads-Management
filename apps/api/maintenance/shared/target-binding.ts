import {
  asIsoTimestamp,
  asRecord,
  asSafeInteger,
  asStrictString,
  assertExactKeys,
  canonicalSha256
} from "./strict-json";

const PROJECT_REF = /^[a-z]{20}$/;
const RELEASE_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const ENVIRONMENT_ID = /^[a-z][a-z0-9-]{2,62}$/;
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

export type CloudEnvironmentClass = "staging" | "production";
export type DatabaseConnectionMode = "direct" | "session_pooler";

export interface CloudTargetBinding {
  version: "cloud-target-binding/v1";
  environmentId: string;
  environmentClass: CloudEnvironmentClass;
  projectRef: string;
  supabaseOrigin: string;
  database: {
    connectionMode: DatabaseConnectionMode;
    host: string;
    port: 5432;
    name: string;
    schema: string;
    loginUser: string;
    expectedCurrentUser: string;
    requiredRole: string;
    sslMode: "verify-full";
    tlsServerName: string;
  };
  releaseGitSha: string;
  issuedAt: string;
  expiresAt: string;
}

export interface TargetConfirmation {
  projectRef: string;
  releaseGitSha: string;
  targetSha256: string;
}

export function parseCloudTargetBinding(value: unknown, now = new Date()): CloudTargetBinding {
  const input = asRecord(value, "TARGET_BINDING_OBJECT_REQUIRED");
  assertExactKeys(input, [
    "version", "environmentId", "environmentClass", "projectRef", "supabaseOrigin",
    "database", "releaseGitSha", "issuedAt", "expiresAt"
  ], "TARGET_BINDING_KEYS_INVALID");
  if (input.version !== "cloud-target-binding/v1") throw new Error("TARGET_BINDING_VERSION_INVALID");

  const environmentId = asStrictString(input.environmentId, "TARGET_ENVIRONMENT_ID_INVALID", ENVIRONMENT_ID, 63);
  if (input.environmentClass !== "staging" && input.environmentClass !== "production") {
    throw new Error("TARGET_ENVIRONMENT_CLASS_INVALID");
  }
  const projectRef = asStrictString(input.projectRef, "TARGET_PROJECT_REF_INVALID", PROJECT_REF, 20);
  const supabaseOrigin = asStrictString(input.supabaseOrigin, "TARGET_ORIGIN_INVALID", undefined, 128);
  if (supabaseOrigin !== `https://${projectRef}.supabase.co`) throw new Error("TARGET_ORIGIN_MISMATCH");

  const databaseInput = asRecord(input.database, "TARGET_DATABASE_INVALID");
  assertExactKeys(databaseInput, [
    "connectionMode", "host", "port", "name", "schema", "loginUser", "expectedCurrentUser",
    "requiredRole", "sslMode", "tlsServerName"
  ], "TARGET_DATABASE_KEYS_INVALID");
  if (databaseInput.connectionMode !== "direct" && databaseInput.connectionMode !== "session_pooler") {
    throw new Error("TARGET_DATABASE_MODE_INVALID");
  }
  const host = asStrictString(databaseInput.host, "TARGET_DATABASE_HOST_INVALID", /^[a-z0-9.-]+$/, 255);
  if (isLocalOrPrivateHost(host)) throw new Error("TARGET_DATABASE_HOST_LOCAL");
  if (databaseInput.connectionMode === "direct" && host !== `db.${projectRef}.supabase.co`) {
    throw new Error("TARGET_DATABASE_HOST_MISMATCH");
  }
  if (databaseInput.connectionMode === "session_pooler" && !/^aws-\d+-[a-z0-9-]+\.pooler\.supabase\.com$/.test(host)) {
    throw new Error("TARGET_DATABASE_POOLER_HOST_INVALID");
  }
  const port = asSafeInteger(databaseInput.port, "TARGET_DATABASE_PORT_INVALID", 5432, 5432) as 5432;
  const name = asStrictString(databaseInput.name, "TARGET_DATABASE_NAME_INVALID", IDENTIFIER, 63);
  const schema = asStrictString(databaseInput.schema, "TARGET_DATABASE_SCHEMA_INVALID", IDENTIFIER, 63);
  const principalPattern = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;
  const loginUser = asStrictString(databaseInput.loginUser, "TARGET_DATABASE_LOGIN_USER_INVALID", principalPattern, 128);
  const expectedCurrentUser = asStrictString(
    databaseInput.expectedCurrentUser,
    "TARGET_DATABASE_CURRENT_USER_INVALID",
    principalPattern,
    128
  );
  const requiredRole = asStrictString(databaseInput.requiredRole, "TARGET_DATABASE_REQUIRED_ROLE_INVALID", principalPattern, 128);
  if (databaseInput.connectionMode === "direct" && loginUser !== expectedCurrentUser) {
    throw new Error("TARGET_DATABASE_PRINCIPAL_MISMATCH");
  }
  if (databaseInput.connectionMode === "session_pooler" && loginUser !== `${expectedCurrentUser}.${projectRef}`) {
    throw new Error("TARGET_DATABASE_POOLER_PRINCIPAL_MISMATCH");
  }
  if (databaseInput.sslMode !== "verify-full" || databaseInput.tlsServerName !== host) {
    throw new Error("TARGET_DATABASE_TLS_INVALID");
  }
  const releaseGitSha = asStrictString(input.releaseGitSha, "TARGET_RELEASE_SHA_INVALID", RELEASE_SHA, 64);
  const issuedAt = asIsoTimestamp(input.issuedAt, "TARGET_ISSUED_AT_INVALID");
  const expiresAt = asIsoTimestamp(input.expiresAt, "TARGET_EXPIRES_AT_INVALID");
  if (Date.parse(issuedAt) > now.getTime() + 5 * 60_000 || Date.parse(expiresAt) <= now.getTime()) {
    throw new Error("TARGET_BINDING_EXPIRED_OR_FUTURE");
  }
  if (Date.parse(expiresAt) <= Date.parse(issuedAt) ||
      Date.parse(expiresAt) - Date.parse(issuedAt) > 24 * 60 * 60_000) {
    throw new Error("TARGET_BINDING_LIFETIME_INVALID");
  }

  return {
    version: "cloud-target-binding/v1",
    environmentId,
    environmentClass: input.environmentClass,
    projectRef,
    supabaseOrigin,
    database: {
      connectionMode: databaseInput.connectionMode,
      host,
      port,
      name,
      schema,
      loginUser,
      expectedCurrentUser,
      requiredRole,
      sslMode: "verify-full",
      tlsServerName: host
    },
    releaseGitSha,
    issuedAt,
    expiresAt
  };
}

export function targetBindingSha256(binding: CloudTargetBinding): string {
  return canonicalSha256(binding);
}

export function assertTargetConfirmation(
  binding: CloudTargetBinding,
  confirmation: TargetConfirmation
): void {
  if (confirmation.projectRef !== binding.projectRef) throw new Error("CONFIRM_PROJECT_REF_MISMATCH");
  if (confirmation.releaseGitSha !== binding.releaseGitSha) throw new Error("CONFIRM_RELEASE_SHA_MISMATCH");
  if (confirmation.targetSha256 !== targetBindingSha256(binding)) throw new Error("CONFIRM_TARGET_SHA_MISMATCH");
}

export function isLocalOrPrivateHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return normalized === "localhost" || normalized === "::1" || normalized.endsWith(".local") ||
    /^127\./.test(normalized) || /^10\./.test(normalized) || /^192\.168\./.test(normalized) ||
    /^172\.(?:1[6-9]|2\d|3[01])\./.test(normalized);
}
