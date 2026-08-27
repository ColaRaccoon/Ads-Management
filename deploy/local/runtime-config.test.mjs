import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { validateLocalRuntimeConfig } from "./runtime-config.mjs";

const dataRoot = path.resolve(process.cwd(), "..", "runtime-data");
const backupReceiptKeys = generateKeyPairSync("ed25519");
const restoreReceiptKeys = generateKeyPairSync("ed25519");
const nodeSha256 = "a".repeat(64), psqlSha256 = "b".repeat(64), pgDumpSha256 = "c".repeat(64), filesystemEvidenceSha256 = "d".repeat(64), recoveryToolSha256 = "e".repeat(64), pgRestoreSha256 = "f".repeat(64);
const sha256Tuple = (...values) => createHash("sha256").update(values.join("\n")).digest("hex");

const base = () => ({
  version: 1,
  deploymentMode: "local_lan",
  internalPorts: { web: 3200, api: 4200 },
  database: databaseConfig(),
  data: { root: dataRoot },
  release: { id: null, migrationDigest: null },
  lan: { enabled: false, hostname: null, bindAddress: null, allowedCidrs: [], expectedClientCount: null, expectedClientSetDigest: null },
  tls: { caCertificatePath: null, serverCertificatePath: null, serverPrivateKeyPath: null, clientTrustVerified: false, clientTrustEvidencePath: null, hstsEnabled: false },
  hostSecurity: { filesystemEvidencePath: null, firewallEvidencePath: null, edgeSigningPublicKeyPath: null, edgeSigningPrivateKeyPath: null, nodeProgramPath: null, nodeProgramSha256: null, edgeServiceSid: null },
  backup: { root: null, dailyTime: null, rpoHours: 24, rtoHours: 4, physicalTargetEvidencePath: null, scheduledTaskEvidencePath: null, latestBackupEvidencePath: null, restoreEvidencePath: null, recoveryEvidencePath: null, backupReceiptPublicKeyPath: null, restoreReceiptPublicKeyPath: null }
});

test("missing LAN deployment values remains loopback-only", () => {
  const result = validateLocalRuntimeConfig(base());
  assert.equal(result.network.lanReady, false);
  assert.equal(result.network.corePrepared, false);
  assert.equal(result.network.webBind, "127.0.0.1");
  assert.equal(result.readiness.operationalReady, false);
});

test("a prepared Core may run on loopback without enabling Edge or reporting operational readiness", () => {
  const value = base();
  value.release = { id: "release-1", migrationDigest: "a".repeat(64) };
  value.hostSecurity = {
    filesystemEvidencePath: path.join(dataRoot, "evidence", "filesystem.json"),
    firewallEvidencePath: null,
    edgeSigningPublicKeyPath: path.join(dataRoot, "public-keys", "edge-public.pem"),
    edgeSigningPrivateKeyPath: null,
    nodeProgramPath: path.join(dataRoot, "public-keys", "node.exe"),
    nodeProgramSha256: "9".repeat(64),
    edgeServiceSid: "S-1-5-21-100-200-300-1002"
  };
  const now = new Date("2026-08-26T12:00:00.000Z");
  const result = validateLocalRuntimeConfig(value, {
    now,
    runtimeConfigPath: path.join(dataRoot, "public-keys", "runtime.json"),
    filesystemEvidence: filesystemEvidence("2026-08-26T11:55:00.000Z"),
    databaseBoundaryEvidence: databaseEvidence("2026-08-26T11:55:00.000Z")
  });
  assert.equal(result.network.corePrepared, true);
  assert.equal(result.network.lanReady, false);
  assert.equal(result.readiness.operationalReady, false);
  assert.throws(() => validateLocalRuntimeConfig(value, {
    now,
    runtimeConfigPath: path.join(dataRoot, "public-keys", "runtime.json"),
    filesystemEvidence: filesystemEvidence("2026-08-26T11:55:00.000Z"),
    databaseBoundaryEvidence: { ...databaseEvidence("2026-08-26T11:55:00.000Z"), executorHashesVerified: false }
  }), /DATABASE_BOUNDARY_EVIDENCE_REQUIRED/);
});

test("LAN cannot open before exact host, CIDR and client trust are all configured", () => {
  const value = base();
  value.lan.enabled = true;
  assert.throws(() => validateLocalRuntimeConfig(value), /LAN_EXPLICIT_HOST_AND_BIND_REQUIRED/);
});

