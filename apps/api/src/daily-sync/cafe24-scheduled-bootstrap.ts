import {PrismaService} from "../common/prisma.service";
import {Prisma} from "@prisma/client";
import {formatInTimeZone} from "date-fns-tz";
import {Cafe24ScheduledBootstrapInput} from "./daily-sync.dto";
import {configurationStateDigest} from "./cafe24-live-configuration";
import {openCredential} from "./credential-vault";
import {assertEnabled,assertCafe24AppVersionEvidence,assertCafe24SellerOptionsEvidence,assertCafe24RawAllItemsV1Evidence,verifiedCafe24V1Statuses,parseIsoDate,syncError} from "./sync-contract";
import {accountAllowlist,accountKey} from "./source-connections.service";
import {writeSecurityAudit} from "../security-audit/security-audit.types";

const ID="0c35defe-45fc-4a54-bc79-704df7bca5b1";
function gate(connectionId:string) {
  assertEnabled();
  const env=process.env;
  if(connectionId!==ID || env.DAILY_SYNC_CAFE24_SCHEDULED_BOOTSTRAP_ENABLED!=="true" ||
    env.DAILY_SYNC_CAFE24_SCHEDULED_API_ONLY_ACTIVATION_ENABLED!=="true" || env.DAILY_SYNC_SCHEDULE_ENABLED!=="false" ||
    env.DAILY_SYNC_SCHEDULES!=="[]" || env.SUPABASE_DATABASE_PROJECT_REF!=="ehnfrrmbkvlsbpvqcvkr" ||
    env.SUPABASE_DATABASE_SCHEMA!=="phase08_meta_ads" || env.SUPABASE_DATABASE_RUNTIME_USER!=="phase08_runtime" ||
    env.DEPLOYMENT_ENVIRONMENT_ID!=="phase08-daily-data-sync-08" ||
    env.PHASE08_VERIFIED_ORIGIN!=="https://phase08-daily-data-sync-production.up.railway.app") syncError("SOURCE_SELECTION_REQUIRED");
}
export async function cafe24ScheduledBootstrapPreview(db:PrismaService,connectionId:string) {
  gate(connectionId);
  const connection=await db.sourceConnection.findUnique({where:{id:connectionId}});
  if(!connection || connection.provider!=="CAFE24" || connection.externalAccountId!=="didadi0729" || connection.shopKey!=="shop1") syncError("ACCOUNT_SCOPE_MISMATCH");
  return {connectionId,accessState:connection.accessState,enabled:connection.enabled,updatedAt:connection.updatedAt.toISOString(),
    configurationDigest:await configurationStateDigest(db)};
}
export async function bootstrapCafe24Scheduled(db:PrismaService,connectionId:string,input:Cafe24ScheduledBootstrapInput,actorUserId:string) {
  gate(connectionId);
  const today=formatInTimeZone(new Date(),"Asia/Seoul","yyyy-MM-dd");
  const fromDate=parseIsoDate(input.fromDate);
  if(input.fromDate!==today || input.acknowledgement!=="ENABLE_CAFE24_SCHEDULED_API_ONLY_WITHOUT_CSV" ||
    input.couponInputSource!==process.env.DAILY_SYNC_CAFE24_SCHEDULED_COUPON_INPUT_SOURCE ||
    !["UNKNOWN","API_ACTUAL_PRODUCT_PLUS_SHIPPING"].includes(input.couponInputSource) ||
    !/^[a-f0-9]{64}$/.test(input.expectedConfigurationDigest) ||
    !Number.isFinite(Date.parse(input.expectedUpdatedAt))) syncError("SOURCE_SELECTION_REQUIRED",400);
  assertCafe24AppVersionEvidence();assertCafe24SellerOptionsEvidence();
  if(verifiedCafe24V1Statuses().size===0) syncError("FIELD_UNSUPPORTED");
  const prior=new Date(fromDate);prior.setUTCDate(prior.getUTCDate()-1);
  assertCafe24RawAllItemsV1Evidence(prior.toISOString().slice(0,10));
  return db.$transaction(async tx=>{
    const [identity]=await tx.$queryRaw<Array<{role:string;schema:string;tables:bigint}>>`
      SELECT current_user::text AS role,current_schema()::text AS schema,
        (SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname='phase08_meta_ads') AS tables`;
    if(!identity || identity.role!=="phase08_runtime" || identity.schema!=="phase08_meta_ads" || Number(identity.tables)!==68) syncError("ACCOUNT_SCOPE_MISMATCH");
    await tx.$queryRaw`SELECT id FROM source_connections WHERE id=${connectionId}::uuid FOR UPDATE`;
    const connection=await tx.sourceConnection.findUnique({where:{id:connectionId}});
    if(!connection || connection.provider!=="CAFE24" || connection.externalAccountId!=="didadi0729" || connection.shopKey!=="shop1" ||
      connection.currencyCode!=="KRW" || connection.timeZone!=="Asia/Seoul" ||
      !accountAllowlist().has(accountKey("CAFE24","didadi0729","shop1"))) syncError("ACCOUNT_SCOPE_MISMATCH");
    if(connection.accessState!=="READY" || connection.enabled || connection.updatedAt.toISOString()!==input.expectedUpdatedAt ||
      connection.credentialRef!==`source_credentials:${connectionId}:CAFE24_REFRESH` || !connection.credentialExpiresAt ||
      connection.credentialExpiresAt.getTime()<=Date.now()) syncError("PROVIDER_AUTH_REQUIRED");
    const actor=await tx.appUser.findUnique({where:{id:actorUserId}});
    if(!actor || !actor.authUserId || actor.role!=="SUPER_ADMIN" || !actor.isActive || actor.inviteStatus!=="ACTIVE") syncError("SOURCE_SELECTION_REQUIRED");
    const counts=await Promise.all([tx.sourcePolicy.count({where:{connectionId}}),tx.syncRun.count({where:{connectionId}}),
      tx.syncLease.count({where:{connectionId}}),tx.sourceCoverage.count({where:{connectionId}})]);
    if(counts.some(count=>count!==0)) syncError("SOURCE_SELECTION_REQUIRED");
    const inventory=await Promise.all([tx.product.count(),tx.productCostRule.count(),tx.cafe24ProductRule.count(),tx.cafe24CouponRule.count()]);
    if(JSON.stringify(inventory)!=="[18,24,35,2]" || await configurationStateDigest(tx)!==input.expectedConfigurationDigest) syncError("RECONCILIATION_FAILED");
    const pair=await tx.sourceCredential.findMany({where:{connectionId}});
    const attempts=await tx.cafe24OauthAttempt.findMany({where:{connectionId,consumedAt:{not:null}},select:{actorUserId:true,consumedAt:true,expiresAt:true},take:2});
    if(attempts.length!==1 || attempts[0].actorUserId!==actorUserId || !attempts[0].consumedAt || attempts[0].consumedAt>=attempts[0].expiresAt) syncError("PROVIDER_AUTH_REQUIRED");
    if(pair.length!==2 || !pair.some(row=>row.kind==="CAFE24_ACCESS") || !pair.some(row=>row.kind==="CAFE24_REFRESH")) syncError("PROVIDER_AUTH_REQUIRED");
    for(const row of pair) {
      if(row.refreshOwner || row.refreshUntil || !row.expiresAt || row.expiresAt.getTime()<=Date.now() || row.revision!==1 ||
        row.createdAt<attempts[0].consumedAt || row.kind==="CAFE24_REFRESH" &&
          (row.expiresAt.getTime()!==connection.credentialExpiresAt.getTime() || row.expiresAt<=new Date(`${input.fromDate}T19:00:00Z`))) syncError("PROVIDER_AUTH_REQUIRED");
      let token:string|null=null;
      try {token=openCredential(row,connectionId,row.kind);if(!token || token.length>8192) syncError("PROVIDER_AUTH_REQUIRED");}
      finally {token=null;}
    }
    const policy=await tx.sourcePolicy.create({data:{connectionId,dataKind:"CAFE24_ORDER",fromDate,toDate:null,primarySource:"CSV",version:1,
      couponInputSource:input.couponInputSource,changedByUserId:actorUserId,reason:"CAFE24_SCHEDULED_API_ONLY_BOOTSTRAP"}});
    const updated=await tx.sourceConnection.updateMany({where:{id:connectionId,enabled:false,accessState:"READY",updatedAt:connection.updatedAt,
      credentialRef:connection.credentialRef,credentialExpiresAt:connection.credentialExpiresAt},data:{enabled:true}});
    if(updated.count!==1) syncError("LEASE_LOST");
    await writeSecurityAudit(tx,{actorType:"USER",actorUserId,action:"CAFE24_SCHEDULED_BOOTSTRAPPED",targetType:"SOURCE_CONNECTION",targetId:connectionId,result:"SUCCESS",
      beforeJson:{enabled:false,accessState:"READY"},afterJson:{enabled:true,fromDate:input.fromDate,initialSource:"CSV",sourceChoice:"API_ONLY",
        couponInputSource:input.couponInputSource,configurationDigest:input.expectedConfigurationDigest,policyVersion:policy.version}});
    return {connectionId,enabled:true,accessState:"READY",fromDate:input.fromDate,primarySource:"CSV",policyVersion:1,apiActivated:false,providerRequests:0,csvUploads:0};
  // The policy overlap trigger requires READ COMMITTED and the same parent
  // FOR UPDATE lock. Serializable snapshots violate that established contract.
  },{timeout:10000,maxWait:2000,isolationLevel:Prisma.TransactionIsolationLevel.ReadCommitted});
}
