import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { uptime } from "node:os";
import { pathToFileURL } from "node:url";
import { validateLocalRuntimeConfig } from "./runtime-config.mjs";
import { readJsonEvidence, readJsonEvidenceSnapshot } from "./evidence-reader.mjs";

if(import.meta.url===pathToFileURL(process.argv[1]??"").href) main();
function main(){const args=new Map(process.argv.slice(2).map((arg)=>{const index=arg.indexOf("=");if(!arg.startsWith("--")||index<3)fail("ARGUMENT_INVALID");return[arg.slice(2,index),arg.slice(index+1)]}));
const runtimeConfigPath=path.resolve(args.get("runtime-config")??"");const releaseRoot=path.resolve(args.get("release-root")??"");
const mode=args.get("mode")??"operational";if(!new Set(["operational","core-prepared","pre-edge"]).has(mode))fail("READINESS_MODE_INVALID");
const runtimeBytes=readBounded(runtimeConfigPath,1_048_576,"RUNTIME_CONFIG");const raw=JSON.parse(runtimeBytes.toString("utf8"));
const backupTargetSnapshot=readJsonEvidenceSnapshot(raw.backup?.physicalTargetEvidencePath);
const value=validateLocalRuntimeConfig(raw,{
  runtimeConfigPath,releaseRoot,runtimeConfigSha256:createHash("sha256").update(runtimeBytes).digest("hex"),
  clientTrustEvidence:readJsonEvidence(raw.tls?.clientTrustEvidencePath),backupTargetEvidence:backupTargetSnapshot?.value??null,backupTargetEvidenceSha256:backupTargetSnapshot?.sha256??null,
  backupScheduleEvidence:readJsonEvidence(raw.backup?.scheduledTaskEvidencePath),latestBackupEvidence:readJsonEvidence(raw.backup?.latestBackupEvidencePath),
  filesystemEvidence:readJsonEvidence(raw.hostSecurity?.filesystemEvidencePath),databaseBoundaryEvidence:readJsonEvidence(raw.database?.boundaryEvidencePath),
  firewallEvidence:readJsonEvidence(raw.hostSecurity?.firewallEvidencePath),restoreEvidence:readJsonEvidence(raw.backup?.restoreEvidencePath),recoveryEvidence:readJsonEvidence(raw.backup?.recoveryEvidencePath),disasterRecoveryEvidence:readJsonEvidence(raw.backup?.disasterRecoveryEvidencePath),
  rebootEvidence:readJsonEvidence(raw.hostSecurity?.rebootEvidencePath,{label:"REBOOT_EVIDENCE",allowMissingLeaf:true}),bootedAt:Date.now()-uptime()*1000,
  backupReceiptPublicKey:readOptional(raw.backup?.backupReceiptPublicKeyPath,16_384,"BACKUP_PUBLIC_KEY"),restoreReceiptPublicKey:readOptional(raw.backup?.restoreReceiptPublicKeyPath,16_384,"RESTORE_PUBLIC_KEY")
});
verifyReadinessMode(value,mode);
process.stdout.write(`${JSON.stringify({result:"PASS",releaseId:value.release.id,mode,corePrepared:value.network.corePrepared,operationalReady:value.readiness.operationalReady})}\n`);}
export function verifyReadinessMode(value,mode){
  if(mode==="operational"&&!value.readiness.operationalReady)fail("OPERATIONAL_READINESS_FAILED");
  if(mode==="core-prepared"&&(!value.network.corePrepared||value.lan.enabled||value.network.lanReady||value.readiness.operationalReady))fail("CORE_PREPARED_READINESS_FAILED");
  if(mode==="pre-edge"&&(!value.readiness.preEdgeReady||!value.lan.enabled||!value.network.lanReady||value.readiness.operationalReady))fail("PRE_EDGE_READINESS_FAILED");
}
function readOptional(value,max,label){if(typeof value!=="string"||!value)return null;return readBounded(value,max,label)}
function readBounded(value,max,label){const resolved=path.resolve(value);let cursor=path.parse(resolved).root;for(const segment of resolved.slice(cursor.length).split(path.sep).filter(Boolean)){cursor=path.join(cursor,segment);const stat=lstatSync(cursor);if(stat.isSymbolicLink())fail(`${label}_REPARSE_REJECTED`)}const stat=lstatSync(resolved);if(!stat.isFile()||stat.size<1||stat.size>max)fail(`${label}_FILE_INVALID`);return readFileSync(resolved)}
function fail(code){throw new Error(code)}
