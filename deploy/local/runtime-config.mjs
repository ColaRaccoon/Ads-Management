import { isIP } from "node:net";
import { createHash, createPublicKey, verify } from "node:crypto";
import { homedir, platform } from "node:os";
import path from "node:path";

export function validateLocalRuntimeConfig(input, options = {}) {
  if (!plainObject(input)) fail("CONFIG_OBJECT_REQUIRED");
  exactKeys(input, ["version", "deploymentMode", "internalPorts", "database", "data", "release", "lan", "tls", "hostSecurity", "backup"]);
  if (input.version !== 1 || input.deploymentMode !== "local_lan") fail("CONFIG_VERSION_OR_MODE_INVALID");
  validatePorts(input.internalPorts);
  exactObject(input.database, ["provider", "projectRef", "connectionMode", "host", "port", "name", "runtimeUser", "migrationUser", "backupUser", "restoreUser", "schema", "caCertificatePath", "caCertificateSha256", "boundaryEvidencePath"]);
  validateDatabase(input.database);
  exactObject(input.data, ["root"]);
  exactObject(input.release, ["id", "migrationDigest"]);
  exactObject(input.lan, ["enabled", "hostname", "bindAddress", "allowedCidrs", "expectedClientCount", "expectedClientSetDigest"]);
  exactObject(input.tls, ["caCertificatePath", "serverCertificatePath", "serverPrivateKeyPath", "clientTrustVerified", "clientTrustEvidencePath", "hstsEnabled"]);
  exactObject(input.hostSecurity, ["filesystemEvidencePath", "firewallEvidencePath", "rebootEvidencePath", "edgeSigningPublicKeyPath", "edgeSigningPrivateKeyPath", "nodeProgramPath", "nodeProgramSha256", "edgeServiceSid"]);
  exactObject(input.backup, ["root", "dailyTime", "rpoHours", "rtoHours", "physicalTargetEvidencePath", "scheduledTaskEvidencePath", "latestBackupEvidencePath", "restoreEvidencePath", "recoveryEvidencePath", "disasterRecoveryEvidencePath", "backupReceiptPublicKeyPath", "restoreReceiptPublicKeyPath"]);

  const dataRoot = resolveDataRoot(input.data.root, options.env);
  if (options.releaseRoot && (sameOrNested(dataRoot, options.releaseRoot) || sameOrNested(options.releaseRoot, dataRoot))) fail("DATA_ROOT_MUST_BE_OUTSIDE_RELEASE");
  const internalPorts = input.internalPorts;
  if (new Set([internalPorts.web, internalPorts.api, 443]).size !== 3) {
    fail("PORTS_MUST_BE_DISTINCT");
  }
  if (input.backup.rpoHours !== 24 || input.backup.rtoHours !== 4) fail("RECOVERY_OBJECTIVES_INVALID");
  const now = options.now instanceof Date ? options.now.getTime() : Date.now();
  const backupTargetVerified = validBackupTargetEvidence(options.backupTargetEvidence, input.backup, dataRoot, options.filesystemEvidence, now);
  const backupScheduleVerified = validBackupScheduleEvidence(options.backupScheduleEvidence, input.backup, options.backupTargetEvidence, options.backupTargetEvidenceSha256, options.filesystemEvidence, options.runtimeConfigSha256, now);
  const latestBackupVerified = validLatestBackupEvidence(options.latestBackupEvidence, options.backupReceiptPublicKey, input.release, input.backup, dataRoot, input.database, options.backupTargetEvidence, options.backupScheduleEvidence, now);
  const backupConfigured = Boolean(input.backup.root && input.backup.dailyTime && backupTargetVerified && backupScheduleVerified && latestBackupVerified);
  if (Boolean(input.backup.root) !== Boolean(input.backup.dailyTime)) fail("BACKUP_ROOT_AND_TIME_REQUIRED_TOGETHER");
  if (input.backup.dailyTime && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.backup.dailyTime)) fail("BACKUP_TIME_INVALID");
  if (input.backup.root) {
    requireBackupPath(input.backup.root, "BACKUP_ROOT_INVALID");
    if (sameOrNested(input.backup.root, dataRoot) || sameOrNested(dataRoot, input.backup.root)) {
      fail("BACKUP_MUST_NOT_SHARE_DATA_ROOT");
    }
    if (options.releaseRoot && (sameOrNested(input.backup.root, options.releaseRoot) || sameOrNested(options.releaseRoot, input.backup.root))) fail("BACKUP_ROOT_MUST_BE_OUTSIDE_RELEASE");
    for (const key of ["physicalTargetEvidencePath", "scheduledTaskEvidencePath", "restoreEvidencePath", "recoveryEvidencePath", "disasterRecoveryEvidencePath"]) {
      requireAbsoluteLocalPath(input.backup[key], "BACKUP_EVIDENCE_PATH_REQUIRED");
      if (!sameOrNested(input.backup[key], path.join(dataRoot, "evidence"))) fail("BACKUP_EVIDENCE_MUST_USE_SHARED_READINESS_ROOT");
    }
    requireAbsoluteLocalPath(input.backup.latestBackupEvidencePath, "BACKUP_EVIDENCE_PATH_REQUIRED");
    if (!sameOrNested(input.backup.latestBackupEvidencePath, path.join(dataRoot, "backup-receipt"))) fail("LATEST_BACKUP_RECEIPT_MUST_USE_WRITER_ROOT");
    requireAbsoluteLocalPath(input.backup.backupReceiptPublicKeyPath, "BACKUP_RECEIPT_PUBLIC_KEY_REQUIRED");
    requireAbsoluteLocalPath(input.backup.restoreReceiptPublicKeyPath, "RESTORE_RECEIPT_PUBLIC_KEY_REQUIRED");
  } else if (input.backup.backupReceiptPublicKeyPath !== null || input.backup.restoreReceiptPublicKeyPath !== null) {
    fail("DISABLED_BACKUP_KEYS_MUST_BE_EMPTY");
  }

  const lan = input.lan;
  const tls = input.tls;
  const release = input.release;
  const hostSecurity = input.hostSecurity;
  const database = input.database;
  if (typeof lan.enabled !== "boolean" || !Array.isArray(lan.allowedCidrs)) fail("LAN_CONFIG_INVALID");
  if (typeof tls.clientTrustVerified !== "boolean" || typeof tls.hstsEnabled !== "boolean") fail("TLS_CONFIG_INVALID");
  let lanReady = false;
  let corePrepared = false;
  if (lan.enabled) {
    if (!validHostname(lan.hostname) || !privateIpv4(lan.bindAddress)) {
      fail("LAN_EXPLICIT_HOST_AND_BIND_REQUIRED");
    }
    if (lan.allowedCidrs.length === 0 || lan.allowedCidrs.some((cidr) => !validClientIpv4Cidr(cidr))) {
      fail("LAN_EXACT_CLIENT_ADDRESSES_REQUIRED");
    }
    if (!Number.isInteger(lan.expectedClientCount) || lan.expectedClientCount < 1 || lan.expectedClientCount > 10_000 ||
        !/^[0-9a-f]{64}$/.test(lan.expectedClientSetDigest ?? "")) fail("LAN_EXPECTED_CLIENT_SET_REQUIRED");
    if (new Set(lan.allowedCidrs).size !== lan.allowedCidrs.length || lan.expectedClientCount !== lan.allowedCidrs.length) {
      fail("LAN_CLIENT_ADDRESS_COUNT_MISMATCH");
    }
    for (const key of ["caCertificatePath", "serverCertificatePath", "serverPrivateKeyPath"]) {
      requireAbsoluteLocalPath(tls[key], "TLS_PATHS_REQUIRED");
    }
    requireAbsoluteLocalPath(tls.clientTrustEvidencePath, "CLIENT_TRUST_EVIDENCE_PATH_REQUIRED");
    if (!validRelease(release)) fail("RELEASE_IDENTITY_REQUIRED");
    requireAbsoluteLocalPath(hostSecurity.filesystemEvidencePath, "FILESYSTEM_EVIDENCE_PATH_REQUIRED");
    requireAbsoluteLocalPath(database.boundaryEvidencePath, "DATABASE_BOUNDARY_EVIDENCE_PATH_REQUIRED");
    requireAbsoluteLocalPath(hostSecurity.firewallEvidencePath, "FIREWALL_EVIDENCE_PATH_REQUIRED");
    requireAbsoluteLocalPath(hostSecurity.rebootEvidencePath, "REBOOT_EVIDENCE_PATH_REQUIRED");
    requireAbsoluteLocalPath(hostSecurity.edgeSigningPublicKeyPath, "EDGE_SIGNING_PUBLIC_KEY_PATH_REQUIRED");
    requireAbsoluteLocalPath(hostSecurity.edgeSigningPrivateKeyPath, "EDGE_SIGNING_PRIVATE_KEY_PATH_REQUIRED");
    requireAbsoluteLocalPath(hostSecurity.nodeProgramPath, "NODE_PROGRAM_PATH_REQUIRED");
    if (!/^[0-9a-f]{64}$/.test(hostSecurity.nodeProgramSha256 ?? "") || !/^S-1-(?:\d+-){1,14}\d+$/.test(hostSecurity.edgeServiceSid ?? "")) fail("WINDOWS_EDGE_IDENTITY_REQUIRED");
    if (!tls.clientTrustVerified || !validClientTrustEvidence(options.clientTrustEvidence, tls, lan, now)) {
      fail("CLIENT_TRUST_EVIDENCE_REQUIRED");
    }
    if (!validFilesystemEvidence(options.filesystemEvidence, input, dataRoot, options.runtimeConfigPath, now)) fail("FILESYSTEM_EVIDENCE_REQUIRED");
    if (!validDatabaseBoundaryEvidence(options.databaseBoundaryEvidence, database, now)) fail("DATABASE_BOUNDARY_EVIDENCE_REQUIRED");
    if (!validFirewallEvidence(options.firewallEvidence, hostSecurity, lan, now)) fail("FIREWALL_EVIDENCE_REQUIRED");
    lanReady = true;
  } else {
    if (lan.hostname !== null || lan.bindAddress !== null || lan.allowedCidrs.length !== 0 || lan.expectedClientCount !== null || lan.expectedClientSetDigest !== null ||
        Object.values(tls).some((value) => value !== null && value !== false)) {
      fail("DISABLED_LAN_MUST_NOT_HAVE_NETWORK_OR_TLS_VALUES");
    }
    const emptyHost = Object.values(hostSecurity).every((value) => value === null) && release.id === null && release.migrationDigest === null;
    if (!emptyHost) {
      if (!validRelease(release) || hostSecurity.firewallEvidencePath !== null || hostSecurity.edgeSigningPrivateKeyPath !== null ||
          !hostSecurity.filesystemEvidencePath || !hostSecurity.edgeSigningPublicKeyPath || !hostSecurity.nodeProgramPath ||
          !/^[0-9a-f]{64}$/.test(hostSecurity.nodeProgramSha256 ?? "") || !/^S-1-(?:\d+-){1,14}\d+$/.test(hostSecurity.edgeServiceSid ?? "")) {
        fail("DISABLED_LAN_CORE_PREPARATION_INVALID");
      }
      for (const value of [hostSecurity.filesystemEvidencePath, hostSecurity.rebootEvidencePath, hostSecurity.edgeSigningPublicKeyPath, hostSecurity.nodeProgramPath, database.boundaryEvidencePath]) {
        requireAbsoluteLocalPath(value, "DISABLED_LAN_CORE_PATH_REQUIRED");
      }
      if (!validFilesystemEvidence(options.filesystemEvidence, input, dataRoot, options.runtimeConfigPath, now)) fail("FILESYSTEM_EVIDENCE_REQUIRED");
      if (!validDatabaseBoundaryEvidence(options.databaseBoundaryEvidence, database, now)) fail("DATABASE_BOUNDARY_EVIDENCE_REQUIRED");
      corePrepared = true;
    }
  }
  if (tls.hstsEnabled && !lanReady) fail("HSTS_REQUIRES_TRUSTED_LAN");

  const restoreVerified = validRestoreEvidence(options.restoreEvidence, options.restoreReceiptPublicKey, input.backup, input.release, dataRoot, input.database, options.backupTargetEvidence, options.filesystemEvidence, now);
  const currentRecoveryVerified = validCurrentRecoveryEvidence(options.recoveryEvidence, options.runtimeConfigSha256, options.databaseBoundaryEvidence, options.latestBackupEvidence, now);
  const disasterRecoveryVerified = validDisasterRecoveryEvidence(options.disasterRecoveryEvidence, options.recoveryEvidence, options.runtimeConfigSha256, options.databaseBoundaryEvidence, options.latestBackupEvidence, now);
  const recoveryVerified = currentRecoveryVerified && disasterRecoveryVerified;
  const databaseVerified = validDatabaseBoundaryEvidence(options.databaseBoundaryEvidence, database, now);
  const rebootVerified = validRebootEvidence(options.rebootEvidence, input, dataRoot, options.backupScheduleEvidence, options.recoveryEvidence, options.runtimeConfigSha256, now, options.bootedAt);
  const preEdgeReady = databaseVerified && backupConfigured && restoreVerified && recoveryVerified && lanReady;
  return Object.freeze({
    ...input,
    data: { root: dataRoot },
    network: Object.freeze({
      webBind: "127.0.0.1",
      apiBind: "127.0.0.1",
      databaseOutboundHost: database.host,
      databaseOutboundPort: database.port,
      databaseTlsMode: "verify-full",
      corePrepared,
      lanReady
    }),
    readiness: Object.freeze({
      backupConfigured,
      backupTargetVerified,
      backupScheduleVerified,
      latestBackupVerified,
      restoreVerified,
      currentRecoveryVerified,
      disasterRecoveryVerified,
      recoveryVerified,
      databaseVerified,
      rebootVerified,
      preEdgeReady,
      operationalReady: preEdgeReady && rebootVerified
    })
  });
}