test("backup is disabled until root and time are both present", () => {
  const value = base();
  value.backup.root = path.resolve(process.cwd(), "..", "runtime-backup");
  assert.throws(() => validateLocalRuntimeConfig(value), /BACKUP_ROOT_AND_TIME_REQUIRED_TOGETHER/);
});

test("trusted explicit LAN may open but cannot be operational-ready before restore proof", () => {
  const value = base();
  value.lan = { enabled: true, hostname: "meta-ads.internal", bindAddress: "192.168.10.20", allowedCidrs: ["192.168.10.31/32"], expectedClientCount: 1, expectedClientSetDigest: "2".repeat(64) };
  value.release = { id: "release-1", migrationDigest: "a".repeat(64) };
  value.hostSecurity = {
    filesystemEvidencePath: path.join(dataRoot, "evidence", "filesystem.json"),
    firewallEvidencePath: path.join(dataRoot, "evidence", "firewall.json"),
    edgeSigningPublicKeyPath: path.join(dataRoot, "public-keys", "edge-public.pem"),
    edgeSigningPrivateKeyPath: path.join(dataRoot, "edge-private", "edge-private.pem"),
    nodeProgramPath: path.join(dataRoot, "public-keys", "node.exe"), nodeProgramSha256: "9".repeat(64),
    edgeServiceSid: "S-1-5-21-100-200-300-1002"
  };
  value.tls = {
    caCertificatePath: path.join(dataRoot, "certs", "ca.cer"),
    serverCertificatePath: path.join(dataRoot, "certs", "server.pem"),
    serverPrivateKeyPath: path.join(dataRoot, "certs", "server-key.pem"),
    clientTrustVerified: true,
    clientTrustEvidencePath: path.join(dataRoot, "evidence", "client-trust.json"),
    hstsEnabled: false
  };
  const now = new Date("2026-08-26T12:00:00.000Z");
  const clientTrustEvidence = { version: 4, result: "PASS", phase: "PREOPEN", hostname: "meta-ads.internal", releaseId: null, caThumbprint: "A".repeat(40), serverCertificateSha256: "1".repeat(64), verifiedClientCount: 1, clientSetDigest: "2".repeat(64), allowedClientCidrs: value.lan.allowedCidrs, clientAddressMappingVerified: true, clientAddressOwnershipVerified: true, verificationPlanSetDigest: "3".repeat(64), httpsVerified: false, completedAt: "2026-08-26T00:00:00.000Z" };
  const result = validateLocalRuntimeConfig(value, {
    now,
    clientTrustEvidence,
    filesystemEvidence: filesystemEvidence("2026-08-26T00:00:00.000Z"),
    databaseBoundaryEvidence: databaseEvidence("2026-08-26T11:55:00.000Z")
    ,firewallEvidence: firewallEvidence(value, "2026-08-26T00:00:00.000Z")
  });
  assert.equal(result.network.lanReady, true);
  assert.equal(result.readiness.operationalReady, false);
  assert.throws(() => validateLocalRuntimeConfig(value, {
    now,
    clientTrustEvidence: { ...clientTrustEvidence, clientAddressOwnershipVerified: false },
    filesystemEvidence: filesystemEvidence("2026-08-26T00:00:00.000Z"),
    databaseBoundaryEvidence: databaseEvidence("2026-08-26T11:55:00.000Z"),
    firewallEvidence: firewallEvidence(value, "2026-08-26T00:00:00.000Z")
  }), /CLIENT_TRUST_EVIDENCE_REQUIRED/);
});

test("wildcard or public bind addresses are rejected", () => {
  for (const bindAddress of ["0.0.0.0", "8.8.8.8", "169.254.1.5", "224.0.0.1"]) {
    const value = base();
    value.lan = { enabled: true, hostname: "meta-ads.internal", bindAddress, allowedCidrs: ["192.168.10.31/32"], expectedClientCount: 1, expectedClientSetDigest: "2".repeat(64) };
    value.release = { id: "release-1", migrationDigest: "a".repeat(64) };
    assert.throws(() => validateLocalRuntimeConfig(value), /LAN_EXPLICIT_HOST_AND_BIND_REQUIRED/);
  }
});

