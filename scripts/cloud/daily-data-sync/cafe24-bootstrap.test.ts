import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import {randomBytes} from "node:crypto";
import {bootstrapCafe24Scheduled,cafe24ScheduledBootstrapPreview} from "../../../apps/api/src/daily-sync/cafe24-scheduled-bootstrap";
import {configurationStateDigest} from "../../../apps/api/src/daily-sync/cafe24-live-configuration";
import {sealCredential} from "../../../apps/api/src/daily-sync/credential-vault";
const id="0c35defe-45fc-4a54-bc79-704df7bca5b1",actor="f08d1a79-9280-4ac2-9e62-62eea12b4d28";
test("fresh normal bootstrap creates only a CSV shadow baseline and enabled CAS after exact evidence/AAD/config checks",async t=>{
  t.mock.timers.enable({apis:["Date"],now:new Date("2026-10-14T01:00:00Z").getTime()});
  const before={...process.env};Object.assign(process.env,{DAILY_SYNC_FEATURE_ENABLED:"true",DAILY_SYNC_SCHEDULE_ENABLED:"false",DAILY_SYNC_SCHEDULES:"[]",
    DAILY_SYNC_ALLOWED_ACCOUNTS:'["CAFE24/didadi0729/shop1"]',DAILY_SYNC_CAFE24_SCHEDULED_BOOTSTRAP_ENABLED:"true",DAILY_SYNC_CAFE24_SCHEDULED_API_ONLY_ACTIVATION_ENABLED:"true",DAILY_SYNC_CAFE24_SCHEDULED_COUPON_INPUT_SOURCE:"UNKNOWN",
    SUPABASE_DATABASE_PROJECT_REF:"ehnfrrmbkvlsbpvqcvkr",SUPABASE_DATABASE_SCHEMA:"phase08_meta_ads",SUPABASE_DATABASE_RUNTIME_USER:"phase08_runtime",DEPLOYMENT_ENVIRONMENT_ID:"phase08-daily-data-sync-08",PHASE08_VERIFIED_ORIGIN:"https://phase08-daily-data-sync-production.up.railway.app",
    DAILY_SYNC_CAFE24_APP_API_VERSION:"2026-09-01",DAILY_SYNC_CAFE24_APP_API_VERSION_VERIFIED_AT:"2026-10-14",DAILY_SYNC_CAFE24_SELLER_DROPDOWN:"true",DAILY_SYNC_CAFE24_SELLER_DROPDOWN_VERIFIED_AT:"2026-10-14",DAILY_SYNC_CAFE24_RAW_ALL_ITEMS_V1_VERIFIED:"true",DAILY_SYNC_CAFE24_RAW_ALL_ITEMS_V1_VERIFIED_AT:"2026-10-14",DAILY_SYNC_CAFE24_VERIFIED_V1_STATUSES:'["N40","C34"]',DAILY_SYNC_CREDENTIAL_KEY_V1:randomBytes(32).toString("base64")});
  try {
    for(const mode of ["success","wrong-aad","stale-config","stale-cas","has-run","has-policy","lease","evidence","expired","wrong-role","cas-loss"]) {
      let writes=0,audits=0,policy:any,update:any;
      const connection={id,provider:"CAFE24",externalAccountId:"didadi0729",shopKey:"shop1",currencyCode:"KRW",timeZone:"Asia/Seoul",accessState:"READY",enabled:false,updatedAt:new Date("2026-10-14T00:10:00Z"),credentialRef:`source_credentials:${id}:CAFE24_REFRESH`,credentialExpiresAt:new Date("2026-10-28Z")};
      const rows=(kind:string)=>({...sealCredential("SYNTHETIC",mode==="wrong-aad"?actor:id,kind,1),kind,revision:1,refreshOwner:null,refreshUntil:null,expiresAt:new Date(kind==="CAFE24_REFRESH"?"2026-10-28Z":mode==="expired"?"2026-10-14T00:30Z":"2026-10-14T02:00Z"),createdAt:new Date("2026-10-14T00:09:30Z")});
      const tx:any={$queryRaw:async()=>[{role:mode==="wrong-role"?"postgres":"phase08_runtime",schema:"phase08_meta_ads",tables:68n}],sourceConnection:{findUnique:async()=>connection,updateMany:async({data}:any)=>{writes++;update=data;return{count:mode==="cas-loss"?0:1};}},
        appUser:{findUnique:async()=>({authUserId:actor,role:"SUPER_ADMIN",isActive:true,inviteStatus:"ACTIVE"})},sourcePolicy:{count:async()=>mode==="has-policy"?1:0,create:async({data}:any)=>{writes++;policy=data;return{version:1};}},syncRun:{count:async()=>mode==="has-run"?1:0},syncLease:{count:async()=>mode==="lease"?1:0},sourceCoverage:{count:async()=>0},
        sourceCredential:{findMany:async()=>[rows("CAFE24_ACCESS"),rows("CAFE24_REFRESH")]},cafe24OauthAttempt:{findMany:async()=>[{actorUserId:actor,consumedAt:new Date("2026-10-14T00:09Z"),expiresAt:new Date("2026-10-14T00:12Z")}]},securityAuditEvent:{create:async()=>{audits++;}}};
      for(const [delegate,n] of Object.entries({product:18,productCostRule:24,cafe24ProductRule:35,cafe24CouponRule:2}))tx[delegate]={count:async()=>n,findMany:async()=>[{id:delegate}]};
      const db:any={...tx,$transaction:async(fn:any,options:any)=>{assert.equal(options.isolationLevel,"ReadCommitted");return fn(tx);}};
      const digest=await configurationStateDigest(db);
      const input:any={fromDate:"2026-10-14",expectedUpdatedAt:mode==="stale-cas"?"2026-10-14T00:00:00.000Z":connection.updatedAt.toISOString(),expectedConfigurationDigest:mode==="stale-config"?"a".repeat(64):digest,couponInputSource:"UNKNOWN",acknowledgement:"ENABLE_CAFE24_SCHEDULED_API_ONLY_WITHOUT_CSV"};
      process.env.DAILY_SYNC_CAFE24_RAW_ALL_ITEMS_V1_VERIFIED=mode==="evidence"?"false":"true";
      if(mode==="success") {
        const preview=await cafe24ScheduledBootstrapPreview(db,id);assert.equal(preview.configurationDigest,digest);
        const result=await bootstrapCafe24Scheduled(db,id,input,actor);assert.equal(result.apiActivated,false);assert.equal(result.providerRequests,0);
        assert.equal(policy.primarySource,"CSV");assert.equal(policy.couponInputSource,"UNKNOWN");assert.deepEqual(update,{enabled:true});assert.equal(audits,1);
      } else {await assert.rejects(bootstrapCafe24Scheduled(db,id,input,actor));assert.equal(audits,0);if(mode!=="cas-loss")assert.equal(writes,0);}
    }
  } finally {process.env=before;}
});
