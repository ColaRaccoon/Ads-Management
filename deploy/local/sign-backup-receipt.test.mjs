import assert from "node:assert/strict";
import { createHash, createHmac, generateKeyPairSync } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const signerPath = path.join(import.meta.dirname, "sign-backup-receipt.mjs");
const verifierPath = path.join(import.meta.dirname, "verify-attestation.mjs");
const hex = (value) => createHash("sha256").update(value).digest("hex");
const bool = (value) => value ? "True" : "False";

function signatureInput(m) {
  return ["6",m.backupId,m.createdAt,m.backupMode,m.sourceDataRoot,m.backupRoot,m.databaseProvider,m.databaseProjectRef,m.databaseConnectionMode,m.databaseHost,String(m.databasePort),m.databaseName,m.databaseSchema,m.releaseId,m.databaseDumpSha256,String(m.databaseDumpBytes),String(m.maximumDatabaseDumpBytes),String(m.maximumBackupDurationSeconds),String(m.backupSafetyMarginBytes),String(m.elapsedSeconds),bool(m.databaseSizePreflightVerified),bool(m.databaseDumpRealtimeCapEnforced),bool(m.databaseDumpFinalCapVerified),bool(m.hardDeadlineEnforced),bool(m.processTreeKillOnDeadline),bool(m.incompleteStagingCleanupContract),m.storageManifestSha256,m.storageReferenceDigest,m.storageReferenceConversionSha256??"",String(m.storageReferenceCount),bool(m.storageReferenceZeroVerified),m.legacyBaselineSha256??"",m.legacyStorageStageEvidenceSha256??"",m.migrationDigest,m.appliedMigrationDigest,m.businessKpiDigest,m.targetEvidenceFingerprint,m.configFingerprint,String(m.fileCount),String(m.totalBytes),m.integrityKeyId,m.nodeSha256,m.psqlSha256,m.pgDumpSha256,m.executorSetDigest,m.filesystemEvidenceSha256,m.nasIdentityHelperSha256].join("\n");
}