test("LAN access is restricted to one exact private /32 per approved client", () => {
  const subnet = base();
  subnet.lan = { enabled: true, hostname: "meta-ads.internal", bindAddress: "192.168.10.20", allowedCidrs: ["192.168.10.0/24"], expectedClientCount: 1, expectedClientSetDigest: "2".repeat(64) };
  subnet.release = { id: "release-1", migrationDigest: "a".repeat(64) };
  assert.throws(() => validateLocalRuntimeConfig(subnet), /LAN_EXACT_CLIENT_ADDRESSES_REQUIRED/);

  const mismatch = base();
  mismatch.lan = { enabled: true, hostname: "meta-ads.internal", bindAddress: "192.168.10.20", allowedCidrs: ["192.168.10.31/32"], expectedClientCount: 2, expectedClientSetDigest: "2".repeat(64) };
  mismatch.release = { id: "release-1", migrationDigest: "a".repeat(64) };
  assert.throws(() => validateLocalRuntimeConfig(mismatch), /LAN_CLIENT_ADDRESS_COUNT_MISMATCH/);
});

test("operational readiness requires fresh schedule, backup, restore, filesystem, database and client evidence", () => {
  const value = base();
  configureTrustedLan(value);
  const backupRoot = path.resolve(process.cwd(), "..", "runtime-backup");
  value.backup = {
    root: backupRoot, dailyTime: "02:30", rpoHours: 24, rtoHours: 4,
    physicalTargetEvidencePath: path.join(dataRoot, "evidence", "target.json"),
    scheduledTaskEvidencePath: path.join(dataRoot, "evidence", "schedule.json"),
    latestBackupEvidencePath: path.join(dataRoot, "backup-receipt", "latest.json"),
    restoreEvidencePath: path.join(dataRoot, "evidence", "restore.json"),
    recoveryEvidencePath: path.join(dataRoot, "evidence", "recovery.json"),
    backupReceiptPublicKeyPath: path.join(dataRoot, "public-keys", "backup-receipt-public.pem"),
    restoreReceiptPublicKeyPath: path.join(dataRoot, "public-keys", "restore-receipt-public.pem")
  };
  const now = new Date("2026-08-26T12:00:00.000Z");
  const options = trustedEvidence(now, value, backupRoot);
  const ready = validateLocalRuntimeConfig(value, options);
  assert.equal(ready.readiness.operationalReady, true);
  const stale = validateLocalRuntimeConfig(value, {
    ...options,
    latestBackupEvidence: { ...options.latestBackupEvidence, completedAt: "2026-08-24T00:00:00.000Z" }
  });
  assert.equal(stale.readiness.latestBackupVerified, false);
  assert.equal(stale.readiness.operationalReady, false);
});

test("executor pin drift fails schedule, signed backup, signed restore and recovery readiness", () => {
  const value = base(); configureTrustedLan(value);
  const backupRoot = path.resolve(process.cwd(), "..", "runtime-backup");
  value.backup = { root: backupRoot, dailyTime: "02:30", rpoHours: 24, rtoHours: 4,
    physicalTargetEvidencePath: path.join(dataRoot,"evidence","target.json"), scheduledTaskEvidencePath: path.join(dataRoot,"evidence","schedule.json"),
    latestBackupEvidencePath: path.join(dataRoot,"backup-receipt","latest.json"), restoreEvidencePath: path.join(dataRoot,"evidence","restore.json"), recoveryEvidencePath: path.join(dataRoot,"evidence","recovery.json"),
    backupReceiptPublicKeyPath: path.join(dataRoot,"public-keys","backup-receipt-public.pem"), restoreReceiptPublicKeyPath: path.join(dataRoot,"public-keys","restore-receipt-public.pem") };
  const options = trustedEvidence(new Date("2026-08-26T12:00:00.000Z"), value, backupRoot);
  const scheduleDrift = validateLocalRuntimeConfig(value, { ...options, backupScheduleEvidence: { ...options.backupScheduleEvidence, nodeSha256: "0".repeat(64) } });
  assert.equal(scheduleDrift.readiness.backupScheduleVerified, false);
  assert.equal(scheduleDrift.readiness.latestBackupVerified, false);
  const unsignedBackup = { ...options.latestBackupEvidence, psqlSha256: "0".repeat(64) }; delete unsignedBackup.signingKeyId; delete unsignedBackup.attestationSignature;
  const backupDrift = validateLocalRuntimeConfig(value, { ...options, latestBackupEvidence: signed(unsignedBackup, backupReceiptKeys) });
  assert.equal(backupDrift.readiness.latestBackupVerified, false);
  const unsignedRestore = { ...options.restoreEvidence, restoreExecutorSetDigest: "0".repeat(64) }; delete unsignedRestore.signingKeyId; delete unsignedRestore.attestationSignature;
  const restoreDrift = validateLocalRuntimeConfig(value, { ...options, restoreEvidence: signed(unsignedRestore, restoreReceiptKeys) });
  assert.equal(restoreDrift.readiness.restoreVerified, false);
  const recoveryDrift = validateLocalRuntimeConfig(value, { ...options, recoveryEvidence: { ...options.recoveryEvidence, executorSetDigest: "0".repeat(64) } });
  assert.equal(recoveryDrift.readiness.recoveryVerified, false);
  const legacyRecovery = validateLocalRuntimeConfig(value, { ...options, recoveryEvidence: { ...options.recoveryEvidence, version: 4 } });
  assert.equal(legacyRecovery.readiness.recoveryVerified, false);
  assert.equal(legacyRecovery.readiness.operationalReady, false);
});

