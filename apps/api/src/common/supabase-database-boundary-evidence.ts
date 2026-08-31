import { createHash } from "node:crypto";

const sha256 = /^[0-9a-f]{64}$/;
export const SUPABASE_DATABASE_BOUNDARY_V6_FIELDS = [
  "version", "result", "provider", "projectRef", "connectionMode", "host", "port", "sslMode",
  "tlsVerified", "hostnameVerified", "caVerified", "caCertificateSha256", "psqlSha256",
  "executorHashesVerified", "boundedChildProcesses", "processTreeKillOnDeadline",
  "maximumVerificationDurationSeconds", "maximumChildOutputBytes", "elapsedSeconds",
  "pgConnectTimeoutSeconds", "statementTimeoutMilliseconds", "pgStatSsl", "tlsProtocol", "tlsCipher", "sslEnforcementVerified",
  "publicRemoteEndpoint", "runtimeDdlDenied", "roleAttributesRestricted", "boundedConnectionLimits",
  "scramCredentialsVerified", "runtimeObjectOwnershipDenied", "roleMembershipsAbsent",
  "privilegeContractVerified", "backupDatabaseCreateDenied", "backupDatabaseTemporaryDenied",
  "backupSchemaCreateDenied", "sequencePrivilegesVerified", "functionEscalationAbsent",
  "defaultPrivilegesVerified", "migrationOwnershipVerified", "migrationRoleFullDataPrivileged",
  "migrationCredentialAdminOnly", "migrationCredentialMaintenanceOnly", "migrationTableProtected",
  "crossSchemaPrivilegesAbsent", "credentialsDistinct", "crossRoleAuthenticationDenied",
  "productionRestoreRoleAccessAbsent", "restoreDatabasePrivilegesAbsent", "restoreSchemaPrivilegesAbsent",
  "restoreTablePrivilegesAbsent", "restoreSequencePrivilegesAbsent", "restoreFunctionPrivilegesAbsent",
  "restoreTypePrivilegesAbsent", "restoreDefaultAclAbsent", "auditAppendOnlyGuardVerified", "credentialInventoryDigest",
  "databaseName", "databaseUser", "databaseSchema", "runtimeRoleDigest", "migrationRoleDigest",
  "backupRoleDigest", "restoreRoleDigest", "completedAt"
] as const;
const trueFields = [
  "tlsVerified", "hostnameVerified", "caVerified", "executorHashesVerified", "boundedChildProcesses",
  "processTreeKillOnDeadline", "pgStatSsl",
  "sslEnforcementVerified", "publicRemoteEndpoint", "runtimeDdlDenied", "roleAttributesRestricted",
  "boundedConnectionLimits", "scramCredentialsVerified", "runtimeObjectOwnershipDenied",
  "roleMembershipsAbsent", "privilegeContractVerified", "backupDatabaseCreateDenied",
  "backupDatabaseTemporaryDenied", "backupSchemaCreateDenied", "sequencePrivilegesVerified",
  "functionEscalationAbsent", "defaultPrivilegesVerified", "migrationOwnershipVerified",
  "migrationRoleFullDataPrivileged", "migrationCredentialAdminOnly", "migrationCredentialMaintenanceOnly",
  "migrationTableProtected", "crossSchemaPrivilegesAbsent", "credentialsDistinct",
  "crossRoleAuthenticationDenied", "productionRestoreRoleAccessAbsent", "restoreDatabasePrivilegesAbsent",
  "restoreSchemaPrivilegesAbsent", "restoreTablePrivilegesAbsent", "restoreSequencePrivilegesAbsent",
  "restoreFunctionPrivilegesAbsent", "restoreTypePrivilegesAbsent", "restoreDefaultAclAbsent",
  "auditAppendOnlyGuardVerified"
] as const;
const digestFields = [
  "caCertificateSha256", "psqlSha256", "credentialInventoryDigest", "runtimeRoleDigest",
  "migrationRoleDigest", "backupRoleDigest", "restoreRoleDigest"
] as const;

export type SupabaseBoundaryBinding = {
  projectRef: string;
  connectionMode: "direct" | "session_pooler";
  host: string;
  databaseName: string;
  databaseSchema: string;
  runtimeUser: string;
  caCertificateSha256?: string;
  migrationUser?: string;
  backupUser?: string;
  restoreUser?: string;
};