function validClientTrustEvidence(evidence, tls, lan, now) {
  if (!evidence || !plainObject(evidence)) return false;
  return evidence.version === 4 && evidence.result === "PASS" && evidence.phase === "PREOPEN" && evidence.hostname === lan.hostname && evidence.releaseId === null &&
    typeof evidence.caThumbprint === "string" && /^[A-Fa-f0-9]{40,64}$/.test(evidence.caThumbprint) &&
    /^[0-9a-f]{64}$/.test(evidence.serverCertificateSha256 ?? "") &&
    evidence.verifiedClientCount === lan.expectedClientCount && evidence.clientSetDigest === lan.expectedClientSetDigest && evidence.clientAddressMappingVerified === true && evidence.clientAddressOwnershipVerified === true && /^[0-9a-f]{64}$/.test(evidence.verificationPlanSetDigest ?? "") && Array.isArray(evidence.allowedClientCidrs) && [...evidence.allowedClientCidrs].sort().join("|") === [...lan.allowedCidrs].sort().join("|") && evidence.httpsVerified === false &&
    recentTimestamp(evidence.completedAt, now, 30 * 24 * 3600_000);
}

function validBackupTargetEvidence(evidence, backup, dataRoot, filesystemEvidence, now) {
  if (!backup.physicalTargetEvidencePath || !evidence || !plainObject(evidence)) return false;
  if (evidence.result !== "PASS" || evidence.dataRoot !== path.resolve(dataRoot) || evidence.backupRoot !== path.resolve(backup.root)) return false;
  if (evidence.version !== 7 || typeof evidence.nasIdentityHelperPath !== "string" || !path.isAbsolute(evidence.nasIdentityHelperPath) || !/^[0-9a-f]{64}$/.test(evidence.nasIdentityHelperSha256 ?? "") || evidence.backupWriterSid !== filesystemEvidence?.backupSid || evidence.signerReaderSid !== filesystemEvidence?.signerSid || evidence.separateReceiptSigner !== true || !evidence.appServiceDenied || !evidence.edgeServiceDenied || !evidence.separateBackupWriter ||
      evidence.aclProtected !== true || evidence.exactAcl !== true || evidence.encryptedAtRestOrTransport !== true || !new Set(["BITLOCKER_FULLY_ENCRYPTED","SMB_3_1_1_ENCRYPTED"]).has(evidence.encryptionProof) || !recentTimestamp(evidence.completedAt, now, 30 * 24 * 3600_000)) return false;
  if (evidence.targetType === "NAS") return typeof evidence.nasServer === "string" && validHostname(evidence.nasServer) && typeof evidence.nasShare === "string" && /^[^\\/:*?"<>|\x00-\x1f]{1,80}$/.test(evidence.nasShare) &&
    /^[0-9a-f]{64}$/.test(evidence.nasServerIdentitySha256 ?? "") && Number.isInteger(evidence.nasResolvedAddressCount) && evidence.nasResolvedAddressCount > 0 && evidence.nasResolvedAddressCount <= 64 &&
    evidence.nasLocalAliasRejected === true && evidence.nasShareAclAdministrativelyConfirmed === true && evidence.retentionControl === "SNAPSHOT_OR_VERSIONING";
  return evidence.targetType === "LOCAL_DISK" && Number.isInteger(evidence.dataDiskNumber) && Number.isInteger(evidence.backupDiskNumber) &&
    evidence.dataDiskNumber !== evidence.backupDiskNumber && evidence.dataDiskUniqueId !== evidence.backupDiskUniqueId && evidence.nasServer === null && evidence.nasShare === null &&
    evidence.nasServerIdentitySha256 === null && evidence.nasResolvedAddressCount === null && evidence.nasLocalAliasRejected === false && evidence.nasShareAclAdministrativelyConfirmed === false && evidence.retentionControl === "OFFLINE_ROTATION";
}

function validBackupScheduleEvidence(evidence, backup, targetEvidence, targetEvidenceSha256, filesystemEvidence, runtimeConfigSha256, now) {
  if (evidence?.runtimeConfigSha256 !== runtimeConfigSha256 || evidence?.runtimeReadinessBound !== true || evidence?.recurringInvocationPlanBound !== true) return false;
  return Boolean(backup.scheduledTaskEvidencePath && evidence?.version === 8 && evidence?.result === "PASS" && evidence.taskName === "Meta Ads Performance Daily Backup" && evidence.receiptTaskName === "Meta Ads Performance Backup Receipt Publisher" &&
    evidence.dailyTime === backup.dailyTime && evidence.separatePrincipal === true && evidence.scriptHashVerified === true && evidence.scheduledAuthorizationVersion === 3 && evidence.scheduledAuthorizationBound === true && /^[0-9a-f]{64}$/.test(evidence.scheduledAuthorizationSha256 ?? "") && /^[0-9a-f]{64}$/.test(targetEvidenceSha256 ?? "") && evidence.backupTargetEvidenceSha256 === targetEvidenceSha256 && evidence.backupTargetFingerprint === backupTargetFingerprint(targetEvidence) && path.resolve(evidence.backupRoot ?? "") === path.resolve(backup.root) &&
    evidence.dailyTriggerVerified === true && evidence.dailyTriggerEnabled === true && evidence.daysInterval === 1 && evidence.receiptPublisherRecurringVerified === true && evidence.receiptPublisherIntervalMinutes === 15 && Number.isSafeInteger(evidence.maximumDatabaseDumpBytes) && evidence.maximumDatabaseDumpBytes >= 1048576 && evidence.maximumDatabaseDumpBytes <= 274877906944 && evidence.maximumBackupDurationSeconds === 14400 && evidence.backupSafetyMarginBytes === 1073741824 && evidence.databaseSizePreflightRequired === true && evidence.databaseDumpRealtimeCapRequired === true && evidence.databaseDumpFinalCapRequired === true && evidence.hardDeadlineRequired === true && evidence.processTreeKillOnDeadlineRequired === true && evidence.incompleteStagingCleanupRequired === true && evidence.receiptSigningDelegatedToDistinctSigner === true && evidence.signerHashVerified === true && evidence.executorHashesVerified === true && evidence.boundedChildProcesses === true && evidence.powerShell7Verified === true && typeof evidence.powerShellPath === "string" && typeof evidence.nasIdentityHelperPath === "string" && path.resolve(evidence.nasIdentityHelperPath) === path.resolve(targetEvidence?.nasIdentityHelperPath ?? "") && evidence.nasIdentityHelperSha256 === targetEvidence?.nasIdentityHelperSha256 && [evidence.powerShellSha256,evidence.actionArgumentsSha256,evidence.receiptPublisherActionArgumentsSha256,evidence.publisherBrokerSha256,evidence.backupScriptSha256,evidence.releaseVerifierSha256,evidence.releaseManifestSha256,evidence.attestationVerifierSha256,evidence.nodeSha256,evidence.psqlSha256,evidence.pgDumpSha256,evidence.pgPassSha256,evidence.backupIntegrityKeySha256,evidence.backupReceiptPrivateKeySha256,evidence.receiptPublisherSha256,evidence.semanticSignerSha256,evidence.nasIdentityHelperSha256,evidence.executorSetDigest,evidence.filesystemEvidenceSha256].every((value)=>/^[0-9a-f]{64}$/.test(value??"")) && evidence.executorSetDigest === sha256Tuple(evidence.nodeSha256,evidence.psqlSha256,evidence.pgDumpSha256) && evidence.enabled === true && evidence.startWhenAvailable === true && evidence.backupSid === targetEvidence?.backupWriterSid && evidence.backupSid === filesystemEvidence?.backupSid && evidence.signerSid === targetEvidence?.signerReaderSid && evidence.signerSid === filesystemEvidence?.signerSid &&
    recentTimestamp(evidence.completedAt, now, 30 * 24 * 3600_000));
}
function validLatestBackupEvidence(evidence, publicKey, release, backup, dataRoot, database, targetEvidence, scheduleEvidence, now) {
  const targetFingerprint = backupTargetFingerprint(targetEvidence);
  const configFingerprint = backupConfigFingerprint(release, backup, dataRoot, database, targetFingerprint);
  return Boolean(backup.latestBackupEvidencePath && evidence?.version === 6 && evidence?.result === "COMPLETE" &&
    evidence.attestationType === "backup-latest" && verifyAttestation(evidence, publicKey) && evidence.signerIndependentArtifactVerification === true && /^[0-9a-f]{64}$/.test(evidence.artifactVerificationDigest ?? "") &&
    typeof evidence.backupId === "string" && /^[0-9A-Za-z-]{20,80}$/.test(evidence.backupId) &&
    evidence.releaseId === release.id && evidence.sourceDataRoot === path.resolve(dataRoot) && evidence.backupRoot === path.resolve(backup.root) &&
    evidence.databaseProvider === "supabase_postgres" && evidence.databaseProjectRef === database.projectRef && evidence.databaseHost === database.host && evidence.databasePort === database.port &&
    evidence.databaseName === database.name && evidence.databaseSchema === database.schema &&
    Number.isSafeInteger(evidence.databaseDumpBytes) && evidence.databaseDumpBytes >= 1024 && Number.isSafeInteger(evidence.maximumDatabaseDumpBytes) && evidence.databaseDumpBytes <= evidence.maximumDatabaseDumpBytes && evidence.maximumDatabaseDumpBytes === scheduleEvidence?.maximumDatabaseDumpBytes && evidence.maximumBackupDurationSeconds === 14400 && evidence.maximumBackupDurationSeconds === scheduleEvidence?.maximumBackupDurationSeconds && evidence.backupSafetyMarginBytes === 1073741824 && evidence.backupSafetyMarginBytes === scheduleEvidence?.backupSafetyMarginBytes && Number.isInteger(evidence.elapsedSeconds) && evidence.elapsedSeconds >= 0 && evidence.elapsedSeconds <= evidence.maximumBackupDurationSeconds && evidence.databaseSizePreflightVerified === true && evidence.databaseDumpRealtimeCapEnforced === true && evidence.databaseDumpFinalCapVerified === true && evidence.hardDeadlineEnforced === true && evidence.processTreeKillOnDeadline === true && evidence.incompleteStagingCleanupContract === true &&
    evidence.migrationDigest === release.migrationDigest && /^[0-9a-f]{64}$/.test(evidence.appliedMigrationDigest ?? "") &&
    evidence.targetEvidenceFingerprint === targetFingerprint && evidence.configFingerprint === configFingerprint &&
    /^[0-9a-f]{64}$/.test(evidence.integrityKeyId ?? "") && /^[0-9a-f]{64}$/.test(evidence.storageReferenceDigest ?? "") &&
    /^[0-9a-f]{64}$/.test(evidence.manifestSha256 ?? "") && /^[0-9a-f]{64}$/.test(evidence.integritySignature ?? "") &&
    [evidence.nodeSha256,evidence.psqlSha256,evidence.pgDumpSha256,evidence.executorSetDigest,evidence.filesystemEvidenceSha256].every((value)=>/^[0-9a-f]{64}$/.test(value??"")) && evidence.executorSetDigest === sha256Tuple(evidence.nodeSha256,evidence.psqlSha256,evidence.pgDumpSha256) &&
    evidence.pgPassSha256 === scheduleEvidence?.pgPassSha256 && evidence.backupIntegrityKeySha256 === scheduleEvidence?.backupIntegrityKeySha256 && evidence.backupReceiptPrivateKeySha256 === scheduleEvidence?.backupReceiptPrivateKeySha256 && evidence.receiptPublisherSha256 === scheduleEvidence?.receiptPublisherSha256 && evidence.semanticSignerSha256 === scheduleEvidence?.semanticSignerSha256 && evidence.nasIdentityHelperSha256 === scheduleEvidence?.nasIdentityHelperSha256 && evidence.nodeSha256 === scheduleEvidence?.nodeSha256 && evidence.psqlSha256 === scheduleEvidence?.psqlSha256 && evidence.pgDumpSha256 === scheduleEvidence?.pgDumpSha256 && evidence.executorSetDigest === scheduleEvidence?.executorSetDigest && evidence.filesystemEvidenceSha256 === scheduleEvidence?.filesystemEvidenceSha256 &&
    recentTimestamp(evidence.completedAt, now, 24 * 3600_000));
}
function validRelease(release) {
  return typeof release.id === "string" && /^[a-z0-9][a-z0-9._-]{0,62}$/.test(release.id) &&
    typeof release.migrationDigest === "string" && /^[0-9a-f]{64}$/.test(release.migrationDigest);
}
export function rebootContractFingerprint(config, resolvedDataRoot = resolveDataRoot(config.data.root)) {
  const database=config.database,backup=config.backup,host=config.hostSecurity;
  return sha256Tuple("reboot-core-v1",config.deploymentMode,String(config.internalPorts.web),String(config.internalPorts.api),database.provider,database.projectRef,database.connectionMode,database.host,String(database.port),database.name,database.runtimeUser,database.schema,database.caCertificateSha256,path.resolve(resolvedDataRoot),config.release.id,config.release.migrationDigest,backup.root?path.resolve(backup.root):"",backup.dailyTime??"",String(backup.rpoHours),String(backup.rtoHours),host.nodeProgramSha256,host.edgeServiceSid);
}
function validRebootEvidence(evidence, config, dataRoot, scheduleEvidence, recoveryEvidence, runtimeConfigSha256, now, bootedAt) {
  const bootTime=bootedAt instanceof Date?bootedAt.getTime():Number(bootedAt);
  const completed=Date.parse(evidence?.completedAt??"");
  const evidenceBoot=Date.parse(evidence?.bootedAt??"");
  const modeValid=(evidence?.mode==="CORE_ONLY_CLI_BOOTSTRAP"&&evidence?.readinessMode==="core-prepared")||(evidence?.mode==="PRE_EDGE_LAN"&&evidence?.readinessMode==="pre-edge");
  const networkModeValid=(evidence?.mode==="PRE_EDGE_LAN")===config.lan.enabled;
  return evidence?.version===3 && evidence?.result==="PASS" && modeValid && networkModeValid &&
    evidence.releaseId===config.release.id && evidence.migrationDigest===config.release.migrationDigest && evidence.releaseManifestSha256===scheduleEvidence?.releaseManifestSha256 &&
    evidence.rebootContractFingerprint===rebootContractFingerprint(config,dataRoot) && evidence.sourceRuntimeConfigSha256===runtimeConfigSha256 && /^[0-9a-f]{64}$/.test(evidence.sourceRuntimeConfigSha256??"") &&
    /^[0-9a-f]{64}$/.test(evidence.hostInstanceDigest??"") && evidence.hostInstanceDigest===recoveryEvidence?.sourceHostInstanceDigest &&
    evidence.coreAutomatic===true && evidence.edgeAutomatic===false && evidence.edgeStoppedFailClosed===true && evidence.supabaseDatabaseReadyAfterBoot===true &&
    evidence.principalRightsVerifiedAfterBoot===true && evidence.listenerOwnershipVerified===true && evidence.loopbackInternalPorts===true && evidence.httpsReleaseVerified===false && evidence.pinnedCaAndSniVerified===false &&
    evidence.forbiddenPortListenersAbsent===true && evidence.backupTaskReady===Boolean(config.backup.root) && evidence.backupTaskExactConfigurationVerified===Boolean(config.backup.root) && evidence.backupDailyTriggerEnabled===Boolean(config.backup.root) && evidence.latestBackupFresh===Boolean(config.backup.root) &&
    evidence.signedRuntimeReadinessVerified===true && Number.isFinite(bootTime) && Number.isFinite(evidenceBoot) && Math.abs(evidenceBoot-bootTime)<=5*60_000 && Number.isFinite(completed) && completed>=bootTime && completed>=evidenceBoot && recentTimestamp(evidence.completedAt,now,30*24*3600_000);
}
function backupTargetFingerprint(evidence) {
  if (!plainObject(evidence)) return null;
  return createHash("sha256").update(["8",evidence.result,evidence.targetType,evidence.dataRoot,evidence.backupRoot,evidence.dataDiskUniqueId ?? "",evidence.backupDiskUniqueId ?? "",evidence.nasIdentityHelperSha256 ?? "",evidence.nasServer ?? "",evidence.nasShare ?? "",evidence.nasServerIdentitySha256 ?? "",String(evidence.nasResolvedAddressCount ?? ""),String(evidence.nasLocalAliasRejected === true),String(evidence.nasShareAclAdministrativelyConfirmed === true),evidence.backupWriterSid,evidence.signerReaderSid,evidence.encryptionProof,evidence.retentionControl,evidence.completedAt].join("\n")).digest("hex");
}
function backupConfigFingerprint(release, backup, dataRoot, database, targetFingerprint) {
  if (!targetFingerprint) return null;
  return createHash("sha256").update(["2",release.id,release.migrationDigest,path.resolve(dataRoot),path.resolve(backup.root),backup.dailyTime,database.provider,database.projectRef,database.connectionMode,database.host,String(database.port),database.name,database.runtimeUser,database.migrationUser,database.backupUser,database.restoreUser,database.schema,database.caCertificateSha256,"24","4",targetFingerprint].join("\n")).digest("hex");
}
function validFilesystemEvidence(evidence, config, dataRoot, runtimeConfigPath, now) {
  const roots = evidence?.classRoots;
  const requiredClasses = ["CORE_MODIFY","CORE_READ","EDGE_MODIFY","EDGE_READ","SHARED_RUNTIME","ADMIN_EVIDENCE","BACKUP_RECEIPT","BACKUP_ONLY","SIGNER_ONLY","SIGNER_STATE","ADMIN_ONLY"];
  if (!plainObject(roots) || Object.keys(roots).sort().join("|") !== [...requiredClasses].sort().join("|") ||
      requiredClasses.some((name) => !Array.isArray(roots[name]) || roots[name].length === 0 || roots[name].some((root) => typeof root !== "string" || !path.isAbsolute(root)))) return false;
  const adminEvidencePaths = [config.hostSecurity.filesystemEvidencePath, config.database.boundaryEvidencePath,
    config.hostSecurity.firewallEvidencePath,config.hostSecurity.rebootEvidencePath,
    config.tls.clientTrustEvidencePath, config.backup.physicalTargetEvidencePath, config.backup.scheduledTaskEvidencePath,
    config.backup.restoreEvidencePath,config.backup.recoveryEvidencePath,config.backup.disasterRecoveryEvidencePath].filter(Boolean);
  const covered = classContains(path.join(dataRoot,"storage"),roots.CORE_MODIFY) &&
    classContains(path.join(dataRoot,"runtime-control"),roots.EDGE_READ) &&
    [config.tls.serverPrivateKeyPath,config.hostSecurity.edgeSigningPrivateKeyPath].filter(Boolean).every((item)=>classContains(item,roots.EDGE_READ)) &&
    [config.hostSecurity.edgeSigningPublicKeyPath,config.hostSecurity.nodeProgramPath,config.backup.backupReceiptPublicKeyPath,config.backup.restoreReceiptPublicKeyPath,runtimeConfigPath].filter(Boolean).every((item)=>classContains(item,roots.SHARED_RUNTIME)) &&
    adminEvidencePaths.every((item)=>classContains(item,roots.ADMIN_EVIDENCE)) &&
    (!config.backup.latestBackupEvidencePath || classContains(config.backup.latestBackupEvidencePath,roots.BACKUP_RECEIPT));
  return covered && evidence?.result === "PASS" && path.resolve(evidence.dataRoot ?? "") === path.resolve(dataRoot) &&
    evidence.nonReparse === true && evidence.leastPrivilege === true && evidence.exactAcl === true && evidence.filesystem === "NTFS" &&
    /^[A-Z0-9-]+$/.test(evidence.coreServiceSid ?? "") && /^[A-Z0-9-]+$/.test(evidence.edgeServiceSid ?? "") && /^[A-Z0-9-]+$/.test(evidence.backupSid ?? "") && /^[A-Z0-9-]+$/.test(evidence.signerSid ?? "") &&
    evidence.edgeServiceSid === config.hostSecurity.edgeServiceSid &&
    new Set([evidence.coreServiceSid,evidence.edgeServiceSid,evidence.backupSid,evidence.signerSid]).size === 4 &&
    typeof evidence.descriptorDigest === "string" && /^[0-9a-f]{64}$/.test(evidence.descriptorDigest) &&
    recentTimestamp(evidence.completedAt, now, 30 * 24 * 3600_000);
}
function classContains(candidate, roots) { return typeof candidate === "string" && roots.some((root) => sameOrNested(candidate,root)); }
function validDatabaseBoundaryEvidence(evidence, database, now) {
  return evidence?.version === 6 && evidence?.result === "PASS" && evidence.provider === "supabase_postgres" &&
    evidence.projectRef === database.projectRef && evidence.connectionMode === database.connectionMode && evidence.host === database.host && evidence.port === database.port &&
    evidence.sslMode === "verify-full" && evidence.tlsVerified === true && evidence.hostnameVerified === true && evidence.caVerified === true &&
    evidence.caCertificateSha256 === database.caCertificateSha256 && evidence.executorHashesVerified === true && /^[0-9a-f]{64}$/.test(evidence.psqlSha256 ?? "") && evidence.pgStatSsl === true && ["TLSv1.2","TLSv1.3"].includes(evidence.tlsProtocol) &&
    typeof evidence.tlsCipher === "string" && evidence.tlsCipher.length > 0 && evidence.publicRemoteEndpoint === true &&
    evidence.runtimeDdlDenied === true && evidence.roleAttributesRestricted === true && evidence.boundedConnectionLimits === true && evidence.scramCredentialsVerified === true && evidence.runtimeObjectOwnershipDenied === true &&
    evidence.roleMembershipsAbsent === true && evidence.privilegeContractVerified === true && evidence.sequencePrivilegesVerified === true && evidence.functionEscalationAbsent === true && evidence.defaultPrivilegesVerified === true && evidence.migrationOwnershipVerified === true && evidence.migrationRoleFullDataPrivileged === true && evidence.migrationCredentialAdminOnly === true && evidence.migrationCredentialMaintenanceOnly === true && evidence.migrationTableProtected === true && evidence.crossSchemaPrivilegesAbsent === true && evidence.credentialsDistinct === true && evidence.crossRoleAuthenticationDenied === true && evidence.productionRestoreRoleAccessAbsent === true && evidence.auditAppendOnlyGuardVerified === true &&
    evidence.databaseName === database.name && evidence.databaseUser === database.runtimeUser && evidence.databaseSchema === database.schema &&
    [evidence.runtimeRoleDigest,evidence.migrationRoleDigest,evidence.backupRoleDigest,evidence.restoreRoleDigest].every((value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value)) &&
    evidence.runtimeRoleDigest === roleDigest(database.runtimeUser) && evidence.migrationRoleDigest === roleDigest(database.migrationUser) && evidence.backupRoleDigest === roleDigest(database.backupUser) && evidence.restoreRoleDigest === roleDigest(database.restoreUser) &&
    recentTimestamp(evidence.completedAt, now, 30 * 24 * 3600_000);
}
function roleDigest(value) { return createHash("sha256").update(value,"utf8").digest("hex"); }
function sha256Tuple(...values) { return createHash("sha256").update(values.join("\n"),"utf8").digest("hex"); }
function validFirewallEvidence(evidence, hostSecurity, lan, now) {
  const expectedCidrs = [...lan.allowedCidrs].sort();
  return evidence?.version === 4 && evidence?.result === "PASS" && evidence.ruleName === "MetaAdsPerformance-Https443-PrivateLan" &&
    evidence.bindAddress === lan.bindAddress && Array.isArray(evidence.allowedCidrs) &&
    [...evidence.allowedCidrs].sort().join("|") === expectedCidrs.join("|") &&
    evidence.exactClientAddresses === true && Array.isArray(evidence.protectedPorts) && evidence.protectedPorts.join("|") === "443|3100|3200|4100|4200|5432|55432|6543" &&
    path.resolve(evidence.nodeProgramPath ?? "") === path.resolve(hostSecurity.nodeProgramPath) &&
    evidence.nodeProgramSha256 === hostSecurity.nodeProgramSha256 && evidence.edgeServiceName === "MetaAdsPerformanceEdge" && evidence.edgeServiceSid === hostSecurity.edgeServiceSid && evidence.serviceRestricted === true &&
    evidence.publicProfileOpened === false && evidence.conflictingAllowRulesAbsent === true && evidence.internalPortsDenied === true && evidence.allProfilesEnabled === true && evidence.defaultInboundBlocked === true &&
    recentTimestamp(evidence.completedAt, now, 30 * 24 * 3600_000);
}

export function defaultDataRoot(env = process.env) {
  if (platform() === "win32") {
    const base = env.PROGRAMDATA?.trim() || env.LOCALAPPDATA?.trim();
    if (!base) fail("OS_APPLICATION_DATA_ROOT_UNAVAILABLE");
    return path.resolve(base, "MetaAdsPerformance");
  }
  if (platform() === "darwin") return path.resolve(homedir(), "Library", "Application Support", "MetaAdsPerformance");
  return path.resolve(env.XDG_DATA_HOME?.trim() || path.join(homedir(), ".local", "share"), "meta-ads-performance");
}

function resolveDataRoot(value, env) {
  const result = value === null ? defaultDataRoot(env) : value;
  requireAbsoluteLocalPath(result, "DATA_ROOT_INVALID");
  return path.resolve(result);
}

function validatePorts(value) {
  exactObject(value, ["web", "api"]);
  for (const key of ["web", "api"]) {
    if (!Number.isInteger(value[key]) || value[key] < 1024 || value[key] > 65535) fail("INTERNAL_PORT_INVALID");
  }
  if (value.web !== 3200 || value.api !== 4200) fail("LOCAL_INTERNAL_PORT_CONTRACT_REQUIRED");
}
function validateDatabase(value) {
  if (value.provider !== "supabase_postgres" || !/^[a-z]{20}$/.test(value.projectRef ?? "") ||
      !new Set(["direct","session_pooler"]).has(value.connectionMode) || !validHostname(value.host) ||
      value.port !== 5432 || !databaseIdentifier(value.name) || !databaseIdentifier(value.runtimeUser) || !databaseIdentifier(value.migrationUser) || !databaseIdentifier(value.backupUser) || !databaseIdentifier(value.restoreUser) || !databaseIdentifier(value.schema) ||
      new Set([value.runtimeUser,value.migrationUser,value.backupUser,value.restoreUser]).size !== 4) {
    fail("SUPABASE_DATABASE_CONFIG_INVALID");
  }
  if (value.connectionMode === "direct" && value.host !== `db.${value.projectRef}.supabase.co`) fail("SUPABASE_DIRECT_HOST_MISMATCH");
  if (value.connectionMode === "session_pooler" && !/^[a-z0-9-]+\.pooler\.supabase\.com$/.test(value.host)) fail("SUPABASE_POOLER_HOST_INVALID");
  requireAbsoluteLocalPath(value.caCertificatePath, "SUPABASE_DATABASE_CA_PATH_REQUIRED");
  if (!/^[0-9a-f]{64}$/.test(value.caCertificateSha256 ?? "")) fail("SUPABASE_DATABASE_CA_HASH_REQUIRED");
  requireAbsoluteLocalPath(value.boundaryEvidencePath, "DATABASE_BOUNDARY_EVIDENCE_PATH_REQUIRED");
}

function validCurrentRecoveryEvidence(evidence, runtimeConfigSha256, databaseEvidence, latestBackupEvidence, now) {
  return evidence?.version === 6 && evidence?.result === "PASS" && evidence.proofType === "current-host-recovery" && evidence.recoveryContractDigest === recoveryContractFingerprint(evidence) && /^[0-9a-f]{64}$/.test(evidence.sourceHostInstanceDigest ?? "") && evidence.verificationHostInstanceDigest === evidence.sourceHostInstanceDigest && /^[0-9a-f]{64}$/.test(evidence.escrowIdentitySha256 ?? "") && new Set(["REMOTE_NAS","SEPARATE_LOCAL_VOLUME"]).has(evidence.escrowType) && Number.isInteger(evidence.escrowAddressCount) && evidence.escrowAddressCount >= 0 && evidence.escrowLocalAliasRejected === true && evidence.exactInventory === true && evidence.authenticatedExtract === true && evidence.boundedExtract === true && evidence.currentInstallBound === true && evidence.currentSourceHashesVerified === true && evidence.disasterRecoveryVerified === false && evidence.sourcePathsDisclosed === false && evidence.extractionRetained === false &&
    evidence.localCopyPresent === true && evidence.escrowCopyPresent === true && evidence.escrowSeparated === true && evidence.copiesMatch === true &&
    evidence.adminOnlyAcl === true && evidence.testExtractRemoved === true && evidence.pfxPrivateKeyVerified === true && evidence.caIdentityVerified === true && evidence.signingKeyPairsVerified === true && evidence.fileCount === 16 && /^[0-9a-f]{64}$/.test(evidence.signingKeyPairInventoryDigest ?? "") && evidence.boundedConcurrentChildOutput === true && evidence.processTreeKillOnDeadline === true &&
    typeof runtimeConfigSha256 === "string" && /^[0-9a-f]{64}$/.test(runtimeConfigSha256) && evidence.runtimeConfigSha256 === runtimeConfigSha256 &&
    [evidence.inventoryDigest,evidence.kitId,evidence.kitSha256,evidence.localKitSha256,evidence.escrowKitSha256,evidence.worksheetSha256,evidence.localWorksheetSha256,evidence.escrowWorksheetSha256].every((value)=>/^[0-9a-f]{64}$/.test(value??"")) && evidence.kitId === evidence.kitSha256 && evidence.localKitSha256 === evidence.escrowKitSha256 && evidence.kitId === evidence.localKitSha256 && evidence.worksheetSha256 === evidence.localWorksheetSha256 && evidence.worksheetSha256 === evidence.escrowWorksheetSha256 &&
    /^[0-9a-f]{64}$/.test(evidence.manifestSha256 ?? "") && evidence.databaseCredentialInventoryDigest === databaseEvidence?.credentialInventoryDigest &&
    [evidence.nodeSha256,evidence.toolSha256,evidence.executorSetDigest].every((value)=>/^[0-9a-f]{64}$/.test(value??"")) && evidence.executorSetDigest === sha256Tuple(evidence.nodeSha256,evidence.toolSha256) && evidence.nodeSha256 === latestBackupEvidence?.nodeSha256 &&
    evidence.backupIntegrityKeySha256 === latestBackupEvidence?.integrityKeyId && recentTimestamp(evidence.completedAt, now, 30 * 24 * 3600_000);
}
function validDisasterRecoveryEvidence(evidence, currentEvidence, runtimeConfigSha256, databaseEvidence, latestBackupEvidence, now) {
  return evidence?.version === 6 && evidence?.result === "PASS" && evidence.proofType === "clean-pc-disaster-recovery" && evidence.recoveryContractDigest === recoveryContractFingerprint(evidence) && /^[0-9a-f]{64}$/.test(evidence.sourceHostInstanceDigest ?? "") && /^[0-9a-f]{64}$/.test(evidence.verificationHostInstanceDigest ?? "") && evidence.verificationHostInstanceDigest !== evidence.sourceHostInstanceDigest && /^[0-9a-f]{64}$/.test(evidence.escrowIdentitySha256 ?? "") && new Set(["REMOTE_NAS","SEPARATE_LOCAL_VOLUME"]).has(evidence.escrowType) && Number.isInteger(evidence.escrowAddressCount) && evidence.escrowAddressCount >= 0 && evidence.escrowLocalAliasRejected === true && evidence.exactInventory === true && evidence.authenticatedExtract === true && evidence.boundedExtract === true && evidence.currentInstallBound === false && evidence.currentSourceHashesVerified === false && evidence.disasterRecoveryVerified === true && evidence.sourcePathsDisclosed === false && evidence.extractionRetained === true &&
    evidence.localCopyPresent === false && evidence.escrowCopyPresent === true && evidence.escrowWorksheetPresent === true && evidence.escrowSeparated === false && evidence.copiesMatch === false && evidence.adminOnlyAcl === true && evidence.testExtractRemoved === false && evidence.pfxPrivateKeyVerified === true && evidence.caIdentityVerified === false && evidence.signingKeyPairsVerified === true && evidence.fileCount === 16 && /^[0-9a-f]{64}$/.test(evidence.signingKeyPairInventoryDigest ?? "") && evidence.boundedConcurrentChildOutput === true && evidence.processTreeKillOnDeadline === true &&
    typeof runtimeConfigSha256 === "string" && /^[0-9a-f]{64}$/.test(runtimeConfigSha256) && evidence.runtimeConfigSha256 === runtimeConfigSha256 &&
    [evidence.inventoryDigest,evidence.kitId,evidence.kitSha256,evidence.manifestSha256,evidence.worksheetSha256,evidence.escrowWorksheetSha256,evidence.escrowKitSha256].every((value)=>/^[0-9a-f]{64}$/.test(value??"")) && evidence.kitId === evidence.kitSha256 && evidence.kitId === evidence.escrowKitSha256 && evidence.worksheetSha256 === evidence.escrowWorksheetSha256 &&
    evidence.databaseCredentialInventoryDigest === databaseEvidence?.credentialInventoryDigest && [evidence.nodeSha256,evidence.toolSha256,evidence.executorSetDigest].every((value)=>/^[0-9a-f]{64}$/.test(value??"")) && evidence.executorSetDigest === sha256Tuple(evidence.nodeSha256,evidence.toolSha256) && evidence.nodeSha256 === latestBackupEvidence?.nodeSha256 && evidence.backupIntegrityKeySha256 === latestBackupEvidence?.integrityKeyId &&
    currentEvidence?.version === 6 && evidence.sourceHostInstanceDigest === currentEvidence.sourceHostInstanceDigest && currentEvidence.verificationHostInstanceDigest === currentEvidence.sourceHostInstanceDigest && evidence.verificationHostInstanceDigest !== currentEvidence.verificationHostInstanceDigest && evidence.escrowType === currentEvidence.escrowType && evidence.escrowIdentitySha256 === currentEvidence.escrowIdentitySha256 && evidence.escrowAddressCount === currentEvidence.escrowAddressCount && evidence.kitId === currentEvidence.kitId && evidence.manifestSha256 === currentEvidence.manifestSha256 && evidence.installId === currentEvidence.installId && evidence.runtimeConfigSha256 === currentEvidence.runtimeConfigSha256 && evidence.inventoryDigest === currentEvidence.inventoryDigest && evidence.signingKeyPairInventoryDigest === currentEvidence.signingKeyPairInventoryDigest && evidence.databaseCredentialInventoryDigest === currentEvidence.databaseCredentialInventoryDigest && evidence.backupIntegrityKeySha256 === currentEvidence.backupIntegrityKeySha256 && evidence.executorSetDigest === currentEvidence.executorSetDigest && evidence.escrowWorksheetSha256 === currentEvidence.escrowWorksheetSha256 &&
    recentTimestamp(evidence.completedAt, now, 30 * 24 * 3600_000);
}
function recoveryContractFingerprint(evidence) { return sha256Tuple("recovery-pair-v3",evidence?.kitId,evidence?.manifestSha256,evidence?.runtimeConfigSha256,evidence?.installId,evidence?.inventoryDigest,evidence?.signingKeyPairInventoryDigest,evidence?.escrowWorksheetSha256,evidence?.executorSetDigest,evidence?.sourceHostInstanceDigest,evidence?.verificationHostInstanceDigest,evidence?.escrowType,evidence?.escrowIdentitySha256,String(evidence?.escrowAddressCount)); }
function validRestoreEvidence(evidence, publicKey, backup, release, dataRoot, database, targetEvidence, filesystemEvidence, now) {
  if (!backup.restoreEvidencePath || !evidence || !plainObject(evidence)) return false;
  const targetFingerprint = backupTargetFingerprint(targetEvidence);
  const configFingerprint = backupConfigFingerprint(release, backup, dataRoot, database, targetFingerprint);
  return evidence.version === 6 && evidence.result === "PASS" && evidence.attestationType === "restore-verification" && verifyAttestation(evidence, publicKey) && evidence.rpoHours === 24 && evidence.rtoHours === 4 &&
    typeof evidence.elapsedSeconds === "number" && evidence.elapsedSeconds <= 4 * 3600 &&
    evidence.databaseRestored === true && evidence.storageHashVerified === true && evidence.storageReferenceVerified === true &&
    evidence.businessKpiVerified === true && evidence.restoreRoleRestricted === true && evidence.restoreVerifierIdentityBound === true && evidence.isolatedDatabaseSchemaCleaned === true && evidence.isolatedDatabasePristineBeforeRestore === true && evidence.eventTriggersAbsentBeforeRestore === true && evidence.isolatedStorageRootCleaned === true && evidence.fullCatalogCleanupVerified === true && evidence.verifiedInputSnapshot === true && evidence.boundedManifestCopy === true && evidence.isolatedApiConfigsBound === true && evidence.archiveTocAllowlisted === true && evidence.hardDeadlineEnforced === true && evidence.processTreeKillOnDeadline === true &&
    evidence.uncompressedTarArchive === true && evidence.capacityReserveVerified === true && [evidence.nodeSha256,evidence.psqlSha256,evidence.pgRestoreSha256,evidence.restoreExecutorSetDigest,evidence.filesystemEvidenceSha256].every((value)=>/^[0-9a-f]{64}$/.test(value??"")) && evidence.restoreExecutorSetDigest === sha256Tuple(evidence.nodeSha256,evidence.psqlSha256,evidence.pgRestoreSha256) && /^[0-9a-f]{64}$/.test(evidence.databaseBoundaryEvidenceSha256 ?? "") && evidence.verifiedTargetDataRoot === path.resolve(dataRoot) &&
    typeof evidence.verifiedStorageRoot === "string" && sameOrNested(evidence.verifiedStorageRoot, path.join(dataRoot,"restore-verification")) && evidence.verifiedStorageRoot !== path.join(dataRoot,"restore-verification") &&
    evidence.verifiedTargetDescriptorDigest === filesystemEvidence?.descriptorDigest && evidence.releaseId === release.id &&
    evidence.databaseProvider === "supabase_postgres" && evidence.sourceDatabaseProjectRef === database.projectRef && evidence.isolatedRestoreTarget === true && typeof evidence.restoreTargetProjectRef === "string" && typeof evidence.restoreTargetDatabaseName === "string" && (evidence.restoreTargetProjectRef !== database.projectRef || evidence.restoreTargetDatabaseName !== database.name) &&
    evidence.productionDatabaseMutated === false && evidence.databaseName === database.name && evidence.databaseSchema === database.schema &&
    evidence.targetEvidenceFingerprint === targetFingerprint && evidence.configFingerprint === configFingerprint && /^[0-9a-f]{64}$/.test(evidence.integrityKeyId ?? "") &&
    evidence.migrationDigest === release.migrationDigest && /^[0-9a-f]{64}$/.test(evidence.appliedMigrationDigest ?? "") &&
    /^[0-9a-f]{64}$/.test(evidence.businessKpiDigest ?? "") && /^[0-9a-f]{64}$/.test(evidence.storageReferenceDigest ?? "") &&
    /^[0-9A-Za-z-]{20,80}$/.test(evidence.backupId ?? "") && /^[0-9a-f]{64}$/.test(evidence.backupIntegritySignature ?? "") &&
    /^[0-9a-f]{64}$/.test(evidence.backupManifestSha256 ?? "") &&
    recentTimestamp(evidence.completedAt, now, 30 * 24 * 3600_000);
}

function verifyAttestation(evidence, publicKeyBytes) {
  if (!plainObject(evidence) || !publicKeyBytes || !/^[0-9a-f]{64}$/.test(evidence.signingKeyId ?? "") || !/^[A-Za-z0-9_-]{80,128}$/.test(evidence.attestationSignature ?? "")) return false;
  try {
    const publicKey = createPublicKey(publicKeyBytes);
    if (publicKey.asymmetricKeyType !== "ed25519") return false;
    const publicDer = publicKey.export({ type: "spki", format: "der" });
    if (createHash("sha256").update(publicDer).digest("hex") !== evidence.signingKeyId) return false;
    const unsigned = { ...evidence }; delete unsigned.signingKeyId; delete unsigned.attestationSignature;
    return verify(null, Buffer.from(canonicalJson(unsigned), "utf8"), publicKey, Buffer.from(evidence.attestationSignature, "base64url"));
  } catch { return false; }
}
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (plainObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function recentTimestamp(value, now, maximumAgeMs) {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed <= now + 5 * 60_000 && parsed >= now - maximumAgeMs;
}

function requireAbsoluteLocalPath(value, code) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.startsWith("\\\\")) fail(code);
}
function requireBackupPath(value, code) { if (typeof value !== "string" || (!path.isAbsolute(value) && !value.startsWith("\\\\"))) fail(code); }
function validHostname(value) { return typeof value === "string" && value.length <= 253 && /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])$/i.test(value) && isIP(value) === 0; }
function databaseIdentifier(value) { return typeof value === "string" && /^[a-z][a-z0-9_]{0,62}$/.test(value); }
function validClientIpv4Cidr(value) { if (typeof value !== "string") return false; const [address, prefix, extra] = value.split("/"); return !extra && privateIpv4(address) && prefix === "32"; }
function privateIpv4(value) { if (typeof value !== "string" || isIP(value) !== 4) return false; const [a,b] = value.split(".").map(Number); return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168); }
function isLoopback(value) { return typeof value === "string" && (value === "::1" || value.startsWith("127.")); }
function ipv4InCidr(address, cidr) { const [network,prefixText] = cidr.split("/"); const prefix=Number(prefixText); const mask=(0xffffffff << (32-prefix))>>>0; return (ipv4Number(address)&mask)===(ipv4Number(network)&mask); }
function ipv4Number(value) { return value.split(".").reduce((total,part)=>((total<<8)|Number(part))>>>0,0); }
function sameOrNested(candidate, root) { const relative = path.relative(path.resolve(root), path.resolve(candidate)); return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)); }
function exactObject(value, keys) { if (!plainObject(value)) fail("CONFIG_SECTION_INVALID"); exactKeys(value, keys); }
function exactKeys(value, allowed) { const set = new Set(allowed); if (Object.keys(value).some((key) => !set.has(key)) || allowed.some((key) => !(key in value))) fail("CONFIG_KEYS_INVALID"); }
function plainObject(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
function fail(code) { throw new Error(code); }