test("backup readiness rejects cap, deadline and cleanup-contract drift", () => {
  const value = base(); configureTrustedLan(value);
  const backupRoot = path.resolve(process.cwd(), "..", "runtime-backup");
  value.backup = { root: backupRoot, dailyTime: "02:30", rpoHours: 24, rtoHours: 4,
    physicalTargetEvidencePath: path.join(dataRoot,"evidence","target.json"), scheduledTaskEvidencePath: path.join(dataRoot,"evidence","schedule.json"),
    latestBackupEvidencePath: path.join(dataRoot,"backup-receipt","latest.json"), restoreEvidencePath: path.join(dataRoot,"evidence","restore.json"), recoveryEvidencePath: path.join(dataRoot,"evidence","recovery.json"),
    backupReceiptPublicKeyPath: path.join(dataRoot,"public-keys","backup-receipt-public.pem"), restoreReceiptPublicKeyPath: path.join(dataRoot,"public-keys","restore-receipt-public.pem") };
  const options = trustedEvidence(new Date("2026-08-26T12:00:00.000Z"), value, backupRoot);
  for (const drift of [
    { maximumDatabaseDumpBytes: 1024 }, { maximumBackupDurationSeconds: 14399 }, { hardDeadlineRequired: false }, { incompleteStagingCleanupRequired: false }
  ]) {
    const result = validateLocalRuntimeConfig(value, { ...options, backupScheduleEvidence: { ...options.backupScheduleEvidence, ...drift } });
    assert.equal(result.readiness.backupScheduleVerified, false);
    assert.equal(result.readiness.operationalReady, false);
  }
  for (const drift of [
    { maximumDatabaseDumpBytes: options.latestBackupEvidence.maximumDatabaseDumpBytes + 1 },
    { databaseDumpBytes: options.latestBackupEvidence.maximumDatabaseDumpBytes + 1 }, { elapsedSeconds: 14401 }, { databaseSizePreflightVerified: false }, { databaseDumpRealtimeCapEnforced: false }, { databaseDumpFinalCapVerified: false },
    { processTreeKillOnDeadline: false }, { incompleteStagingCleanupContract: false }
  ]) {
    const unsigned = { ...options.latestBackupEvidence, ...drift }; delete unsigned.signingKeyId; delete unsigned.attestationSignature;
    const result = validateLocalRuntimeConfig(value, { ...options, latestBackupEvidence: signed(unsigned, backupReceiptKeys) });
    assert.equal(result.readiness.latestBackupVerified, false);
    assert.equal(result.readiness.operationalReady, false);
  }
});

