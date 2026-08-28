import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.basename(process.cwd()).toLowerCase() === "api" ? path.resolve(process.cwd(), "../..") : process.cwd();
const file = (relative: string) => readFile(path.join(root, relative), "utf8");
const extractStorageReferenceSql = (source: string) => {
  const match = source.match(/function StorageReferenceSql \{ return @"\r?\n([\s\S]*?)\r?\n"@ \}/);
  if (!match) throw new Error("STORAGE_REFERENCE_SQL_NOT_FOUND");
  return match[1];
};
const normalizeSql = (sql: string) => sql.replace(/\s+/g, "");
const lowerSha256 = /^[0-9a-f]{64}$/;
const selectMetaPayloadHash = (row: { fileHashSha256: string; columnSchema: Record<string, unknown> }) => {
  const hasOriginalHash = Object.prototype.hasOwnProperty.call(row.columnSchema, "originalFileHashSha256");
  const originalHash = row.columnSchema.originalFileHashSha256;
  const selected = originalHash == null ? row.fileHashSha256 : originalHash;
  if (
    (hasOriginalHash && (typeof originalHash !== "string" || !lowerSha256.test(originalHash))) ||
    typeof selected !== "string" ||
    !lowerSha256.test(selected)
  ) throw new Error("INVALID_META_PAYLOAD_HASH");
  return selected;
};

