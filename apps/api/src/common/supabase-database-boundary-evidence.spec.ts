import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { assertSupabaseDatabaseBoundaryEvidenceV6, roleDigest, SUPABASE_DATABASE_BOUNDARY_V6_FIELDS } from "./supabase-database-boundary-evidence";

const now = Date.parse("2026-08-27T00:00:00.000Z");
const binding = {
  projectRef: "abcdefghijklmnopqrst", connectionMode: "direct" as const,
  host: "db.abcdefghijklmnopqrst.supabase.co", databaseName: "postgres", databaseSchema: "meta_ads",
  runtimeUser: "meta_runtime", migrationUser: "meta_migration", backupUser: "meta_backup",
  restoreUser: "meta_restore", caCertificateSha256: "1".repeat(64)
};

describe("Supabase database boundary evidence v6 contract", () => {
  it("accepts the exact producer-shaped v6 contract", () => {
    expect(() => assertSupabaseDatabaseBoundaryEvidenceV6(producerEvidence(), binding, { now })).not.toThrow();
    const root = path.basename(process.cwd()).toLowerCase() === "api" ? path.resolve(process.cwd(), "../..") : process.cwd();
    const producer = readFileSync(path.join(root, "deploy/windows/Test-SupabaseDatabaseBoundary.ps1"), "utf8");
    const body = producer.match(/\$result=\[ordered\]@\{([^\r\n]+)\}/)?.[1];
    expect(body).toBeTruthy();
    const producerFields = [...body!.matchAll(/(?:^|;)([A-Za-z][A-Za-z0-9]*)=/g)].map((match) => match[1]).sort();
    expect(producerFields).toEqual([...SUPABASE_DATABASE_BOUNDARY_V6_FIELDS].sort());
  });

  it("rejects missing proof fields, stale versions, and role digest drift", () => {
    const missing = producerEvidence(); delete missing.auditAppendOnlyGuardVerified;
    expect(() => assertSupabaseDatabaseBoundaryEvidenceV6(missing, binding, { now })).toThrow("DATABASE_BOUNDARY_EVIDENCE_REJECTED");
    expect(() => assertSupabaseDatabaseBoundaryEvidenceV6({ ...producerEvidence(), version: 5 }, binding, { now })).toThrow("DATABASE_BOUNDARY_EVIDENCE_REJECTED");
    expect(() => assertSupabaseDatabaseBoundaryEvidenceV6({ ...producerEvidence(), migrationRoleDigest: "f".repeat(64) }, binding, { now })).toThrow("DATABASE_BOUNDARY_EVIDENCE_REJECTED");
    for (const field of ["runtimeDatabaseTemporaryDenied", "backupDatabaseCreateDenied", "backupDatabaseTemporaryDenied", "backupSchemaCreateDenied",
      "restoreDatabasePrivilegesAbsent", "restoreSchemaPrivilegesAbsent", "restoreTablePrivilegesAbsent",
      "restoreSequencePrivilegesAbsent", "restoreFunctionPrivilegesAbsent", "restoreTypePrivilegesAbsent",
      "restoreDefaultAclAbsent"] as const) {
      expect(() => assertSupabaseDatabaseBoundaryEvidenceV6({ ...producerEvidence(), [field]: false }, binding, { now })).toThrow("DATABASE_BOUNDARY_EVIDENCE_REJECTED");
    }
  });
});

export function producerEvidence(completedAt = "2026-08-26T23:55:00.000Z"): Record<string, unknown> {
  return {
    version: 6, result: "PASS", provider: "supabase_postgres", projectRef: binding.projectRef,
    connectionMode: binding.connectionMode, host: binding.host, port: 5432, sslMode: "verify-full",
    tlsVerified: true, hostnameVerified: true, caVerified: true, caCertificateSha256: binding.caCertificateSha256,
    psqlSha256: "2".repeat(64), executorHashesVerified: true, boundedChildProcesses: true,
    processTreeKillOnDeadline: true, maximumVerificationDurationSeconds: 600,
    maximumChildOutputBytes: 1_048_576, elapsedSeconds: 42, pgConnectTimeoutSeconds: 15,
    statementTimeoutMilliseconds: 60_000, pgStatSsl: true, tlsProtocol: "TLSv1.3",
    tlsCipher: "TLS_AES_256_GCM_SHA384", sslEnforcementVerified: true, publicRemoteEndpoint: true,
    runtimeDdlDenied: true, runtimeDatabaseTemporaryDenied: true, roleAttributesRestricted: true, boundedConnectionLimits: true,
    scramCredentialsVerified: true, runtimeObjectOwnershipDenied: true, roleMembershipsAbsent: true,
    privilegeContractVerified: true, backupDatabaseCreateDenied: true, backupDatabaseTemporaryDenied: true,
    backupSchemaCreateDenied: true, sequencePrivilegesVerified: true, functionEscalationAbsent: true,
    defaultPrivilegesVerified: true, migrationOwnershipVerified: true, migrationRoleFullDataPrivileged: true,
    migrationCredentialAdminOnly: true, migrationCredentialMaintenanceOnly: true, migrationTableProtected: true,
    crossSchemaPrivilegesAbsent: true, credentialsDistinct: true, crossRoleAuthenticationDenied: true,
    productionRestoreRoleAccessAbsent: true, restoreDatabasePrivilegesAbsent: true,
    restoreSchemaPrivilegesAbsent: true, restoreTablePrivilegesAbsent: true,
    restoreSequencePrivilegesAbsent: true, restoreFunctionPrivilegesAbsent: true,
    restoreTypePrivilegesAbsent: true, restoreDefaultAclAbsent: true, auditAppendOnlyGuardVerified: true,
    credentialInventoryDigest: "3".repeat(64), databaseName: binding.databaseName, databaseUser: binding.runtimeUser,
    databaseSchema: binding.databaseSchema, runtimeRoleDigest: roleDigest(binding.runtimeUser),
    migrationRoleDigest: roleDigest(binding.migrationUser), backupRoleDigest: roleDigest(binding.backupUser),
    restoreRoleDigest: roleDigest(binding.restoreUser), completedAt
  };
}