test("a newer valid daily backup does not invalidate the bounded restore rehearsal", () => {
  const value = base(); configureTrustedLan(value);
  const backupRoot = path.resolve(process.cwd(), "..", "runtime-backup");
  value.backup = { root: backupRoot, dailyTime: "02:30", rpoHours: 24, rtoHours: 4,
    physicalTargetEvidencePath: path.join(dataRoot,"evidence","target.json"), scheduledTaskEvidencePath: path.join(dataRoot,"evidence","schedule.json"),
    latestBackupEvidencePath: path.join(dataRoot,"backup-receipt","latest.json"), restoreEvidencePath: path.join(dataRoot,"evidence","restore.json"), recoveryEvidencePath: path.join(dataRoot,"evidence","recovery.json"),
    backupReceiptPublicKeyPath: path.join(dataRoot,"public-keys","backup-receipt-public.pem"), restoreReceiptPublicKeyPath: path.join(dataRoot,"public-keys","restore-receipt-public.pem") };
  const options = trustedEvidence(new Date("2026-08-26T12:00:00.000Z"), value, backupRoot);
  const nextUnsigned = { ...options.latestBackupEvidence, backupId: "20260826T115500Z-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", storageReferenceDigest: "8".repeat(64), completedAt: "2026-08-26T11:55:00.000Z" };
  delete nextUnsigned.signingKeyId; delete nextUnsigned.attestationSignature;
  const next = signed(nextUnsigned, backupReceiptKeys);
  const result = validateLocalRuntimeConfig(value, { ...options, latestBackupEvidence: next });
  assert.equal(result.readiness.latestBackupVerified, true);
  assert.equal(result.readiness.restoreVerified, true);
  assert.equal(result.readiness.operationalReady, true);
});

function configureTrustedLan(value) {
  value.lan = { enabled: true, hostname: "meta-ads.internal", bindAddress: "192.168.10.20", allowedCidrs: ["192.168.10.31/32", "192.168.10.32/32"], expectedClientCount: 2, expectedClientSetDigest: "2".repeat(64) };
  value.release = { id: "release-1", migrationDigest: "a".repeat(64) };
  value.tls = {
    caCertificatePath: path.join(dataRoot, "certs", "ca.cer"), serverCertificatePath: path.join(dataRoot, "certs", "server.pem"),
    serverPrivateKeyPath: path.join(dataRoot, "certs", "server-key.pem"), clientTrustVerified: true,
    clientTrustEvidencePath: path.join(dataRoot, "evidence", "client.json"), hstsEnabled: false
  };
  value.hostSecurity = {
    filesystemEvidencePath: path.join(dataRoot, "evidence", "filesystem.json"),
    firewallEvidencePath: path.join(dataRoot, "evidence", "firewall.json"),
    edgeSigningPublicKeyPath: path.join(dataRoot, "public-keys", "edge-public.pem"),
    edgeSigningPrivateKeyPath: path.join(dataRoot, "edge-private", "edge-private.pem"),
    nodeProgramPath: path.join(dataRoot, "public-keys", "node.exe"), nodeProgramSha256: "9".repeat(64),
    edgeServiceSid: "S-1-5-21-100-200-300-1002"
  };
}

function databaseConfig() {
  return {
    provider: "supabase_postgres", projectRef: "abcdefghijklmnopqrst", connectionMode: "session_pooler",
    host: "aws-0-ap-northeast-2.pooler.supabase.com", port: 5432, name: "postgres", runtimeUser: "meta_runtime", migrationUser: "meta_migration", backupUser: "meta_backup", restoreUser: "meta_restore", schema: "public",
    caCertificatePath: path.join(dataRoot,"public-keys","supabase-db-ca.crt"), caCertificateSha256: "5".repeat(64),
    boundaryEvidencePath: path.join(dataRoot,"evidence","database.json")
  };
}

function databaseEvidence(completedAt) {
  const db=databaseConfig();
  return { version: 6, result: "PASS", provider: db.provider, projectRef: db.projectRef, connectionMode: db.connectionMode, host: db.host, port: db.port,
    sslMode: "verify-full", tlsVerified: true, hostnameVerified: true, caVerified: true, caCertificateSha256: db.caCertificateSha256, psqlSha256, executorHashesVerified: true,
    pgStatSsl: true, tlsProtocol: "TLSv1.3", tlsCipher: "TLS_AES_256_GCM_SHA384", publicRemoteEndpoint: true,
    runtimeDdlDenied: true, roleAttributesRestricted: true, boundedConnectionLimits: true, scramCredentialsVerified: true, runtimeObjectOwnershipDenied: true, roleMembershipsAbsent: true,
    privilegeContractVerified: true, sequencePrivilegesVerified: true, functionEscalationAbsent: true, defaultPrivilegesVerified: true, migrationOwnershipVerified: true, migrationRoleFullDataPrivileged: true, migrationCredentialAdminOnly: true, migrationCredentialMaintenanceOnly: true, migrationTableProtected: true, crossSchemaPrivilegesAbsent: true, credentialsDistinct: true, crossRoleAuthenticationDenied: true, productionRestoreRoleAccessAbsent: true, auditAppendOnlyGuardVerified: true, credentialInventoryDigest: "a".repeat(64),
    databaseName: db.name, databaseUser: db.runtimeUser, databaseSchema: db.schema,
    runtimeRoleDigest: createHash("sha256").update(db.runtimeUser).digest("hex"), migrationRoleDigest: createHash("sha256").update(db.migrationUser).digest("hex"), backupRoleDigest: createHash("sha256").update(db.backupUser).digest("hex"), restoreRoleDigest: createHash("sha256").update(db.restoreUser).digest("hex"), completedAt };
}