async function fixture({ backupId = "20260828T010203Z-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", createdAt = "2026-08-28T01:02:03.1234567Z" } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "semantic-backup-receipt-"));
  const artifactRoot = path.join(root, backupId);
  const payloadRoot = path.join(artifactRoot, "storage-payload");
  await mkdir(path.join(payloadRoot, "documents"), { recursive: true });
  const dump = Buffer.from("bounded-pg-dump", "utf8");
  const payload = Buffer.from("opaque-storage-payload", "utf8");
  const storageManifest = Buffer.from(JSON.stringify([{ key:"documents/a.bin", size:payload.length, sha256:hex(payload) }]), "utf8");
  await writeFile(path.join(artifactRoot, "database.dump"), dump);
  await writeFile(path.join(artifactRoot, "storage-manifest.json"), storageManifest);
  await writeFile(path.join(payloadRoot, "documents", "a.bin"), payload);

  const receiptPair = generateKeyPairSync("ed25519");
  const authorizationPair = generateKeyPairSync("ed25519");
  const privateBytes = receiptPair.privateKey.export({ type:"pkcs8", format:"pem" });
  const publicBytes = receiptPair.publicKey.export({ type:"spki", format:"pem" });
  const receiptKeyId = hex(receiptPair.publicKey.export({ type:"spki", format:"der" }));
  const authorizationKeyId = hex(authorizationPair.publicKey.export({ type:"spki", format:"der" }));
  const privatePath = path.join(root, "receipt-private.pem");
  const publicPath = path.join(root, "receipt-public.pem");
  await writeFile(privatePath, privateBytes);
  await writeFile(publicPath, publicBytes);
  const integrityKey = Buffer.alloc(32, 0x5a);
  const integrityPath = path.join(root, "backup-integrity.key");
  await writeFile(integrityPath, integrityKey);

  const manifest = {
    version:6,result:"COMPLETE",backupId,createdAt,rpoHours:24,rtoHours:4,
    backupMode:"LOCAL_RELEASE",sourceDataRoot:path.join(root,"data"),backupRoot:root,databaseProvider:"supabase_postgres",databaseProjectRef:"abcdefghijklmnopqrst",databaseConnectionMode:"direct",databaseHost:"db.abcdefghijklmnopqrst.supabase.co",databasePort:5432,databaseName:"postgres",databaseSchema:"public",releaseId:"release-20260828",databaseDumpSha256:hex(dump),databaseDumpBytes:dump.length,maximumDatabaseDumpBytes:1048576,maximumBackupDurationSeconds:14400,backupSafetyMarginBytes:1073741824,elapsedSeconds:2,databaseSizePreflightVerified:true,databaseDumpRealtimeCapEnforced:true,databaseDumpFinalCapVerified:true,hardDeadlineEnforced:true,processTreeKillOnDeadline:true,incompleteStagingCleanupContract:true,storageManifestSha256:hex(storageManifest),storageReferenceDigest:"1".repeat(64),storageReferenceConversionSha256:null,storageReferenceCount:0,storageReferenceZeroVerified:true,legacyBaselineSha256:null,legacyStorageStageEvidenceSha256:null,migrationDigest:"2".repeat(64),appliedMigrationDigest:"3".repeat(64),businessKpiDigest:"4".repeat(64),targetEvidenceFingerprint:"5".repeat(64),configFingerprint:"6".repeat(64),fileCount:1,totalBytes:payload.length,integrityAlgorithm:"HMAC-SHA256",integrityKeyId:hex(integrityKey),integritySignature:"",nodeSha256:"7".repeat(64),psqlSha256:"8".repeat(64),pgDumpSha256:"9".repeat(64),executorSetDigest:"a".repeat(64),filesystemEvidenceSha256:"b".repeat(64),nasIdentityHelperSha256:"c".repeat(64)
  };
  manifest.integritySignature = createHmac("sha256", integrityKey).update(signatureInput(manifest), "utf8").digest("hex");
  const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
  await writeFile(path.join(artifactRoot, "backup-manifest.json"), manifestBytes);
  const request = { attestationType:"backup-latest",version:6,result:"COMPLETE",backupId,backupRoot:root,manifestSha256:hex(manifestBytes),targetEvidenceFingerprint:manifest.targetEvidenceFingerprint,backupContractSha256:"c".repeat(64),pgPassSha256:"d".repeat(64),backupIntegrityKeySha256:hex(integrityKey),backupReceiptPrivateKeySha256:hex(privateBytes),receiptPublisherSha256:"e".repeat(64),semanticSignerSha256:hex(await readFile(signerPath)),nasIdentityHelperSha256:manifest.nasIdentityHelperSha256,completedAt:manifest.createdAt };
  const requestPath = path.join(artifactRoot, "receipt-request.json");
  const requestBytes = Buffer.from(JSON.stringify(request), "utf8");
  await writeFile(requestPath, requestBytes);
  const pgRestoreSha256 = "f".repeat(64);
  const archiveEvidence = { attestationType:"backup-archive-verification",version:1,result:"PASS",backupId,databaseDumpSha256:manifest.databaseDumpSha256,databaseSchema:manifest.databaseSchema,pgRestoreSha256,archiveTocSha256:"0".repeat(64),archiveTocEntryCount:3,verifiedAt:new Date().toISOString() };
  const archiveEvidencePath = path.join(root, "archive-verification.json");
  const archiveEvidenceBytes = Buffer.from(JSON.stringify(archiveEvidence), "utf8");
  await writeFile(archiveEvidencePath, archiveEvidenceBytes);
  return { root, artifactRoot, privatePath, publicPath, privateSha256:hex(privateBytes), integrityPath, integritySha256:hex(integrityKey), requestPath, requestSha256:hex(requestBytes), receiptKeyId, authorizationKeyId, archiveEvidencePath, archiveEvidenceSha256:hex(archiveEvidenceBytes), pgRestoreSha256 };
}

