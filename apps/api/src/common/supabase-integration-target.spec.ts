import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { roleDigest } from "./supabase-database-boundary-evidence";
import { supabaseIntegrationEnabled } from "./supabase-integration-target";

const names = ["RUN_DB_INTEGRATION","TEST_DATABASE_URL","SUPABASE_TEST_PROJECT_REF","SUPABASE_TEST_CONNECTION_MODE","SUPABASE_TEST_DATABASE_HOST","SUPABASE_TEST_DATABASE_NAME","SUPABASE_TEST_DATABASE_SCHEMA","SUPABASE_TEST_DATABASE_USER","CONFIRM_SUPABASE_TEST_PROJECT_REF","SUPABASE_TEST_MUTATION_APPROVED","SUPABASE_SOURCE_RUNTIME_CONFIG_PATH","SUPABASE_SOURCE_RUNTIME_CONFIG_SHA256","SUPABASE_SOURCE_BOUNDARY_EVIDENCE_PATH","SUPABASE_SOURCE_BOUNDARY_EVIDENCE_SHA256"];
const roots: string[] = [];
afterEach(() => { names.forEach((name) => delete process.env[name]); while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe("guarded Supabase integration target", () => {
  it("stays disabled without an explicit test-run flag", () => {
    expect(supabaseIntegrationEnabled("RUN_DB_INTEGRATION","TEST_DATABASE_URL")).toBe(false);
  });

  it("accepts only a confirmed isolated verify-full database and rejects the source database", () => {
    const source = sourceEvidence();
    Object.assign(process.env, {
      RUN_DB_INTEGRATION:"true",SUPABASE_TEST_PROJECT_REF:"abcdefghijklmnopqrst",
      SUPABASE_TEST_CONNECTION_MODE:"direct",SUPABASE_TEST_DATABASE_HOST:"db.abcdefghijklmnopqrst.supabase.co",SUPABASE_TEST_DATABASE_NAME:"postgres",
      SUPABASE_TEST_DATABASE_SCHEMA:"test_security_integration",SUPABASE_TEST_DATABASE_USER:"meta_test",CONFIRM_SUPABASE_TEST_PROJECT_REF:"abcdefghijklmnopqrst",SUPABASE_TEST_MUTATION_APPROVED:"true",
      TEST_DATABASE_URL:`postgresql://meta_test:synthetic@db.abcdefghijklmnopqrst.supabase.co:5432/postgres?schema=test_security_integration&sslmode=verify-full&sslrootcert=${encodeURIComponent(path.join(source.root,"ca.crt"))}`,
      SUPABASE_SOURCE_RUNTIME_CONFIG_PATH:source.runtimePath,SUPABASE_SOURCE_RUNTIME_CONFIG_SHA256:source.runtimeHash,
      SUPABASE_SOURCE_BOUNDARY_EVIDENCE_PATH:source.boundaryPath,SUPABASE_SOURCE_BOUNDARY_EVIDENCE_SHA256:source.boundaryHash
    });
    expect(supabaseIntegrationEnabled("RUN_DB_INTEGRATION","TEST_DATABASE_URL")).toBe(true);
    const targetAsSource = sourceEvidence("abcdefghijklmnopqrst","db.abcdefghijklmnopqrst.supabase.co","postgres","meta_ads");
    process.env.SUPABASE_SOURCE_RUNTIME_CONFIG_PATH=targetAsSource.runtimePath;process.env.SUPABASE_SOURCE_RUNTIME_CONFIG_SHA256=targetAsSource.runtimeHash;
    process.env.SUPABASE_SOURCE_BOUNDARY_EVIDENCE_PATH=targetAsSource.boundaryPath;process.env.SUPABASE_SOURCE_BOUNDARY_EVIDENCE_SHA256=targetAsSource.boundaryHash;
    expect(()=>supabaseIntegrationEnabled("RUN_DB_INTEGRATION","TEST_DATABASE_URL")).toThrow(/distinct/);
    const sameProjectDifferentDatabase = sourceEvidence("abcdefghijklmnopqrst","db.abcdefghijklmnopqrst.supabase.co","meta_ads_source","meta_ads");
    process.env.SUPABASE_SOURCE_RUNTIME_CONFIG_PATH=sameProjectDifferentDatabase.runtimePath;process.env.SUPABASE_SOURCE_RUNTIME_CONFIG_SHA256=sameProjectDifferentDatabase.runtimeHash;
    process.env.SUPABASE_SOURCE_BOUNDARY_EVIDENCE_PATH=sameProjectDifferentDatabase.boundaryPath;process.env.SUPABASE_SOURCE_BOUNDARY_EVIDENCE_SHA256=sameProjectDifferentDatabase.boundaryHash;
    expect(supabaseIntegrationEnabled("RUN_DB_INTEGRATION","TEST_DATABASE_URL")).toBe(true);
  });
});

function sourceEvidence(projectRef="zyxwvutsrqponmlkjihg",host=`db.${projectRef}.supabase.co`,database="postgres",schema="meta_ads") {
  const root=mkdtempSync(path.join(tmpdir(),"supabase-source-proof-"));roots.push(root);
  const runtimePath=path.join(root,"runtime.json"),boundaryPath=path.join(root,"boundary.json");
  const runtimeUser="meta_runtime",migrationUser="meta_migration",backupUser="meta_backup",restoreUser="meta_restore",caCertificateSha256="1".repeat(64);
  writeFileSync(runtimePath,JSON.stringify({deploymentMode:"local_lan",database:{provider:"supabase_postgres",projectRef,connectionMode:"direct",host,port:5432,name:database,schema,runtimeUser,migrationUser,backupUser,restoreUser,caCertificateSha256}}));
  writeFileSync(boundaryPath,JSON.stringify({
    version:6,result:"PASS",provider:"supabase_postgres",projectRef,connectionMode:"direct",host,port:5432,
    sslMode:"verify-full",tlsVerified:true,hostnameVerified:true,caVerified:true,caCertificateSha256,
    psqlSha256:"2".repeat(64),executorHashesVerified:true,boundedChildProcesses:true,
    processTreeKillOnDeadline:true,maximumVerificationDurationSeconds:600,maximumChildOutputBytes:1_048_576,
    elapsedSeconds:42,pgConnectTimeoutSeconds:15,statementTimeoutMilliseconds:60_000,
    pgStatSsl:true,tlsProtocol:"TLSv1.3",tlsCipher:"TLS_AES_256_GCM_SHA384",
    sslEnforcementVerified:true,publicRemoteEndpoint:true,runtimeDdlDenied:true,roleAttributesRestricted:true,
    boundedConnectionLimits:true,scramCredentialsVerified:true,runtimeObjectOwnershipDenied:true,roleMembershipsAbsent:true,
    privilegeContractVerified:true,backupDatabaseCreateDenied:true,backupDatabaseTemporaryDenied:true,
    backupSchemaCreateDenied:true,sequencePrivilegesVerified:true,functionEscalationAbsent:true,defaultPrivilegesVerified:true,
    migrationOwnershipVerified:true,migrationRoleFullDataPrivileged:true,migrationCredentialAdminOnly:true,
    migrationCredentialMaintenanceOnly:true,migrationTableProtected:true,crossSchemaPrivilegesAbsent:true,
    credentialsDistinct:true,crossRoleAuthenticationDenied:true,productionRestoreRoleAccessAbsent:true,
    restoreDatabasePrivilegesAbsent:true,restoreSchemaPrivilegesAbsent:true,restoreTablePrivilegesAbsent:true,
    restoreSequencePrivilegesAbsent:true,restoreFunctionPrivilegesAbsent:true,restoreTypePrivilegesAbsent:true,restoreDefaultAclAbsent:true,
    auditAppendOnlyGuardVerified:true,credentialInventoryDigest:"3".repeat(64),databaseName:database,databaseUser:runtimeUser,
    databaseSchema:schema,runtimeRoleDigest:roleDigest(runtimeUser),migrationRoleDigest:roleDigest(migrationUser),
    backupRoleDigest:roleDigest(backupUser),restoreRoleDigest:roleDigest(restoreUser),completedAt:new Date().toISOString()
  }));
  return {root,runtimePath,boundaryPath,runtimeHash:hash(runtimePath),boundaryHash:hash(boundaryPath)};
}
function hash(file:string){return createHash("sha256").update(readFileSync(file)).digest("hex");}