function trustedEvidence(now, value, backupRoot) {
  const completedAt = "2026-08-26T11:00:00.000Z";
  const target = { version: 5, result: "PASS", targetType: "LOCAL_DISK", dataRoot, backupRoot, dataDiskNumber: 1, backupDiskNumber: 2, dataDiskUniqueId: "disk-a", backupDiskUniqueId: "disk-b", nasServer: null, nasShare: null, backupWriterSid: "S-1-5-21-100-200-300-1003", appServiceDenied: true, edgeServiceDenied: true, separateBackupWriter: true, aclProtected: true, exactAcl: true, encryptedAtRestOrTransport: true, encryptionProof: "BITLOCKER_FULLY_ENCRYPTED", retentionControl: "OFFLINE_ROTATION", completedAt };
  const targetFingerprint = createHash("sha256").update(["5",target.result,target.targetType,target.dataRoot,target.backupRoot,target.dataDiskUniqueId,target.backupDiskUniqueId,target.nasServer??"",target.nasShare??"",target.backupWriterSid,target.encryptionProof,target.retentionControl,target.completedAt].join("\n")).digest("hex");
  const db=value.database;
  const configFingerprint = createHash("sha256").update(["2",value.release.id,value.release.migrationDigest,dataRoot,backupRoot,value.backup.dailyTime,db.provider,db.projectRef,db.connectionMode,db.host,String(db.port),db.name,db.runtimeUser,db.migrationUser,db.backupUser,db.restoreUser,db.schema,db.caCertificateSha256,"24","4",targetFingerprint].join("\n")).digest("hex");
  const runtimeConfigSha256 = createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const result = {
    now,
    runtimeConfigSha256,
    recoveryEvidence: { version: 5, result: "PASS", kitId: "8".repeat(64), kitSha256: "8".repeat(64), worksheetSha256: "4".repeat(64), localKitSha256: "8".repeat(64), escrowKitSha256: "8".repeat(64), manifestSha256: "9".repeat(64), installId: "install-test-0001", runtimeConfigSha256, inventoryDigest: "6".repeat(64), databaseCredentialInventoryDigest: databaseEvidence("2026-08-26T11:55:00.000Z").credentialInventoryDigest, backupIntegrityKeySha256: "7".repeat(64), nodeSha256, toolSha256: recoveryToolSha256, executorSetDigest: sha256Tuple(nodeSha256,recoveryToolSha256), exactInventory: true, authenticatedExtract: true, boundedExtract: true, disasterRecoveryVerified: false, sourcePathsDisclosed: false, extractionRetained: false, currentInstallBound: true, currentSourceHashesVerified: true, localCopyPresent: true, escrowCopyPresent: true, escrowSeparated: true, copiesMatch: true, adminOnlyAcl: true, testExtractRemoved: true, pfxPrivateKeyVerified: true, caIdentityVerified: true, completedAt },
    clientTrustEvidence: { version: 4, result: "PASS", phase: "PREOPEN", hostname: value.lan.hostname, releaseId: null, caThumbprint: "A".repeat(40), serverCertificateSha256: "1".repeat(64), verifiedClientCount: 2, clientSetDigest: "2".repeat(64), allowedClientCidrs: value.lan.allowedCidrs, clientAddressMappingVerified: true, clientAddressOwnershipVerified: true, verificationPlanSetDigest: "3".repeat(64), httpsVerified: false, completedAt },
    filesystemEvidence: filesystemEvidence(completedAt),
    databaseBoundaryEvidence: databaseEvidence("2026-08-26T11:55:00.000Z"),
    firewallEvidence: firewallEvidence(value, completedAt),
    backupTargetEvidence: target,
    backupScheduleEvidence: { version: 5, result: "PASS", taskName: "Meta Ads Performance Daily Backup", dailyTime: "02:30", dailyTriggerVerified: true, dailyTriggerEnabled: true, daysInterval: 1, maximumDatabaseDumpBytes: 68719476736, maximumBackupDurationSeconds: 14400, backupSafetyMarginBytes: 1073741824, databaseSizePreflightRequired: true, databaseDumpRealtimeCapRequired: true, databaseDumpFinalCapRequired: true, hardDeadlineRequired: true, processTreeKillOnDeadlineRequired: true, incompleteStagingCleanupRequired: true, backupSid: target.backupWriterSid, separatePrincipal: true, powerShell7Verified: true, powerShellPath: "C:\\Program Files\\PowerShell\\7\\pwsh.exe", powerShellSha256: "6".repeat(64), actionArgumentsSha256: "5".repeat(64), backupScriptSha256: "4".repeat(64), releaseVerifierSha256: "2".repeat(64), releaseManifestSha256: "1".repeat(64), attestationSignerSha256: "3".repeat(64), nodeSha256, psqlSha256, pgDumpSha256, executorSetDigest: sha256Tuple(nodeSha256,psqlSha256,pgDumpSha256), filesystemEvidenceSha256, scriptHashVerified: true, signerHashVerified: true, executorHashesVerified: true, enabled: true, startWhenAvailable: true, lastSuccessAt: completedAt, completedAt },
    latestBackupEvidence: signed({ attestationType: "backup-latest", version: 5, result: "COMPLETE", backupId: "20260826T110000Z-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", releaseId: value.release.id, sourceDataRoot: dataRoot, backupRoot, databaseProvider: db.provider, databaseProjectRef: db.projectRef, databaseHost: db.host, databasePort: db.port, databaseName: db.name, databaseSchema: db.schema, databaseDumpBytes: 1048576, maximumDatabaseDumpBytes: 68719476736, maximumBackupDurationSeconds: 14400, backupSafetyMarginBytes: 1073741824, elapsedSeconds: 30, databaseSizePreflightVerified: true, databaseDumpRealtimeCapEnforced: true, databaseDumpFinalCapVerified: true, hardDeadlineEnforced: true, processTreeKillOnDeadline: true, incompleteStagingCleanupContract: true, migrationDigest: value.release.migrationDigest, appliedMigrationDigest: "d".repeat(64), storageReferenceDigest: "f".repeat(64), targetEvidenceFingerprint: targetFingerprint, configFingerprint, manifestSha256: "b".repeat(64), integrityKeyId: "7".repeat(64), integritySignature: "c".repeat(64), nodeSha256, psqlSha256, pgDumpSha256, executorSetDigest: sha256Tuple(nodeSha256,psqlSha256,pgDumpSha256), filesystemEvidenceSha256, completedAt }, backupReceiptKeys),
    restoreEvidence: signed({ attestationType: "restore-verification", version: 6, result: "PASS", rpoHours: 24, rtoHours: 4, elapsedSeconds: 30, databaseRestored: true, storageHashVerified: true, storageReferenceVerified: true, businessKpiVerified: true, restoreRoleRestricted: true, restoreVerifierIdentityBound: true, isolatedDatabaseSchemaCleaned: true, isolatedDatabasePristineBeforeRestore: true, eventTriggersAbsentBeforeRestore: true, isolatedStorageRootCleaned: true, fullCatalogCleanupVerified: true, verifiedInputSnapshot: true, boundedManifestCopy: true, isolatedApiConfigsBound: true, archiveTocAllowlisted: true, hardDeadlineEnforced: true, processTreeKillOnDeadline: true, uncompressedTarArchive: true, capacityReserveVerified: true, nodeSha256, psqlSha256, pgRestoreSha256, restoreExecutorSetDigest: sha256Tuple(nodeSha256,psqlSha256,pgRestoreSha256), filesystemEvidenceSha256, databaseBoundaryEvidenceSha256: "9".repeat(64), sourceDataRoot: "D:\\previous-host-data", verifiedTargetDataRoot: dataRoot, verifiedStorageRoot: path.join(dataRoot,"restore-verification","drill_restore_verify"), verifiedTargetDescriptorDigest: "b".repeat(64), releaseId: value.release.id, databaseProvider: db.provider, sourceDatabaseProjectRef: db.projectRef, restoreTargetProjectRef: "zyxwvutsrqponmlkjihg", restoreTargetDatabaseName: "restore_db", isolatedRestoreTarget: true, productionDatabaseMutated: false, databaseName: db.name, databaseSchema: db.schema, configFingerprint, targetEvidenceFingerprint: targetFingerprint, integrityKeyId: "7".repeat(64), migrationDigest: value.release.migrationDigest, appliedMigrationDigest: "d".repeat(64), businessKpiDigest: "e".repeat(64), storageReferenceDigest: "f".repeat(64), backupId: "20260826T110000Z-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", backupManifestSha256: "b".repeat(64), backupIntegritySignature: "c".repeat(64), completedAt }, restoreReceiptKeys),
    backupReceiptPublicKey: backupReceiptKeys.publicKey.export({ type: "spki", format: "pem" }),
    restoreReceiptPublicKey: restoreReceiptKeys.publicKey.export({ type: "spki", format: "pem" })
  };
  Object.assign(result.backupScheduleEvidence,{runtimeConfigSha256,runtimeReadinessBound:true,recurringInvocationPlanBound:true});
  return result;
}