test("semantic backup receipt signer independently validates a v6 artifact and signs with its own key", async () => {
  const f = await fixture();
  const outputPath = path.join(f.root, "backup-latest.json");
  const result = spawnSync(process.execPath, [signerPath,f.privatePath,f.privateSha256,f.integrityPath,f.integritySha256,f.requestPath,f.requestSha256,f.authorizationKeyId,f.archiveEvidencePath,f.archiveEvidenceSha256,f.pgRestoreSha256,outputPath], { encoding:"utf8" });
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(await readFile(outputPath, "utf8"));
  assert.equal(receipt.signingKeyId, f.receiptKeyId);
  assert.equal(receipt.authorizationSigningKeyId, f.authorizationKeyId);
  assert.equal(receipt.signerIndependentArtifactVerification, true);
  assert.equal(receipt.archiveTocVerified, true);
  assert.equal(receipt.pgRestoreSha256, f.pgRestoreSha256);
  assert.match(receipt.artifactVerificationDigest, /^[0-9a-f]{64}$/);
  const verified = spawnSync(process.execPath, [verifierPath,f.publicPath,outputPath,"backup-latest"], { encoding:"utf8" });
  assert.equal(verified.status, 0, verified.stderr);
});

test("semantic backup receipt signer rejects authorization and receipt key-domain reuse", async () => {
  const f = await fixture();
  const outputPath = path.join(f.root, "cross-key.json");
  const result = spawnSync(process.execPath, [signerPath,f.privatePath,f.privateSha256,f.integrityPath,f.integritySha256,f.requestPath,f.requestSha256,f.receiptKeyId,f.archiveEvidencePath,f.archiveEvidenceSha256,f.pgRestoreSha256,outputPath], { encoding:"utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /BACKUP_RECEIPT_KEY_DOMAIN_REUSE_REJECTED/);
});

test("semantic backup receipt signer rejects hard-linked artifacts", async () => {
  const f = await fixture();
  await link(path.join(f.artifactRoot,"database.dump"),path.join(f.root,"dump-hardlink.bin"));
  const outputPath = path.join(f.root, "hardlink.json");
  const result = spawnSync(process.execPath, [signerPath,f.privatePath,f.privateSha256,f.integrityPath,f.integritySha256,f.requestPath,f.requestSha256,f.authorizationKeyId,f.archiveEvidencePath,f.archiveEvidenceSha256,f.pgRestoreSha256,outputPath], { encoding:"utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /BACKUP_(?:HARDLINK_REJECTED|ARTIFACT_TREE_INVALID)/);
});

test("semantic backup receipt signer rejects forged archive verification and future completion time", async () => {
  const f = await fixture();
  const badEvidence = JSON.parse(await readFile(f.archiveEvidencePath, "utf8"));
  badEvidence.databaseDumpSha256 = "1".repeat(64);
  const badBytes = Buffer.from(JSON.stringify(badEvidence), "utf8");
  await writeFile(f.archiveEvidencePath, badBytes);
  let result = spawnSync(process.execPath, [signerPath,f.privatePath,f.privateSha256,f.integrityPath,f.integritySha256,f.requestPath,f.requestSha256,f.authorizationKeyId,f.archiveEvidencePath,hex(badBytes),f.pgRestoreSha256,path.join(f.root,"bad-archive.json")], { encoding:"utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /BACKUP_ARCHIVE_EVIDENCE_INVALID/);

  const future = await fixture({ backupId:"20990101T000000Z-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", createdAt:"2099-01-01T00:00:02.0000000Z" });
  result = spawnSync(process.execPath, [signerPath,future.privatePath,future.privateSha256,future.integrityPath,future.integritySha256,future.requestPath,future.requestSha256,future.authorizationKeyId,future.archiveEvidencePath,future.archiveEvidenceSha256,future.pgRestoreSha256,path.join(future.root,"future.json")], { encoding:"utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /BACKUP_COMPLETION_TIME_INVALID/);
});
