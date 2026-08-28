import { createHash, createHmac, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const [privateKeyPath, expectedPrivateKeySha256, integrityKeyPath, expectedIntegrityKeySha256, requestPath, expectedRequestSha256, authorizationSigningKeyId, outputPath] = process.argv.slice(2);
if (!privateKeyPath || !integrityKeyPath || !requestPath || !outputPath || !hex(expectedPrivateKeySha256) || !hex(expectedIntegrityKeySha256) || !hex(expectedRequestSha256) || !hex(authorizationSigningKeyId)) fail("BACKUP_RECEIPT_SIGNER_ARGUMENTS_REQUIRED");
const deadline = Date.now() + 300_000;
const requestBytes = pinnedBytes(requestPath, 1_048_576, expectedRequestSha256, "BACKUP_RECEIPT_REQUEST_HASH_MISMATCH");
const request = parseJson(requestBytes, "BACKUP_RECEIPT_REQUEST_INVALID");
const requestKeys = ["attestationType","backupContractSha256","backupId","backupIntegrityKeySha256","backupReceiptPrivateKeySha256","backupRoot","completedAt","manifestSha256","pgPassSha256","receiptPublisherSha256","result","semanticSignerSha256","targetEvidenceFingerprint","version"];
if (!exactObject(request, requestKeys) || request.attestationType !== "backup-latest" || request.version !== 6 || request.result !== "COMPLETE" || !backupId(request.backupId) || !hex(request.manifestSha256) || !hex(request.targetEvidenceFingerprint) || !hex(request.backupContractSha256) || !hex(request.pgPassSha256) || !hex(request.backupIntegrityKeySha256) || !hex(request.backupReceiptPrivateKeySha256) || !hex(request.receiptPublisherSha256) || !hex(request.semanticSignerSha256) || !timestamp(request.completedAt)) fail("BACKUP_RECEIPT_REQUEST_INVALID");
if (request.backupIntegrityKeySha256 !== expectedIntegrityKeySha256 || request.backupReceiptPrivateKeySha256 !== expectedPrivateKeySha256 || sha256(readFileSync(fileURLToPath(import.meta.url))) !== request.semanticSignerSha256) fail("BACKUP_RECEIPT_EXECUTOR_BINDING_MISMATCH");

const backupRoot = safeExistingDirectory(request.backupRoot, "BACKUP_ROOT_INVALID");
const artifactRoot = safeExistingDirectory(path.join(backupRoot, request.backupId), "BACKUP_ARTIFACT_ROOT_INVALID");
if (path.dirname(artifactRoot) !== backupRoot || path.basename(artifactRoot) !== request.backupId) fail("BACKUP_ARTIFACT_ROOT_INVALID");
const manifestPath = safeChild(artifactRoot, "backup-manifest.json");
const dumpPath = safeChild(artifactRoot, "database.dump");
const storageManifestPath = safeChild(artifactRoot, "storage-manifest.json");
const conversionPath = safeChild(artifactRoot, "storage-reference-conversion.sql");
const payloadRoot = safeExistingDirectory(safeChild(artifactRoot, "storage-payload"), "BACKUP_PAYLOAD_ROOT_INVALID");
const manifestBytes = bytesFile(manifestPath, 1_048_576, "BACKUP_MANIFEST_INVALID");
const manifest = parseJson(manifestBytes, "BACKUP_MANIFEST_INVALID");
const manifestKeys = ["appliedMigrationDigest","backupId","backupMode","backupRoot","backupSafetyMarginBytes","businessKpiDigest","configFingerprint","createdAt","databaseConnectionMode","databaseDumpBytes","databaseDumpRealtimeCapEnforced","databaseDumpFinalCapVerified","databaseDumpSha256","databaseHost","databaseName","databasePort","databaseProjectRef","databaseProvider","databaseSchema","databaseSizePreflightVerified","elapsedSeconds","executorSetDigest","fileCount","filesystemEvidenceSha256","hardDeadlineEnforced","incompleteStagingCleanupContract","integrityAlgorithm","integrityKeyId","integritySignature","legacyBaselineSha256","legacyStorageStageEvidenceSha256","maximumBackupDurationSeconds","maximumDatabaseDumpBytes","migrationDigest","nodeSha256","pgDumpSha256","processTreeKillOnDeadline","psqlSha256","releaseId","result","rpoHours","rtoHours","sourceDataRoot","storageManifestSha256","storageReferenceConversionSha256","storageReferenceCount","storageReferenceDigest","storageReferenceZeroVerified","targetEvidenceFingerprint","totalBytes","version"];
if (!exactObject(manifest, manifestKeys) || manifest.version !== 6 || manifest.result !== "COMPLETE" || manifest.backupId !== request.backupId || path.resolve(manifest.backupRoot) !== backupRoot || manifest.createdAt !== request.completedAt || manifest.targetEvidenceFingerprint !== request.targetEvidenceFingerprint || manifest.integrityAlgorithm !== "HMAC-SHA256" || manifest.databaseProvider !== "supabase_postgres" || manifest.databasePort !== 5432 || manifest.rpoHours !== 24 || manifest.rtoHours !== 4 || manifest.maximumBackupDurationSeconds !== 14400) fail("BACKUP_MANIFEST_INVALID");
if (!pathValue(manifest.sourceDataRoot) || !pathValue(manifest.backupRoot) || !/^[a-z]{20}$/.test(manifest.databaseProjectRef ?? "") || !new Set(["direct","session_pooler"]).has(manifest.databaseConnectionMode) || typeof manifest.databaseHost !== "string" || manifest.databaseHost.length > 253 || !identifier(manifest.databaseName) || !identifier(manifest.databaseSchema) || typeof manifest.releaseId !== "string" || manifest.releaseId.length < 1 || manifest.releaseId.length > 256) fail("BACKUP_MANIFEST_INVALID");
for (const value of [manifest.databaseDumpSha256,manifest.storageManifestSha256,manifest.storageReferenceDigest,manifest.migrationDigest,manifest.appliedMigrationDigest,manifest.businessKpiDigest,manifest.targetEvidenceFingerprint,manifest.configFingerprint,manifest.integrityKeyId,manifest.integritySignature,manifest.nodeSha256,manifest.psqlSha256,manifest.pgDumpSha256,manifest.executorSetDigest,manifest.filesystemEvidenceSha256]) if (!hex(value)) fail("BACKUP_MANIFEST_INVALID");
for (const value of [manifest.databaseDumpBytes,manifest.maximumDatabaseDumpBytes,manifest.backupSafetyMarginBytes,manifest.elapsedSeconds,manifest.storageReferenceCount,manifest.fileCount,manifest.totalBytes]) if (!nonnegativeInteger(value)) fail("BACKUP_MANIFEST_INVALID");
for (const value of [manifest.databaseSizePreflightVerified,manifest.databaseDumpRealtimeCapEnforced,manifest.databaseDumpFinalCapVerified,manifest.hardDeadlineEnforced,manifest.processTreeKillOnDeadline,manifest.incompleteStagingCleanupContract,manifest.storageReferenceZeroVerified]) if (typeof value !== "boolean") fail("BACKUP_MANIFEST_INVALID");
if (!manifest.databaseSizePreflightVerified || !manifest.databaseDumpRealtimeCapEnforced || !manifest.databaseDumpFinalCapVerified || !manifest.hardDeadlineEnforced || !manifest.processTreeKillOnDeadline || !manifest.incompleteStagingCleanupContract || manifest.databaseDumpBytes > manifest.maximumDatabaseDumpBytes || !timestamp(manifest.createdAt)) fail("BACKUP_MANIFEST_INVALID");
if (manifest.storageReferenceZeroVerified !== (manifest.storageReferenceCount === 0)) fail("BACKUP_MANIFEST_INVALID");
const manifestSha256 = sha256(manifestBytes);
if (request.manifestSha256 !== manifestSha256) fail("BACKUP_MANIFEST_HASH_MISMATCH");

let conversion = null;
if (manifest.backupMode === "LEGACY_BASELINE") {
  if (!hex(manifest.storageReferenceConversionSha256) || !hex(manifest.legacyBaselineSha256) || !hex(manifest.legacyStorageStageEvidenceSha256)) fail("LEGACY_STORAGE_CONVERSION_INVALID");
  conversion = hashFile(conversionPath, 16_777_216, "LEGACY_STORAGE_CONVERSION_INVALID");
  if (conversion.sha256 !== manifest.storageReferenceConversionSha256) fail("LEGACY_STORAGE_CONVERSION_HASH_MISMATCH");
} else if (manifest.backupMode === "LOCAL_RELEASE") {
  if (manifest.storageReferenceConversionSha256 !== null || manifest.legacyBaselineSha256 !== null || manifest.legacyStorageStageEvidenceSha256 !== null || existsSync(conversionPath)) fail("LOCAL_RELEASE_CONVERSION_REJECTED");
} else fail("BACKUP_MODE_INVALID");
const expectedTop = ["backup-manifest.json","database.dump","receipt-request.json","storage-manifest.json","storage-payload",...(conversion ? ["storage-reference-conversion.sql"] : [])].sort();
if (readdirSync(artifactRoot).sort().join("\n") !== expectedTop.join("\n")) fail("BACKUP_ARTIFACT_SET_INVALID");

const dump = hashFile(dumpPath, manifest.maximumDatabaseDumpBytes, "BACKUP_DUMP_INVALID");
if (dump.bytes !== manifest.databaseDumpBytes || dump.sha256 !== manifest.databaseDumpSha256) fail("BACKUP_DUMP_MISMATCH");
const storageManifestBytes = bytesFile(storageManifestPath, 268_435_456, "STORAGE_MANIFEST_INVALID");
if (sha256(storageManifestBytes) !== manifest.storageManifestSha256) fail("STORAGE_MANIFEST_HASH_MISMATCH");
const entries = parseJson(storageManifestBytes, "STORAGE_MANIFEST_INVALID");
if (!Array.isArray(entries) || entries.length !== manifest.fileCount || entries.length > 1_000_000) fail("STORAGE_MANIFEST_INVALID");
let totalBytes = 0; const canonical = []; const expected = new Set();
for (const entry of entries) {
  tick(); if (!exactObject(entry, ["key","sha256","size"]) || typeof entry.key !== "string" || !hex(entry.sha256) || !nonnegativeInteger(entry.size) || entry.size > 536_870_912 || invalidKey(entry.key) || expected.has(entry.key.toLowerCase())) fail("STORAGE_MANIFEST_INVALID");
  expected.add(entry.key.toLowerCase()); const filePath = safeChild(payloadRoot, ...entry.key.split("/")); const hashed = hashFile(filePath, 536_870_912, "STORAGE_PAYLOAD_INVALID");
  if (hashed.bytes !== entry.size || hashed.sha256 !== entry.sha256) fail("STORAGE_PAYLOAD_MISMATCH");
  totalBytes += hashed.bytes; if (!Number.isSafeInteger(totalBytes) || totalBytes > 1_099_511_627_776) fail("STORAGE_PAYLOAD_LIMIT_EXCEEDED"); canonical.push(`${entry.key}|${entry.size}|${entry.sha256}`);
}
const actualKeys = enumeratePayload(payloadRoot);
if (actualKeys.length !== expected.size || actualKeys.some((key) => !expected.has(key.toLowerCase()))) fail("STORAGE_PAYLOAD_SET_MISMATCH");
if (totalBytes !== manifest.totalBytes) fail("STORAGE_PAYLOAD_TOTAL_MISMATCH");
const integrityKey = pinnedBytes(integrityKeyPath, 4096, expectedIntegrityKeySha256, "BACKUP_INTEGRITY_KEY_INVALID");
if (integrityKey.length < 32 || sha256(integrityKey) !== manifest.integrityKeyId) fail("BACKUP_INTEGRITY_KEY_INVALID");
const expectedHmac = createHmac("sha256", integrityKey).update(signatureInput(manifest), "utf8").digest("hex"); integrityKey.fill(0);
if (expectedHmac !== manifest.integritySignature) fail("BACKUP_HMAC_INVALID");
const privateKeyBytes = pinnedBytes(privateKeyPath, 65_536, expectedPrivateKeySha256, "BACKUP_RECEIPT_PRIVATE_KEY_INVALID");
const privateKey = createPrivateKey(privateKeyBytes); privateKeyBytes.fill(0);
if (privateKey.asymmetricKeyType !== "ed25519") fail("BACKUP_RECEIPT_PRIVATE_KEY_INVALID");
const signingKeyId = sha256(createPublicKey(privateKey).export({ type: "spki", format: "der" }));
if (signingKeyId === authorizationSigningKeyId) fail("BACKUP_RECEIPT_KEY_DOMAIN_REUSE_REJECTED");
const conversionDigest = conversion?.sha256 ?? sha256(Buffer.alloc(0));
const artifactVerificationDigest = sha256(Buffer.from([manifestSha256,dump.sha256,manifest.storageManifestSha256,sha256(Buffer.from(canonical.join("\n"),"utf8")),conversionDigest].join("\n"),"utf8"));
const value = { attestationType:"backup-latest" };
for (const key of manifestKeys) if (!["createdAt","version","result"].includes(key)) value[key]=manifest[key];
Object.assign(value,{version:6,result:"COMPLETE",completedAt:manifest.createdAt,manifestSha256,backupContractSha256:request.backupContractSha256,pgPassSha256:request.pgPassSha256,backupIntegrityKeySha256:request.backupIntegrityKeySha256,backupReceiptPrivateKeySha256:request.backupReceiptPrivateKeySha256,receiptPublisherSha256:request.receiptPublisherSha256,semanticSignerSha256:request.semanticSignerSha256,authorizationSigningKeyId,artifactVerificationDigest,signerIndependentArtifactVerification:true});
const attestationSignature = sign(null, Buffer.from(canonicalJson(value), "utf8"), privateKey).toString("base64url");
writeFileSync(outputPath, JSON.stringify({ ...value, signingKeyId, attestationSignature }), { flag: "wx", mode: 0o600 });

function enumeratePayload(root) { const result=[]; const pending=[root]; while(pending.length){tick(); const directory=pending.pop(); for(const item of readdirSync(directory,{withFileTypes:true})){tick(); const full=safeChild(directory,item.name); const stat=lstatSync(full); if(stat.isSymbolicLink()) fail("BACKUP_REPARSE_REJECTED"); if(stat.isDirectory()) pending.push(full); else if(stat.isFile()){const key=path.relative(root,full).split(path.sep).join("/"); if(invalidKey(key)) fail("STORAGE_PAYLOAD_KEY_INVALID"); result.push(key);} else fail("STORAGE_PAYLOAD_TYPE_INVALID"); if(result.length>1_000_000) fail("STORAGE_PAYLOAD_LIMIT_EXCEEDED");}} return result.sort(); }
function hashFile(file, maximum, code) { tick(); const stat=lstatSync(file); if(!stat.isFile()||stat.isSymbolicLink()||stat.size<0||stat.size>maximum) fail(code); const fd=openSync(file,"r"); const hash=createHash("sha256"); const buffer=Buffer.allocUnsafe(1_048_576); let bytes=0; try{for(;;){tick();const read=readSync(fd,buffer,0,buffer.length,null);if(!read)break;bytes+=read;if(bytes>maximum)fail(code);hash.update(buffer.subarray(0,read));}}finally{buffer.fill(0);closeSync(fd)} if(bytes!==stat.size)fail(code); return {bytes,sha256:hash.digest("hex")}; }
function bytesFile(file, maximum, code) { tick(); const stat=lstatSync(file); if(!stat.isFile()||stat.isSymbolicLink()||stat.size<1||stat.size>maximum)fail(code); return readFileSync(file); }
function pinnedBytes(file,maximum,expected,code){const bytes=bytesFile(file,maximum,code);if(sha256(bytes)!==expected){bytes.fill(0);fail(code)}return bytes}
function parseJson(bytes,code){try{return JSON.parse(bytes.toString("utf8"))}catch{fail(code)}}
function safeExistingDirectory(value,code){if(typeof value!=="string"||!path.isAbsolute(value))fail(code);const resolved=path.resolve(value);const stat=lstatSync(resolved);if(!stat.isDirectory()||stat.isSymbolicLink()||realpathSync.native(resolved)!==resolved)fail(code);return resolved}
function safeChild(root,...parts){const candidate=path.resolve(root,...parts);const relative=path.relative(path.resolve(root),candidate);if(relative===".."||relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative))fail("BACKUP_PATH_ESCAPE");return candidate}
function invalidKey(value){return !value||value.length>1024||value.startsWith("/")||value.includes("\\")||value.includes(":")||value.includes("\0")||value.split("/").some((part)=>!part||part==="."||part===".."||part.endsWith(".")||part.endsWith(" "))}
function signatureInput(m){return ["6",m.backupId,m.createdAt,m.backupMode,m.sourceDataRoot,m.backupRoot,m.databaseProvider,m.databaseProjectRef,m.databaseConnectionMode,m.databaseHost,String(m.databasePort),m.databaseName,m.databaseSchema,m.releaseId,m.databaseDumpSha256,String(m.databaseDumpBytes),String(m.maximumDatabaseDumpBytes),String(m.maximumBackupDurationSeconds),String(m.backupSafetyMarginBytes),String(m.elapsedSeconds),ps(m.databaseSizePreflightVerified),ps(m.databaseDumpRealtimeCapEnforced),ps(m.databaseDumpFinalCapVerified),ps(m.hardDeadlineEnforced),ps(m.processTreeKillOnDeadline),ps(m.incompleteStagingCleanupContract),m.storageManifestSha256,m.storageReferenceDigest,m.storageReferenceConversionSha256??"",String(m.storageReferenceCount),ps(m.storageReferenceZeroVerified),m.legacyBaselineSha256??"",m.legacyStorageStageEvidenceSha256??"",m.migrationDigest,m.appliedMigrationDigest,m.businessKpiDigest,m.targetEvidenceFingerprint,m.configFingerprint,String(m.fileCount),String(m.totalBytes),m.integrityKeyId,m.nodeSha256,m.psqlSha256,m.pgDumpSha256,m.executorSetDigest,m.filesystemEvidenceSha256].join("\n")}
function ps(value){return value===true?"True":value===false?"False":String(value??"")}
function exactObject(value,keys){return plainObject(value)&&Object.keys(value).sort().join("\n")===[...keys].sort().join("\n")}
function hex(value){return typeof value==="string"&&/^[0-9a-f]{64}$/.test(value)}
function backupId(value){return typeof value==="string"&&/^[0-9A-Za-z-]{20,80}$/.test(value)}
function identifier(value){return typeof value==="string"&&/^[a-z][a-z0-9_]{0,62}$/.test(value)}
function pathValue(value){return typeof value==="string"&&path.isAbsolute(value)&&value.length<=32767}
function nonnegativeInteger(value){return Number.isSafeInteger(value)&&value>=0}
function timestamp(value){return typeof value==="string"&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/.test(value)&&Number.isFinite(Date.parse(value))}
function sha256(bytes){return createHash("sha256").update(bytes).digest("hex")}
function canonicalJson(value){if(Array.isArray(value))return`[${value.map(canonicalJson).join(",")}]`;if(plainObject(value))return`{${Object.keys(value).sort().map((key)=>`${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;return JSON.stringify(value)}
function plainObject(value){return typeof value==="object"&&value!==null&&!Array.isArray(value)}
function tick(){if(Date.now()>deadline)fail("BACKUP_RECEIPT_SIGNER_DEADLINE")}
function fail(code){throw new Error(code)}