function firewallEvidence(value, completedAt) {
  return { version: 4, result: "PASS", ruleName: "MetaAdsPerformance-Https443-PrivateLan", bindAddress: value.lan.bindAddress,
    allowedCidrs: value.lan.allowedCidrs, exactClientAddresses: true, protectedPorts: [443,3200,4200,5432,55432,6543], nodeProgramPath: value.hostSecurity.nodeProgramPath,
    nodeProgramSha256: value.hostSecurity.nodeProgramSha256, edgeServiceName: "MetaAdsPerformanceEdge", edgeServiceSid: value.hostSecurity.edgeServiceSid, serviceRestricted: true,
    publicProfileOpened: false, conflictingAllowRulesAbsent: true, internalPortsDenied: true, allProfilesEnabled: true, defaultInboundBlocked: true,
    profilePolicies: { Domain: { enabled: true, defaultInboundAction: "Block" }, Private: { enabled: true, defaultInboundAction: "Block" }, Public: { enabled: true, defaultInboundAction: "Block" } }, completedAt };
}

function filesystemEvidence(completedAt) {
  return {
    result: "PASS", dataRoot, filesystem: "NTFS", nonReparse: true, leastPrivilege: true, exactAcl: true,
    coreServiceSid: "S-1-5-21-100-200-300-1001", edgeServiceSid: "S-1-5-21-100-200-300-1002", backupSid: "S-1-5-21-100-200-300-1003",
    classRoots: {
      CORE_MODIFY: [path.join(dataRoot,"storage")], CORE_READ: [path.join(dataRoot,"core-config")],
      EDGE_MODIFY: [path.join(dataRoot,"logs","edge")], EDGE_READ: [path.join(dataRoot,"runtime-control"),path.join(dataRoot,"certs"),path.join(dataRoot,"edge-private")],
      SHARED_RUNTIME: [path.join(dataRoot,"public-keys")], ADMIN_EVIDENCE: [path.join(dataRoot,"evidence")],
      BACKUP_RECEIPT: [path.join(dataRoot,"backup-receipt")], BACKUP_ONLY: [path.join(dataRoot,"backup-secrets")], ADMIN_ONLY: [path.join(dataRoot,"admin-only")]
    },
    descriptorDigest: "b".repeat(64), completedAt
  };
}

function signed(value, keys) {
  if (value.attestationType === "restore-verification") value = { ...value,
    isolatedDatabasePristineBeforeRestore: true, eventTriggersAbsentBeforeRestore: true,
    isolatedStorageRootCleaned: true, verifiedInputSnapshot: true,
    restoreTargetDatabaseName: "restore_verify" };
  const publicDer = keys.publicKey.export({ type: "spki", format: "der" });
  return {
    ...value,
    signingKeyId: createHash("sha256").update(publicDer).digest("hex"),
    attestationSignature: sign(null, Buffer.from(canonicalJson(value)), keys.privateKey).toString("base64url")
  };
}
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
