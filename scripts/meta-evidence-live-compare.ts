import "reflect-metadata";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync,writeFileSync,mkdirSync} from "node:fs";
import {pathToFileURL} from "node:url";
import {configuredMetaMcpClient} from "../apps/api/src/daily-sync/meta-mcp-ads.client";
import {configuredMetaCredentialResolver} from "../apps/api/src/daily-sync/meta-protected-credential-resolver";
import {resolveMetaCredential} from "../apps/api/src/daily-sync/meta-credential-resolver";
import {configuredMetaSettings} from "../apps/api/src/daily-sync/meta-sync-runner.service";
import {getMetaFailureEvidence} from "../apps/api/src/daily-sync/meta-failure-evidence";
let prepared:any;
async function main(){
 const {prepareProductionSources}=await import("../deploy/cloud/production-source-launch.mjs");
 prepared=await prepareProductionSources(process.env);Object.assign(process.env,prepared.env);
 const credential=await resolveMetaCredential(configuredMetaCredentialResolver(),{connectionId:"2155a401-bd86-4111-9280-3c95ed207546",accountId:"2138525300002203",credentialRef:process.env.DAILY_SYNC_META_CREDENTIAL_REF!,transport:"MCP"});
 const client=configuredMetaMcpClient(),reader=(client as any).reader,fetchDay=reader.fetchDay.bind(reader);let capture:any;
 reader.fetchDay=async(input:any)=>{capture=await fetchDay(input);return capture;};
 const input={accountId:"2138525300002203",day:"2026-11-04",deadlineAt:Date.now()+120000,settings:configuredMetaSettings(),accessToken:credential.token};
 const updated=await client.fetchDay(input);
 // Baseline tree remains untouched; replay exactly the same capture, no second provider read.
 const baseline=await import(pathToFileURL("C:/Users/seong/Desktop/workspace/Meta-Ads-Performance/apps/api/src/daily-sync/meta-mcp-ads.client.ts").href);
 const old=new baseline.MetaMcpAdsClient(JSON.parse(readFileSync(process.env.DAILY_SYNC_META_MCP_CATALOG_PATH!,"utf8")),JSON.parse(readFileSync(process.env.DAILY_SYNC_META_MCP_REPORTING_SCHEMA_PATH!,"utf8")),{fetchDay:async()=>capture});
 let existing:any,baselineFailure:string|null=null;
 try{existing=await old.fetchDay(input);}catch(error:any){baselineFailure=error?.diagnosticCode??"BASELINE_FAILED";assert.equal(baselineFailure,"BASIC_TOTALS");assert(updated.ads[0]?.currentMetadata?.sourceContext?.spendReconciliation,"UNEXPECTED_BASELINE_FAILURE");}
 const hash=(value:any)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
 if(existing)assert.equal(hash(updated),hash(existing),"SUCCESSFUL_SNAPSHOT_CHANGED");
 const receipt={status:"PASS",checkedAt:new Date().toISOString(),day:input.day,rawCounts:{ads:capture.levels.ad.length,adsets:capture.levels.adset.length},selectedCounts:{ads:updated.ads.length,adsets:updated.adsets.length},businessSnapshotHash:hash(updated),baselineIdentical:!!existing,baselineFailure,spendReconciliation:updated.ads[0]?.currentMetadata?.sourceContext?.spendReconciliation??null,evidence:getMetaFailureEvidence(updated),providerReads:1,businessWrites:0};
 mkdirSync("reports/meta-retry-evidence-20261105",{recursive:true});writeFileSync("reports/meta-retry-evidence-20261105/live-compare.json",JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));
}
main().catch(error=>{console.error(JSON.stringify({status:"FAILED",code:error?.safeCode??error?.code??error?.getResponse?.()?.code??"LIVE_COMPARE_FAILED",diagnostic:error?.diagnosticCode??null,evidence:getMetaFailureEvidence(error)}));process.exitCode=1;}).finally(async()=>{await prepared?.cleanup();});