export function assertSupabaseDatabaseBoundaryEvidenceV6(
  value: unknown,
  binding: SupabaseBoundaryBinding,
  options: { now?: number; maximumAgeMs?: number } = {}
) {
  const identifiers = [binding.databaseName, binding.databaseSchema, binding.runtimeUser,
    binding.migrationUser, binding.backupUser, binding.restoreUser].filter((item): item is string => item !== undefined);
  if (!/^[a-z]{20}$/.test(binding.projectRef) ||
      (binding.connectionMode === "direct" ? binding.host !== `db.${binding.projectRef}.supabase.co` : !/^[a-z0-9-]+\.pooler\.supabase\.com$/.test(binding.host)) ||
      !identifiers.every((item) => /^[a-z][a-z0-9_]{0,62}$/.test(item)) ||
      (binding.caCertificateSha256 !== undefined && !sha256.test(binding.caCertificateSha256)) ||
      (identifiers.length === 6 && new Set(identifiers.slice(2)).size !== 4)) reject();
  if (!value || typeof value !== "object" || Array.isArray(value)) reject();
  const evidence = value as Record<string, unknown>;
  if (Object.keys(evidence).sort().join("|") !== [...SUPABASE_DATABASE_BOUNDARY_V6_FIELDS].sort().join("|")) reject();
  if (evidence.version !== 6 || evidence.result !== "PASS" || evidence.provider !== "supabase_postgres" ||
      evidence.projectRef !== binding.projectRef || evidence.connectionMode !== binding.connectionMode ||
      evidence.host !== binding.host || evidence.port !== 5432 || evidence.databaseName !== binding.databaseName ||
      evidence.databaseSchema !== binding.databaseSchema || evidence.databaseUser !== binding.runtimeUser ||
      evidence.sslMode !== "verify-full" || !trueFields.every((field) => evidence[field] === true) ||
      !Number.isInteger(evidence.maximumVerificationDurationSeconds) ||
      (evidence.maximumVerificationDurationSeconds as number) < 60 ||
      (evidence.maximumVerificationDurationSeconds as number) > 1_800 ||
      !Number.isInteger(evidence.maximumChildOutputBytes) ||
      (evidence.maximumChildOutputBytes as number) < 1_024 ||
      (evidence.maximumChildOutputBytes as number) > 1_048_576 ||
      !Number.isInteger(evidence.elapsedSeconds) || (evidence.elapsedSeconds as number) < 0 ||
      (evidence.elapsedSeconds as number) > (evidence.maximumVerificationDurationSeconds as number) ||
      evidence.pgConnectTimeoutSeconds !== 15 || evidence.statementTimeoutMilliseconds !== 60_000 ||
      !digestFields.every((field) => typeof evidence[field] === "string" && sha256.test(evidence[field])) ||
      !new Set(["TLSv1.2", "TLSv1.3"]).has(String(evidence.tlsProtocol)) ||
      typeof evidence.tlsCipher !== "string" || evidence.tlsCipher.length === 0 || evidence.tlsCipher.length > 256 ||
      evidence.runtimeRoleDigest !== roleDigest(binding.runtimeUser) ||
      (binding.caCertificateSha256 !== undefined && evidence.caCertificateSha256 !== binding.caCertificateSha256) ||
      (binding.migrationUser !== undefined && evidence.migrationRoleDigest !== roleDigest(binding.migrationUser)) ||
      (binding.backupUser !== undefined && evidence.backupRoleDigest !== roleDigest(binding.backupUser)) ||
      (binding.restoreUser !== undefined && evidence.restoreRoleDigest !== roleDigest(binding.restoreUser))) reject();
  const completedAt = Date.parse(String(evidence.completedAt ?? ""));
  const now = options.now ?? Date.now();
  const maximumAgeMs = options.maximumAgeMs ?? 24 * 3600_000;
  if (!Number.isFinite(completedAt) || completedAt > now + 5 * 60_000 || completedAt < now - maximumAgeMs) reject();
}

export function roleDigest(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function reject(): never {
  throw new Error("DATABASE_BOUNDARY_EVIDENCE_REJECTED");
}