describe("local native deployment artifacts", () => {
  it("backs up file payload bytes and restores without reading the production source root", async () => {
    const [backup, restore] = await Promise.all([
      file("deploy/windows/Backup-Local.ps1"), file("deploy/windows/Restore-Verify.ps1")
    ]);
    expect(backup).toContain("storage-payload");
    expect(backup).toContain("Copy-DeadlineBoundFile -Source $source.FullName -Destination $target");
    expect(backup).toContain("HMAC-SHA256");
    expect(backup).toContain("[IO.Directory]::Move([IO.Path]::GetFullPath($staging),[IO.Path]::GetFullPath($final))");
    expect(restore).toContain("HmacFile -KeyFile $BackupIntegrityKeyFile");
    expect(restore).toContain("BACKUP_SIGNATURE_MISMATCH");
    expect(restore).toContain("BACKUP_PAYLOAD_HASH_MISMATCH");
    expect(restore).toContain("RESTORED_BUSINESS_KPI_MISMATCH");
    expect(restore).toContain("RESTORED_APPLIED_MIGRATIONS_MISMATCH");
    expect(restore).not.toContain("BusinessKpiEvidencePath");
    expect(restore).toContain("STORAGE_KEY_ESCAPES_ROOT");
    expect(restore).toContain("Copy-BoundedFile");
    expect(restore).not.toContain("$SourceDataRoot");
    expect(restore.indexOf("BACKUP_SIGNATURE_MISMATCH")).toBeLessThan(restore.indexOf("Invoke-BoundedProcess $PgRestorePath"));
    expect(restore).toContain("$script:RestoreDeadline=$started.AddHours(4)");
    expect(restore).toContain("$Process.Kill($true)");
    expect(restore).toContain("function Invoke-CleanupDb");
    expect(restore).toContain("RESTORE_DATABASE_NOT_PRISTINE_AFTER_FAILURE");
    expect(restore.indexOf("$restoreSchemaCreated=$true")).toBeLessThan(restore.indexOf("'PG_RESTORE_FAILED'"));
  });

  it("uses the original Meta payload hash for duplicate versions in backup and restore", async () => {
    const [backup, restore] = await Promise.all([
      file("deploy/windows/Backup-Local.ps1"), file("deploy/windows/Restore-Verify.ps1")
    ]);
    const backupSql = extractStorageReferenceSql(backup);
    const restoreSql = extractStorageReferenceSql(restore);
    const originalHashExpression = "COALESCE(column_schema->>'originalFileHashSha256', file_hash_sha256::text) AS sha256";
    const exactHashValidation = "sha256 !~ '^[0-9a-f]{64}$'";
    const jsonTypeValidation = "jsonb_typeof(column_schema->'originalFileHashSha256') IS DISTINCT FROM 'string'";

    expect(normalizeSql(backupSql)).toBe(normalizeSql(restoreSql));
    for (const sql of [backupSql, restoreSql]) {
      expect(sql).toContain(originalHashExpression);
      expect(sql).toContain(exactHashValidation);
      expect(sql).toContain(jsonTypeValidation);
      expect(sql).toContain("column_schema->>'originalFileHashSha256' !~ '^[0-9a-f]{64}$'");
    }

    const payload = Buffer.from("meta duplicate payload fixture", "utf8");
    const actualPayloadHash = createHash("sha256").update(payload).digest("hex");
    for (const level of ["ADSET", "AD"] as const) {
      for (const duplicatePolicy of ["NEW_VERSION", "OVERWRITE"] as const) {
        const syntheticVersionHash = createHash("sha256")
          .update(`${actualPayloadHash}:${level}:${duplicatePolicy}:fixture-version`)
          .digest("hex");
        expect(syntheticVersionHash).not.toBe(actualPayloadHash);
        const row = {
          fileHashSha256: syntheticVersionHash,
          columnSchema: { level, duplicatePolicy, originalFileHashSha256: actualPayloadHash }
        };
        const backupSelectedHash = selectMetaPayloadHash(row);
        const restoreSelectedHash = selectMetaPayloadHash(row);
        expect(backupSelectedHash).toBe(actualPayloadHash);
        expect(restoreSelectedHash).toBe(actualPayloadHash);
      }
    }

    expect(selectMetaPayloadHash({ fileHashSha256: actualPayloadHash, columnSchema: {} })).toBe(actualPayloadHash);
    for (const invalid of [actualPayloadHash.toUpperCase(), actualPayloadHash.slice(1), null, 123]) {
      expect(() => selectMetaPayloadHash({
        fileHashSha256: actualPayloadHash,
        columnSchema: { originalFileHashSha256: invalid }
      })).toThrow("INVALID_META_PAYLOAD_HASH");
    }
  });

  it("keeps every Windows host mutation behind Plan plus explicit approval", async () => {
    const approvalContract = await file("deploy/windows/approval-plan.ps1");
    for (const field of ["scriptSha256", "approvalContractSha256", "exactParameters", "planSha256", "approvalNonce", "approvalIssuedAt", "approvalExpiresAt", "approvalInstanceId", "approvalLedgerPath", "Use-ApprovalInstance", "APPROVAL_PLAN_REPLAY_REJECTED"]) {
      expect(approvalContract).toContain(field);
    }
    expect(approvalContract).toContain("APPROVED_PLAN_SHA256_REQUIRED");
    expect(approvalContract).toContain("APPROVED_PLAN_MISMATCH");
    const exactPlanScripts = [
      "Manage-Acl.ps1", "Manage-ClientTrust.ps1", "Manage-Firewall.ps1", "Manage-Service.ps1",
      "Switch-LocalRelease.ps1", "New-InternalCa.ps1", "Renew-ServerCertificate.ps1",
      "Activate-ServerCertificate.ps1", "Stage-LegacyLocalStorage.ps1", "Manage-LegacyQuiesce.ps1",
      "Manage-SupabaseMigration.ps1", "Manage-SupabaseRollbackRestore.ps1", "Manage-BackupSchedule.ps1", "Manage-PrincipalRights.ps1",
      "Restore-Verify.ps1", "Manage-Maintenance.ps1", "Manage-RecoveryKit.ps1",
      "Merge-ClientTrustEvidence.ps1", "Test-BackupTarget.ps1", "Test-SupabaseDatabaseBoundary.ps1",
      "New-LegacyRunningBaseline.ps1", "Test-InitialCutoverCompatibility.ps1", "Backup-Local.ps1", "Publish-BackupReceipt.ps1",
      "Test-ReleaseCompatibility.ps1", "Test-RebootReadiness.ps1", "Publish-RestoreEvidence.ps1"
    ];
    for (const name of exactPlanScripts) {
      const source = await file(`deploy/windows/${name}`);
      expect(source, name).toContain("Plan");
      expect(source, name).toContain("approval-plan.ps1");
      expect(source, name).toContain("PlannedAction");
      expect(source, name).toContain("ApprovedPlanSha256");
      expect(source, name).toContain("New-ApprovalPlan");
      expect(source, name).toContain("Assert-ApprovedPlan");
    }
    for (const name of exactPlanScripts) {
      const source = await file(`deploy/windows/${name}`);
      expect(source, name).toContain("ApprovalNonce");expect(source, name).toContain("ApprovalLedgerPath");
    }
  });

  it("rejects reusing an approved exact plan when any bound argument drifts", () => {
    if (process.platform !== "win32") return;
    const script = path.join(root, "deploy/windows/Manage-Firewall.ps1");
    const planned = spawnSync("pwsh.exe", ["-NoProfile", "-File", script, "-Action", "Plan", "-PlannedAction", "Rollback", "-RuleName", "MetaAdsPlanFixtureA"], { cwd: root, encoding: "utf8" });
    expect(planned.status, planned.stderr).toBe(0);
    const plan = JSON.parse(planned.stdout) as { planSha256: string; approvalNonce: string; approvalIssuedAt: string; approvalExpiresAt: string; approvalInstanceId: string; approvalLedgerPath: string };
    expect(plan.planSha256).toMatch(lowerSha256);
    const approvedOnly = spawnSync("pwsh.exe", ["-NoProfile", "-File", script, "-Action", "Rollback", "-RuleName", "MetaAdsPlanFixtureA", "-Approved"], { cwd: root, encoding: "utf8" });
    expect(approvedOnly.status).not.toBe(0);
    expect(`${approvedOnly.stdout}\n${approvedOnly.stderr}`).toContain("APPROVAL_INSTANCE_FIELDS_REQUIRED");
    const drifted = spawnSync("pwsh.exe", ["-NoProfile", "-File", script, "-Action", "Rollback", "-RuleName", "MetaAdsPlanFixtureB", "-Approved", "-ApprovedPlanSha256", plan.planSha256, "-ApprovalNonce", plan.approvalNonce, "-ApprovalIssuedAt", plan.approvalIssuedAt, "-ApprovalExpiresAt", plan.approvalExpiresAt, "-ApprovalInstanceId", plan.approvalInstanceId, "-ApprovalLedgerPath", plan.approvalLedgerPath], { cwd: root, encoding: "utf8" });
    expect(drifted.status).not.toBe(0);
    expect(`${drifted.stdout}\n${drifted.stderr}`).toContain("APPROVED_PLAN_MISMATCH");
  }, 20_000);

  it("forbids ambiguous return/throw tokens and exercises return plus one-time approval runtime on PS7 and Windows PowerShell 5.1",async()=>{
    const windowsRoot=path.join(root,"deploy/windows");const {readdir}=await import("node:fs/promises");const names=(await readdir(windowsRoot)).filter((name)=>name.endsWith(".ps1"));
    for(const name of new Set(names)){const source=await file(`deploy/windows/${name}`);expect(source,name).not.toMatch(/\b(?:return|throw)(?=[$@\['"])/)}
    if(process.platform!=="win32")return;const contract=path.join(windowsRoot,"approval-plan.runtime.test.ps1");
    for(const shell of ["pwsh.exe","powershell.exe"]){const result=spawnSync(shell,["-NoProfile","-ExecutionPolicy","Bypass","-File",contract],{cwd:root,encoding:"utf8"});expect(result.status,`${shell}: ${result.stderr}`).toBe(0);expect(JSON.parse(result.stdout).result).toBe("PASS")}
  },30_000);

  it("hash-pins certificate and rollback executors and has an honest first-cutover path",async()=>{
    const[create,renew,activate,switcher,baseline,stage,quiesce,backup,restore,initial,migration,rollbackRestore]=await Promise.all([file("deploy/windows/New-InternalCa.ps1"),file("deploy/windows/Renew-ServerCertificate.ps1"),file("deploy/windows/Activate-ServerCertificate.ps1"),file("deploy/windows/Switch-LocalRelease.ps1"),file("deploy/windows/New-LegacyRunningBaseline.ps1"),file("deploy/windows/Stage-LegacyLocalStorage.ps1"),file("deploy/windows/Manage-LegacyQuiesce.ps1"),file("deploy/windows/Backup-Local.ps1"),file("deploy/windows/Restore-Verify.ps1"),file("deploy/windows/Test-InitialCutoverCompatibility.ps1"),file("deploy/windows/Manage-SupabaseMigration.ps1"),file("deploy/windows/Manage-SupabaseRollbackRestore.ps1")]);
    for(const source of[create,renew,activate]){expect(source).toContain("ExpectedNodeSha256");expect(source).toContain("SHARED_RUNTIME")}
    expect(switcher).toContain("ROLLBACK_EXECUTOR_OUTSIDE_SHARED_RUNTIME");expect(baseline).toContain("repository_local_ntfs");expect(baseline).toContain("localReleaseManifestApplicable=$false");expect(baseline).toContain("CurrentDirectory");expect(baseline).toContain("launchIdentityMatchesProtectedRestartSpec=$true");expect(stage).toContain("sourceDestinationHashesVerified");expect(stage).toContain("cloudStorageCalled=$false");expect(quiesce).toContain("attestationType='legacy-quiesce'");expect(quiesce).toContain("restartCanonicalDigest");expect(quiesce).toContain("LegacyBusinessHealthSmokeVerified=$true");expect(quiesce).toContain("DatabaseRollbackPublicKeyPath");expect(backup).toContain("storage-reference-conversion.sql");expect(backup).toContain("storageReferenceZeroVerified");expect(restore).toContain("LEGACY_BASELINE");expect(restore).toContain("Invoke-TargetLegacyDataProjectionSmoke");expect(restore).toContain("actualLegacyCodeExecuted=($PreviousReleaseKind-eq'LOCAL_RELEASE')");expect(initial).toContain("QuiesceReceiptPublicKeyPath");expect(initial).toContain("RestoreReceiptPublicKeyPath");expect(initial).toContain("BackupReceiptPublicKeyPath");expect(initial).toContain("legacyLocalRoleMatrixNotClaimed");expect(initial).toContain("SIGNED_DATABASE_RESTORE_THEN_EXACT_LEGACY_RESTART");expect(initial).toContain("rollbackCodeCompatible=$false");expect(migration).toContain("MIGRATION_LEGACY_NOT_QUIESCED");expect(migration).toContain("QuiesceReceiptPublicKeyPath");expect(migration).toContain("InvokeConversion");for(const token of ["legacy-database-rollback","productionDatabaseRestored=$true","maintenanceVerified=$true","drainVerified=$true","businessKpiVerified=$true","storageHashVerified=$true","processTreeKillOnDeadline=$true","Assert-ApprovedPlan"]){expect(rollbackRestore).toContain(token)}
  });

  it("binds client trust evidence to an enabled local interface and its exact approved /32 plan",async()=>{
    const [client,merge,runtime,activate]=await Promise.all([
      file("deploy/windows/Manage-ClientTrust.ps1"),file("deploy/windows/Merge-ClientTrustEvidence.ps1"),
      file("deploy/local/runtime-config.mjs"),file("deploy/windows/Activate-ServerCertificate.ps1")
    ]);
    expect(client).toContain("Get-NetIPInterface");expect(client).toContain("AddressState");expect(client).toContain("ConnectionState");
    expect(client).toContain("clientIpv4Cidr=$verifiedClientCidr");expect(client).toContain("clientAddressOwnershipVerified=$true");expect(client).toContain("verificationPlanSha256=[string]$approvedClientTrustPlan.planSha256");
    expect(merge).toContain("clientIpv4Cidr-cne\"$($evidence.clientIpv4Address)/32\"");expect(merge).toContain("verificationPlanSetDigest");expect(merge).toContain("version=4");
    expect(runtime).toContain("evidence.version === 4");expect(runtime).toContain("evidence.clientAddressOwnershipVerified === true");
    expect(activate).toContain("trustValue.version-ne4");expect(activate).toContain("trustValue.verificationPlanSetDigest-notmatch");
  });

  it("bounds every migration child and leaves a fail-closed maintenance journal",async()=>{
    const migration=await file("deploy/windows/Manage-SupabaseMigration.ps1");
    expect(migration).toContain("[Diagnostics.ProcessStartInfo]::new()");expect(migration).toContain("BaseStream.ReadAsync");expect(migration).toContain("$Process.Kill($true)");
    expect(migration).toContain("PGCONNECT_TIMEOUT");expect(migration).toContain("lock_timeout=");expect(migration).toContain("statement_timeout=");expect(migration).toContain("idle_in_transaction_session_timeout=");
    expect(migration).toContain("MaximumMaintenanceDurationSeconds");expect(migration).toContain("MaximumChildOutputBytes");expect(migration).toContain("MaintenanceStopwatch");expect(migration).toContain("FAILED_MAINTENANCE_REQUIRED");expect(migration).toContain("maintenanceMustRemainEnabled=$true");
    expect(migration).not.toContain("&$node");expect(migration).not.toContain("&$PsqlPath");expect(migration).not.toContain("Start-Process");
  });

  it("hash-pins every secret or evidence-bearing child executable and binds executor fingerprints downstream",async()=>{
    const [database,backup,schedule,recovery,publish,compatibility,restore,runtime]=await Promise.all([
      file("deploy/windows/Test-SupabaseDatabaseBoundary.ps1"),file("deploy/windows/Backup-Local.ps1"),file("deploy/windows/Manage-BackupSchedule.ps1"),file("deploy/windows/Manage-RecoveryKit.ps1"),
      file("deploy/windows/Publish-RestoreEvidence.ps1"),file("deploy/windows/Test-ReleaseCompatibility.ps1"),file("deploy/windows/Restore-Verify.ps1"),file("deploy/local/runtime-config.mjs")
    ]);
    expect(database).toContain("ExpectedPsqlSha256");expect(database).toContain("Assert-PsqlPinned");expect(database).toContain("classRoots.SHARED_RUNTIME");expect(database).toContain("[Diagnostics.ProcessStartInfo]::new()");expect(database).toContain("BaseStream.ReadAsync");expect(database).toContain("$Process.Kill($true)");expect(database).toContain("PGCONNECT_TIMEOUT");expect(database).not.toContain("&$PsqlPath");
    for(const source of[backup,schedule]){expect(source).toContain("ExpectedNodeSha256");expect(source).toContain("ExpectedPsqlSha256");expect(source).toContain("ExpectedPgDumpSha256");expect(source).toContain("executorSetDigest");expect(source).toContain("classRoots.SHARED_RUNTIME")}
    for(const source of[recovery,publish,compatibility,restore]){expect(source).toContain("ExpectedNodeSha256");expect(source).toContain("classRoots.SHARED_RUNTIME")}
    expect(restore).toContain("ExpectedPgRestoreSha256");expect(restore).toContain("ExpectedPsqlSha256");expect(restore).toContain("restoreExecutorSetDigest");expect(restore).toContain("UNPINNED_RESTORE_EXECUTABLE_REJECTED");
    expect(schedule).toContain("'-ExpectedNodeSha256',$ExpectedNodeSha256");expect(schedule).toContain("'-ExpectedPsqlSha256',$ExpectedPsqlSha256");expect(schedule).toContain("'-ExpectedPgDumpSha256',$ExpectedPgDumpSha256");expect(schedule).toContain("Invoke-ScheduleBounded");expect(schedule).toContain("BaseStream.ReadAsync");expect(schedule).toContain("$Process.Kill($true)");expect(schedule).not.toContain("&$NodePath");
    expect(runtime).toContain("evidence.executorSetDigest === sha256Tuple");expect(runtime).toContain("evidence.restoreExecutorSetDigest === sha256Tuple");expect(runtime).toContain("evidence.nodeSha256 === scheduleEvidence?.nodeSha256");
  });

  it("supports source-independent authenticated disaster extraction and an enabled plan-bound daily trigger",async()=>{
    const [tool,recovery,recoveryTree,schedule,reboot,runtime]=await Promise.all([
      file("deploy/local/recovery-kit.mjs"),file("deploy/windows/Manage-RecoveryKit.ps1"),file("deploy/windows/recovery-process-tree.ps1"),file("deploy/windows/Manage-BackupSchedule.ps1"),file("deploy/windows/Test-RebootReadiness.ps1"),file("deploy/local/runtime-config.mjs")
    ]);
    expect(tool).toContain("manifestSha256");expect(tool).toContain("files: payload.files.map");
    expect(recovery).toContain("DisasterRecovery");expect(recovery).toContain("RECOVERY_DISASTER_SCRATCH_NOT_EMPTY");expect(recovery).toContain("EscrowWorksheetPath");expect(recovery).toContain("ExpectedEscrowWorksheetSha256");expect(recovery).toContain("BaseStream.ReadAsync");expect(recovery).toContain("Stop-VerifiedRecoveryProcessTree");expect(recovery).toContain("version=5");expect(recovery).not.toContain("version=4");expect(recovery).toContain("sourcePathsDisclosed=$false");expect(runtime).toContain("disasterRecoveryEvidencePath");expect(runtime).toContain("currentRecoveryVerified && disasterRecoveryVerified");
    expect(recoveryTree).toContain("$Process.Kill($true)");expect(recoveryTree).toContain("WaitForExit");expect(recoveryTree).toContain("RECOVERY_KIT_TOOL_DESCENDANT_EXIT_UNCONFIRMED");
    if(process.platform==="win32"){const processTreeTest=spawnSync("pwsh.exe",["-NoProfile","-ExecutionPolicy","Bypass","-File",path.join(root,"deploy/windows/recovery-process-tree.runtime.test.ps1")],{cwd:root,encoding:"utf8",timeout:20_000});expect(processTreeTest.status,processTreeTest.stderr).toBe(0);expect(JSON.parse(processTreeTest.stdout).stubbornDescendantTerminated).toBe(true)}
    expect(schedule).toContain("$task.Triggers[0].Enabled -eq $true");expect(schedule).toContain("dailyTriggerEnabled=$true");expect(schedule).toContain("recurringInvocationPlanBound=$true");expect(schedule).toContain("runtimeConfigSha256=$ExpectedRuntimeConfigSha256");
    expect(reboot).toContain("not[bool]$task.Triggers[0].Enabled");expect(reboot).toContain("backupDailyTriggerEnabled");expect(reboot).toContain("runtimeConfigSha256=(FileHash $configPath)");
    expect(runtime).toContain("evidence.dailyTriggerEnabled === true");
  },20_000);

  it("preserves the live schema behind a durable rollback journal and rejects local NAS aliases",async()=>{
    const [rollback,target,nas]=await Promise.all([file("deploy/windows/Manage-SupabaseRollbackRestore.ps1"),file("deploy/windows/Test-BackupTarget.ps1"),file("deploy/windows/nas-identity.ps1")]);
    for(const token of["state='INTENT'","PRESERVED_ORIGINAL_RESTORE_IN_PROGRESS","FAILED_MAINTENANCE_REQUIRED","COMPLETE_MAINTENANCE_REQUIRED","ALTER SCHEMA $quotedSchema RENAME TO $quotedPreserved","ROLLBACK_AUTOMATIC_PRESERVED_SCHEMA_RECOVERY","ROLLBACK_FAILURE_SCHEMA_STATE_RECONCILE","freshSchemaStateReconciled","LegacyQuiesceEvidencePath","QuiesceReceiptPublicKeyPath","ROLLBACK_QUIESCE_SIGNATURE_VERIFY","legacyRestartCanonicalDigest","allReadsAndHashesDeadlineBound=$true","edgeProcessStartedAt","edgeIdentityDigest","drainCompletedAt","$Process.Kill($true)","WaitForExit"]){expect(rollback).toContain(token)}
    expect(target).toContain("nasServerIdentitySha256");expect(target).toContain("nasResolvedAddressCount");expect(target).toContain("nasLocalAliasRejected");expect(target).toContain("NAS_REMOTE_IDENTITY_DRIFT");expect(nas).toContain("NAS_SERVER_RESOLVES_TO_CURRENT_HOST");expect(nas).toContain("Get-NetIPAddress");expect(nas).toContain("GetHostAddresses");
  });

  it("binds backup authority and keeps receipt signing outside the backup principal",async()=>{
    const [backup,schedule,acl,publisher,semantic,generic,runtime,recovery]=await Promise.all([
      file("deploy/windows/Backup-Local.ps1"),file("deploy/windows/Manage-BackupSchedule.ps1"),file("deploy/windows/Manage-Acl.ps1"),file("deploy/windows/Publish-BackupReceipt.ps1"),file("deploy/local/sign-backup-receipt.mjs"),file("deploy/local/sign-attestation.mjs"),file("deploy/local/runtime-config.mjs"),file("deploy/windows/Manage-RecoveryKit.ps1")
    ]);
    expect(backup).not.toContain("if (-not $Approved)");expect(backup).toContain("New-BackupApprovalPlan");expect(backup).toContain("Assert-ScheduledAuthorization");expect(backup).toContain("ExpectedRuntimeConfigSha256");expect(backup).toContain("ExpectedBackupTargetEvidenceSha256");expect(backup).toContain("ExpectedBackupTargetFingerprint");expect(backup).toContain("ExpectedBackupRoot");
    expect(schedule).not.toContain("'-Approved'");expect(schedule).not.toContain("BackupReceiptPrivateKeyPath");expect(schedule).toContain("ExpectedScheduledAuthorizationSha256");expect(schedule).toContain("scheduledAuthorizationBound=$true");expect(schedule).toContain("scheduledAuthorizationVersion=2");expect(schedule).toContain("ExpectedBackupReceiptPrivateKeySha256");
    expect(backup).not.toContain("BackupReceiptPrivateKeyPath");expect(backup).not.toContain("ATTESTATION_SIGNER_HASH_MISMATCH");expect(backup).toContain("COMPLETE_PENDING_SIGNER");
    expect(acl).toContain("SignerAccount");expect(acl).toContain("SIGNER_ONLY");expect(acl).toContain("SIGNER_STATE");expect(acl).toContain("signerSid=$script:SignerSid");expect(recovery).toContain("'backup-receipt-private-key'='SIGNER_ONLY'");
    for(const token of ["backup-signer-authorization","Assert-ApprovedPlan","SIGNER_PUBLISH_MUST_NOT_USE_ADMIN_LEDGER","SignerReplayLedgerRoot","CreateNew","ExpectedReceiptRequestSha256","BACKUP_RECEIPT_REQUEST_CHANGED_BEFORE_PUBLISH","ExpectedPgPassSha256","ExpectedBackupIntegrityKeySha256","ExpectedBackupReceiptPrivateKeySha256","classRoots.SIGNER_ONLY","classRoots.SIGNER_STATE","BACKUP_RECEIPT_SIGNER_IDENTITY_REJECTED"]){expect(publisher).toContain(token)}
    for(const token of ["requestKeys","manifestKeys","exactObject","BACKUP_MANIFEST_HASH_MISMATCH","BACKUP_DUMP_MISMATCH","STORAGE_PAYLOAD_SET_MISMATCH","BACKUP_HMAC_INVALID","LEGACY_STORAGE_CONVERSION_HASH_MISMATCH","artifactVerificationDigest","signerIndependentArtifactVerification","BACKUP_RECEIPT_KEY_DOMAIN_REUSE_REJECTED"]){expect(semantic).toContain(token)}
    expect(generic).not.toContain('"backup-latest",');expect(runtime).toContain("evidence.signerIndependentArtifactVerification === true");expect(runtime).toContain("evidence.artifactVerificationDigest");
  });

  it("bounds manual and scheduled backups by one four-hour deadline and signed size caps",async()=>{
    const [backup,schedule,runtime,restore]=await Promise.all([
      file("deploy/windows/Backup-Local.ps1"),file("deploy/windows/Manage-BackupSchedule.ps1"),file("deploy/local/runtime-config.mjs"),file("deploy/windows/Restore-Verify.ps1")
    ]);
    expect(backup).toContain("[ValidateSet(14400)][int]$MaximumBackupDurationSeconds=14400");
    expect(backup).toContain("$script:BackupDeadline=$started.AddSeconds($MaximumBackupDurationSeconds)");
    expect(backup.lastIndexOf("$script:BackupDeadline=$started.AddSeconds($MaximumBackupDurationSeconds)")).toBeLessThan(backup.indexOf("if($AuthorizationMode-eq'OneTime')"));
    expect(backup).toContain("[Diagnostics.ProcessStartInfo]::new()");
    expect(backup).toContain("$Process.Kill($true)");
    expect(backup).not.toContain("& $PgDumpPath");
    expect(backup).not.toContain("Start-Process -FilePath $PsqlPath");
    expect(backup).toContain("SELECT pg_database_size(current_database())");
    expect(backup).toContain("$sourceTotalBytes+$MaximumDatabaseDumpBytes+$script:BackupSafetyMarginBytes");
    expect(backup).toContain("$MaximumFileBytes");
    expect(backup).toContain("DATABASE_DUMP_FINAL_SIZE_INVALID");
    expect(backup).toContain("SNAPSHOT_TEMPORARY_CLEANUP_FAILED");
    expect(backup).toContain("BACKUP_INCOMPLETE_CLEANUP_FAILED");
    expect(schedule).toContain("'-MaximumDatabaseDumpBytes',([string]$MaximumDatabaseDumpBytes)");
    expect(schedule).toContain("'-MaximumBackupDurationSeconds',([string]$MaximumBackupDurationSeconds)");
    expect(schedule).toContain("$task.Settings.ExecutionTimeLimit -eq 'PT4H'");
    expect(schedule).toContain("databaseSizePreflightRequired=$true");
    expect(runtime).toContain("evidence.maximumBackupDurationSeconds === 14400");
    expect(runtime).toContain("evidence.maximumDatabaseDumpBytes === scheduleEvidence?.maximumDatabaseDumpBytes");
    expect(runtime).toContain("evidence.incompleteStagingCleanupContract === true");
    expect(restore).toContain("$sourceDumpItem.Length-ne[long]$manifest.databaseDumpBytes");
  });

  it("keeps Web/API on loopback, binds exact verify-full Supabase egress and requires explicit fresh evidence before 443", async () => {
    const [runtime, launcher, edge] = await Promise.all([
      file("deploy/local/runtime-config.mjs"), file("deploy/local/launch-local-bundle.mjs"), file("deploy/local/https-edge.mjs")
    ]);
    expect(runtime).toContain('webBind: "127.0.0.1"');
    expect(runtime).toContain("databaseOutboundHost: database.host");
    expect(runtime).toContain('databaseTlsMode: "verify-full"');
    expect(runtime).toContain("latestBackupVerified");
    expect(runtime).toContain("validDatabaseBoundaryEvidence");
    expect(launcher).toContain("validateLocalApiConfigText");
    expect(edge).toContain('headers["x-local-edge-signature"]');
    expect(edge).toContain('headers["x-local-edge-body-sha256"]');
    expect(edge).toContain('headers["x-forwarded-for"]=remoteAddress');
    expect(edge).toContain("const upstreamPort = isApiRequest ? config.internalPorts.api : config.internalPorts.web");
    expect(edge).toContain("const upstreamPath = isApiRequest ? edgeTarget : incoming.url");
  });

  it("limits LAN ingress to exact approved clients and audits every protected inbound port", async () => {
    const [runtime, firewall, service] = await Promise.all([
      file("deploy/local/runtime-config.mjs"), file("deploy/windows/Manage-Firewall.ps1"), file("deploy/windows/Manage-Service.ps1")
    ]);
    expect(runtime).toContain("LAN_EXACT_CLIENT_ADDRESSES_REQUIRED");
    expect(runtime).toContain("LAN_CLIENT_ADDRESS_COUNT_MISMATCH");
    expect(firewall).toContain("EXACT_CLIENT_IPV4_32_REQUIRED");
    expect(firewall).toContain("@(443,3200,4200,5432,55432,6543)");
    expect(firewall).not.toContain("$candidateProgram-notin");
    expect(service.indexOf("INSTALLED_WRAPPER_HASH_MISMATCH")).toBeLessThan(service.indexOf("&$verifiedExe uninstall"));
    expect(service.indexOf("SERVICE_IMAGE_PATH_MISMATCH")).toBeLessThan(service.indexOf("&$verifiedExe uninstall"));
  });

  it("keeps maintenance portable and verifies the post-reboot listener boundary", async () => {
    const edge = await file("deploy/local/https-edge.mjs");
    expect(edge).toContain('path.join(config.data.root, "runtime-control", "maintenance.enabled")');
    expect(edge.indexOf("existsSync(maintenanceFlag)")).toBeLessThan(edge.indexOf("httpRequest({"));
    const reboot = await file("deploy/windows/Test-RebootReadiness.ps1");
    expect(reboot).toContain('"--hostname=$($config.lan.hostname)"');
    expect(reboot).toContain("'--expected-status=200'");
    expect(reboot).toContain("HTTPS_RELEASE_OR_PINNED_TRUST_VERIFY_FAILED");
    expect(reboot).toContain("WEB_LISTENER_OWNERSHIP_FAILED");
    expect(reboot).toContain("NEW_STACK_OWNS_FORBIDDEN_PORT");
    const releaseSwitch = await file("deploy/windows/Switch-LocalRelease.ps1");
    expect(releaseSwitch).toContain("MAINTENANCE_REQUIRED");
    expect(releaseSwitch).toContain("DATABASE_COMPATIBILITY_EVIDENCE_REJECTED");
    expect(releaseSwitch).toContain("RELEASE_VERIFICATION_FAILED");
    expect(releaseSwitch).toContain("previousEdgeXml");expect(releaseSwitch).toContain("targetEdgeXml");expect(releaseSwitch).toContain("Assert-ReleaseServiceIdentity");expect(releaseSwitch).toContain("currentCoreIdentityDigest");expect(releaseSwitch).toContain("currentEdgeIdentityDigest");expect(releaseSwitch).toContain("FileOptions]::WriteThrough");expect(releaseSwitch).toContain("Stop-Edge;Stop-Core");expect(releaseSwitch).toContain("EdgeRestarted=$true");
  });
});
