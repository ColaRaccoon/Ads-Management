import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { validateLocalRuntimeConfig } from "./runtime-config.mjs";

const args=new Map(process.argv.slice(2).map((arg)=>{const index=arg.indexOf("=");if(!arg.startsWith("--")||index<3)fail("ARGUMENT_INVALID");return[arg.slice(2,index),arg.slice(index+1)]}));
const runtimeConfigPath=path.resolve(args.get("runtime-config")??"");const releaseRoot=path.resolve(args.get("release-root")??"");
const mode=args.get("mode")??"operational";if(!new Set(["operational","core-prepared"]).has(mode))fail("READINESS_MODE_INVALID");
const runtimeBytes=readBounded(runtimeConfigPath,1_048_576,"RUNTIME_CONFIG");const raw=JSON.parse(runtimeBytes.toString("utf8"));
const backupTargetSnapshot=readJsonSnapshot(raw.backup?.physicalTargetEvidencePath);
const value=validateLocalRuntimeConfig(raw,{
  runtimeConfigPath,releaseRoot,runtimeConfigSha256:createHash("sha256").update(runtimeBytes).digest("hex"),
  clientTrustEvidence:readJson(raw.tls?.clientTrustEvidencePath),backupTargetEvidence:backupTargetSnapshot?.value??null,backupTargetEvidenceSha256:backupTargetSnapshot?.sha256??null,
  backupScheduleEvidence:readJson(raw.backup?.scheduledTaskEvidencePath),latestBackupEvidence:readJson(raw.backup?.latestBackupEvidencePath),
  filesystemEvidence:readJson(raw.hostSecurity?.filesystemEvidencePath),databaseBoundaryEvidence:readJson(raw.database?.boundaryEvidencePath),
  firewallEvidence:readJson(raw.hostSecurity?.firewallEvidencePath),restoreEvidence:readJson(raw.backup?.restoreEvidencePath),recoveryEvidence:readJson(raw.backup?.recoveryEvidencePath),disasterRecoveryEvidence:readJson(raw.backup?.disasterRecoveryEvidencePath),
  backupReceiptPublicKey:readOptional(raw.backup?.backupReceiptPublicKeyPath,16_384,"BACKUP_PUBLIC_KEY"),restoreReceiptPublicKey:readOptional(raw.backup?.restoreReceiptPublicKeyPath,16_384,"RESTORE_PUBLIC_KEY")
});
if(mode==="operational"&&!value.readiness.operationalReady)fail("OPERATIONAL_READINESS_FAILED");
if(mode==="core-prepared"&&(!value.readiness.corePrepared||value.lan.enabled||value.readiness.lanReady||value.readiness.operationalReady))fail("CORE_PREPARED_READINESS_FAILED");
process.stdout.write(`${JSON.stringify({result:"PASS",releaseId:value.release.id,mode,corePrepared:value.readiness.corePrepared,operationalReady:value.readiness.operationalReady})}\n`);
function readJson(value){if(typeof value!=="string"||!value)return null;return JSON.parse(readBounded(value,1_048_576,"EVIDENCE").toString("utf8"))}
function readJsonSnapshot(value){if(typeof value!=="string"||!value)return null;const bytes=readBounded(value,1_048_576,"EVIDENCE");return{value:JSON.parse(bytes.toString("utf8")),sha256:createHash("sha256").update(bytes).digest("hex")}}
function readOptional(value,max,label){if(typeof value!=="string"||!value)return null;return readBounded(value,max,label)}
function readBounded(value,max,label){const resolved=path.resolve(value);let cursor=path.parse(resolved).root;for(const segment of resolved.slice(cursor.length).split(path.sep).filter(Boolean)){cursor=path.join(cursor,segment);const stat=lstatSync(cursor);if(stat.isSymbolicLink())fail(`${label}_REPARSE_REJECTED`)}const stat=lstatSync(resolved);if(!stat.isFile()||stat.size<1||stat.size>max)fail(`${label}_FILE_INVALID`);return readFileSync(resolved)}
function fail(code){throw new Error(code)}
