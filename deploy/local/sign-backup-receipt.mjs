import { createHash, createHmac, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { closeSync, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";

const [privateKeyPath, integrityKeyPath, requestPath, outputPath] = process.argv.slice(2);
if (!privateKeyPath || !integrityKeyPath || !requestPath || !outputPath) fail("BACKUP_RECEIPT_SIGNER_ARGUMENTS_REQUIRED");
const deadline = Date.now() + 300_000;
const request = jsonFile(requestPath, 1_048_576, "BACKUP_RECEIPT_REQUEST_INVALID");
if (!plainObject(request) || request.attestationType !== "backup-latest" || request.version !== 6 || request.result !== "COMPLETE" || !/^[0-9A-Za-z-]{20,80}$/.test(request.backupId ?? "")) fail("BACKUP_RECEIPT_REQUEST_INVALID");
const backupRoot = safeExistingDirectory(request.backupRoot, "BACKUP_ROOT_INVALID");
const artifactRoot = safeExistingDirectory(path.join(backupRoot, request.backupId), "BACKUP_ARTIFACT_ROOT_INVALID");
if (path.dirname(artifactRoot) !== backupRoot || path.basename(artifactRoot) !== request.backupId) fail("BACKUP_ARTIFACT_ROOT_INVALID");
const manifestPath = safeChild(artifactRoot, "backup-manifest.json");
const dumpPath = safeChild(artifactRoot, "database.dump");
const storageManifestPath = safeChild(artifactRoot, "storage-manifest.json");
const payloadRoot = safeExistingDirectory(safeChild(artifactRoot, "storage-payload"), "BACKUP_PAYLOAD_ROOT_INVALID");
const manifestBytes = bytesFile(manifestPath, 1_048_576, "BACKUP_MANIFEST_INVALID");
const manifest = parseJson(manifestBytes, "BACKUP_MANIFEST_INVALID");
if (!plainObject(manifest) || manifest.version !== 6 || manifest.result !== "COMPLETE" || manifest.backupId !== request.backupId || path.resolve(manifest.backupRoot) !== backupRoot) fail("BACKUP_MANIFEST_INVALID");
const manifestSha256 = sha256(manifestBytes);
if (request.manifestSha256 !== manifestSha256) fail("BACKUP_MANIFEST_HASH_MISMATCH");
for (const key of ["backupMode","releaseId","sourceDataRoot","databaseProvider","databaseProjectRef","databaseHost","databasePort","databaseName","databaseSchema","migrationDigest","appliedMigrationDigest","databaseDumpBytes","maximumDatabaseDumpBytes","maximumBackupDurationSeconds","backupSafetyMarginBytes","elapsedSeconds","databaseSizePreflightVerified","databaseDumpRealtimeCapEnforced","databaseDumpFinalCapVerified","hardDeadlineEnforced","processTreeKillOnDeadline","incompleteStagingCleanupContract","storageReferenceDigest","storageReferenceConversionSha256","storageReferenceCount","storageReferenceZeroVerified","legacyBaselineSha256","legacyStorageStageEvidenceSha256","targetEvidenceFingerprint","configFingerprint","integrityKeyId","integritySignature","nodeSha256","psqlSha256","pgDumpSha256","executorSetDigest","filesystemEvidenceSha256","completedAt"]) {
  if (request[key] !== manifest[key] && !(key === "completedAt" && request[key] === manifest.createdAt)) fail("BACKUP_RECEIPT_MANIFEST_MISMATCH");
}
const dump = hashFile(dumpPath, manifest.maximumDatabaseDumpBytes, "BACKUP_DUMP_INVALID");
if (dump.bytes !== manifest.databaseDumpBytes || dump.sha256 !== manifest.databaseDumpSha256) fail("BACKUP_DUMP_MISMATCH");
const storageManifestBytes = bytesFile(storageManifestPath, 268_435_456, "STORAGE_MANIFEST_INVALID");
if (sha256(storageManifestBytes) !== manifest.storageManifestSha256) fail("STORAGE_MANIFEST_HASH_MISMATCH");
const entries = parseJson(storageManifestBytes, "STORAGE_MANIFEST_INVALID");
if (!Array.isArray(entries) || entries.length !== manifest.fileCount || entries.length > 1_000_000) fail("STORAGE_MANIFEST_INVALID");
let totalBytes = 0; const canonical = []; const expected = new Set();
for (const entry of entries) {
  tick(); if (!exactObject(entry, ["key","sha256","size"]) || typeof entry.key !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256 ?? "") || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > 536_870_912 || invalidKey(entry.key) || expected.has(entry.key.toLowerCase())) fail("STORAGE_MANIFEST_INVALID");
  expected.add(entry.key.toLowerCase()); const filePath = safeChild(payloadRoot, ...entry.key.split("/")); const hashed = hashFile(filePath, 536_870_912, "STORAGE_PAYLOAD_INVALID");
  if (hashed.bytes !== entry.size || hashed.sha256 !== entry.sha256) fail("STORAGE_PAYLOAD_MISMATCH");
  totalBytes += hashed.bytes; if (!Number.isSafeInteger(totalBytes) || totalBytes > 1_099_511_627_776) fail("STORAGE_PAYLOAD_LIMIT_EXCEEDED"); canonical.push(`${entry.key}|${entry.size}|${entry.sha256}`);
}
const actualKeys = enumeratePayload(payloadRoot);
if (actualKeys.length !== expected.size || actualKeys.some((key) => !expected.has(key.toLowerCase()))) fail("STORAGE_PAYLOAD_SET_MISMATCH");
if (totalBytes !== manifest.totalBytes) fail("STORAGE_PAYLOAD_TOTAL_MISMATCH");
const integrityKey = bytesFile(integrityKeyPath, 4096, "BACKUP_INTEGRITY_KEY_INVALID");
if (integrityKey.length < 32 || sha256(integrityKey) !== manifest.integrityKeyId) fail("BACKUP_INTEGRITY_KEY_INVALID");
const expectedHmac = createHmac("sha256", integrityKey).update(signatureInput(manifest), "utf8").digest("hex"); integrityKey.fill(0);
if (expectedHmac !== manifest.integritySignature) fail("BACKUP_HMAC_INVALID");
const artifactVerificationDigest = sha256(Buffer.from([manifestSha256,dump.sha256,manifest.storageManifestSha256,sha256(Buffer.from(canonical.join("\n"),"utf8"))].join("\n"),"utf8"));
const privateKey = createPrivateKey(bytesFile(privateKeyPath, 65_536, "BACKUP_RECEIPT_PRIVATE_KEY_INVALID"));
if (privateKey.asymmetricKeyType !== "ed25519") fail("BACKUP_RECEIPT_PRIVATE_KEY_INVALID");
const signingKeyId = sha256(createPublicKey(privateKey).export({ type: "spki", format: "der" }));
const value = { ...request, artifactVerificationDigest, signerIndependentArtifactVerification: true };
const attestationSignature = sign(null, Buffer.from(canonicalJson(value), "utf8"), privateKey).toString("base64url");
writeFileSync(outputPath, JSON.stringify({ ...value, signingKeyId, attestationSignature }), { flag: "wx", mode: 0o600 });

function enumeratePayload(root) { const result=[]; const pending=[root]; while(pending.length){tick(); const directory=pending.pop(); for(const item of readdirSync(directory,{withFileTypes:true})){tick(); const full=safeChild(directory,item.name); const stat=lstatSync(full); if(stat.isSymbolicLink()) fail("BACKUP_REPARSE_REJECTED"); if(stat.isDirectory()) pending.push(full); else if(stat.isFile()){const key=path.relative(root,full).split(path.sep).join("/"); if(invalidKey(key)) fail("STORAGE_PAYLOAD_KEY_INVALID"); result.push(key);} else fail("STORAGE_PAYLOAD_TYPE_INVALID"); if(result.length>1_000_000) fail("STORAGE_PAYLOAD_LIMIT_EXCEEDED");}} return result.sort(); }
function hashFile(file, maximum, code) { tick(); const stat=lstatSync(file); if(!stat.isFile()||stat.isSymbolicLink()||stat.size<0||stat.size>maximum) fail(code); const fd=openSync(file,"r"); const hash=createHash("sha256"); const buffer=Buffer.allocUnsafe(1_048_576); let bytes=0; try{for(;;){tick();const read=readSync(fd,buffer,0,buffer.length,null);if(!read)break;bytes+=read;if(bytes>maximum)fail(code);hash.update(buffer.subarray(0,read));}}finally{buffer.fill(0);closeSync(fd)} if(bytes!==stat.size)fail(code); return {bytes,sha256:hash.digest("hex")}; }
function bytesFile(file, maximum, code) { tick(); const stat=lstatSync(file); if(!stat.isFile()||stat.isSymbolicLink()||stat.size<1||stat.size>maximum)fail(code); return readFileSync(file); }
function jsonFile(file, maximum, code){return parseJson(bytesFile(file,maximum,code),code)}
function parseJson(bytes,code){try{return JSON.parse(bytes.toString("utf8"))}catch{fail(code)}}
function safeExistingDirectory(value,code){if(typeof value!=="string"||!path.isAbsolute(value))fail(code);const resolved=path.resolve(value);const stat=lstatSync(resolved);if(!stat.isDirectory()||stat.isSymbolicLink()||realpathSync.native(resolved)!==resolved)fail(code);return resolved}
function safeChild(root,...parts){const candidate=path.resolve(root,...parts);const relative=path.relative(path.resolve(root),candidate);if(relative===".."||relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative))fail("BACKUP_PATH_ESCAPE");return candidate}
function invalidKey(value){return !value||value.length>1024||value.startsWith("/")||value.includes("\\")||value.includes(":")||value.includes("\0")||value.split("/").some((part)=>!part||part==="."||part===".."||part.endsWith(".")||part.endsWith(" "))}
function signatureInput(m){return ["6",m.backupId,m.createdAt,m.backupMode,m.sourceDataRoot,m.backupRoot,m.databaseProvider,m.databaseProjectRef,m.databaseConnectionMode,m.databaseHost,String(m.databasePort),m.databaseName,m.databaseSchema,m.releaseId,m.databaseDumpSha256,String(m.databaseDumpBytes),String(m.maximumDatabaseDumpBytes),String(m.maximumBackupDurationSeconds),String(m.backupSafetyMarginBytes),String(m.elapsedSeconds),ps(m.databaseSizePreflightVerified),ps(m.databaseDumpRealtimeCapEnforced),ps(m.databaseDumpFinalCapVerified),ps(m.hardDeadlineEnforced),ps(m.processTreeKillOnDeadline),ps(m.incompleteStagingCleanupContract),m.storageManifestSha256,m.storageReferenceDigest,m.storageReferenceConversionSha256??"",String(m.storageReferenceCount),ps(m.storageReferenceZeroVerified),m.legacyBaselineSha256??"",m.legacyStorageStageEvidenceSha256??"",m.migrationDigest,m.appliedMigrationDigest,m.businessKpiDigest,m.targetEvidenceFingerprint,m.configFingerprint,String(m.fileCount),String(m.totalBytes),m.integrityKeyId,m.nodeSha256,m.psqlSha256,m.pgDumpSha256,m.executorSetDigest,m.filesystemEvidenceSha256].join("\n")}
function ps(value){return value===true?"True":value===false?"False":String(value??"")}
function exactObject(value,keys){return plainObject(value)&&Object.keys(value).sort().join("\n")===[...keys].sort().join("\n")}
function sha256(bytes){return createHash("sha256").update(bytes).digest("hex")}
function canonicalJson(value){if(Array.isArray(value))return`[${value.map(canonicalJson).join(",")}]`;if(plainObject(value))return`{${Object.keys(value).sort().map((key)=>`${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;return JSON.stringify(value)}
function plainObject(value){return typeof value==="object"&&value!==null&&!Array.isArray(value)}
function tick(){if(Date.now()>deadline)fail("BACKUP_RECEIPT_SIGNER_DEADLINE")}
function fail(code){throw new Error(code)}
