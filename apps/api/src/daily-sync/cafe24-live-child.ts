import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";
import { assertLiveSetupEnvironment } from "./cafe24-live-setup";
import { Cafe24LiveChildFailure,liveChildFailure,parseLiveChildFailure,processLiveChildFailure,type LIVE_CHILD_GUARDS,type LIVE_CHILD_STAGES } from "./cafe24-live-failure";
import {SAFE_SYNC_CODES} from "./sync-contract";
import {isCafe24FailureDiagnosticCode} from "./cafe24-failure-diagnostic";

const liveChildren = new Set<ReturnType<typeof spawn>>();
const childClosures = new Set<Promise<void>>();
export async function stopCafe24LiveChildren() {
  for (const child of liveChildren) child.kill("SIGTERM");
  await Promise.allSettled([...childClosures]);
}

/** Explicit recovery after abrupt process termination; never run on startup.
 * The caller serializes authenticated jobs and verifies the current deployment
 * has one instance. Only enabled is restored; provider auth and runs stay intact. */
export async function recoverCafe24LiveEnable(prisma:PrismaClient,acknowledgement:string,verifiedAt:string) {
  assertLiveSetupEnvironment(process.env);
  const attested=Date.parse(verifiedAt);
  if (acknowledgement!=="RESTORE_ISOLATED_06_CHILD_ENABLED_FALSE_ONLY" || !Number.isFinite(attested) ||
      attested>Date.now() || Date.now()-attested>30*60_000 || liveChildren.size || childClosures.size)
    throw new Error("ISOLATED_RECOVERY_EVIDENCE_REQUIRED");
  return prisma.$transaction(async(tx)=> {
    const [identity]=await tx.$queryRaw<Array<{database:string;schema:string}>>`SELECT current_database() AS database,current_schema() AS schema`;
    if (identity?.database!==process.env.DAILY_SYNC_CAFE24_DB_NAME || identity.schema!=="public")
      throw new Error("ISOLATED_DATABASE_IDENTITY_MISMATCH");
    await tx.$executeRaw`SET LOCAL lock_timeout='2s'`;
    await tx.$queryRaw`SELECT id FROM source_connections FOR UPDATE`;
    const connections=await tx.sourceConnection.findMany({select:{id:true,provider:true,externalAccountId:true,
      shopKey:true,enabled:true,updatedAt:true}});
    const connection=connections[0];
    if (connections.length!==1 || connection.provider!=="CAFE24" || connection.externalAccountId!=="didadi0729" ||
        connection.shopKey!=="shop1") throw new Error("ISOLATED_RECOVERY_CONNECTION_MISMATCH");
    const credentials=await tx.sourceCredential.findMany({select:{connectionId:true,kind:true,refreshOwner:true,refreshUntil:true}});
    if (credentials.length!==2 || new Set(credentials.map((row)=>row.kind)).size!==2 || credentials.some((row)=>
      row.connectionId!==connection.id || !["CAFE24_ACCESS","CAFE24_REFRESH"].includes(row.kind) ||
      row.refreshOwner!==null || row.refreshUntil!==null)) throw new Error("ISOLATED_RECOVERY_CREDENTIAL_BUSY");
    const lease=await tx.syncLease.findUnique({where:{connectionId:connection.id},select:{expiresAt:true}});
    if (lease && lease.expiresAt.getTime()>Date.now()) throw new Error("ISOLATED_RECOVERY_LEASE_ACTIVE");
    if (!connection.enabled) return {recoveryApplied:false,connectionEnabled:false,
      credentialAndAccessStatePreserved:true,lastSuccessAndCurrentPreserved:true,readonlyNoop:true};
    if (connection.updatedAt.getTime()>Date.now()-12*60_000) throw new Error("ISOLATED_RECOVERY_NOT_IDLE");
    const changed=await tx.sourceConnection.updateMany({where:{id:connection.id,enabled:true,
      updatedAt:connection.updatedAt},data:{enabled:false}});
    if (changed.count!==1) throw new Error("ISOLATED_RECOVERY_CONNECTION_CHANGED");
    await tx.securityAuditEvent.create({data:{actorType:"SYSTEM",action:"CAFE24_ISOLATED_CHILD_ENABLE_RECOVERY",
      targetType:"SOURCE_CONNECTION",targetId:connection.id,result:"SUCCESS",beforeJson:{enabled:true},afterJson:{enabled:false}}});
    return {recoveryApplied:true,connectionEnabled:false,credentialAndAccessStatePreserved:true,
      lastSuccessAndCurrentPreserved:true,readonlyNoop:false};
  },{timeout:5_000,maxWait:2_000});
}

const maxBytes = 512 * 1024;
export function approvedCafe24LiveProjection(request:Record<string,unknown>) {
  const fields=["approvedStatusCodes","projectionAcknowledgement","projectionVerifiedAt"];
  if (!fields.some(field=>request[field]!==undefined)) return {};
  const statuses=request.approvedStatusCodes;
  const verifiedAt=typeof request.projectionVerifiedAt==="string" ? Date.parse(request.projectionVerifiedAt) : NaN;
  if (request.projectionAcknowledgement!=="INCLUDE_ALL_REVIEWED_V1_ITEMS_FOR_06_DAY" ||
      !Array.isArray(statuses) || statuses.length<1 || statuses.length>32 ||
      !statuses.every(code=>typeof code==="string" && /^(?:[NCR][0-9]{2}|E00)$/.test(code)) ||
      new Set(statuses).size!==statuses.length || !Number.isFinite(verifiedAt) || verifiedAt>Date.now() ||
      Date.now()-verifiedAt>24*60*60_000) throw new Error("ISOLATED_REVIEWED_PROJECTION_REQUIRED");
  return {DAILY_SYNC_CAFE24_VERIFIED_V1_STATUSES:JSON.stringify([...statuses].sort()),
    DAILY_SYNC_CAFE24_RAW_ALL_ITEMS_V1_VERIFIED:"true",
    DAILY_SYNC_CAFE24_RAW_ALL_ITEMS_V1_VERIFIED_AT:new Date(verifiedAt).toLocaleDateString("sv-SE",{timeZone:"Asia/Seoul"})};
}
export function createCafe24LiveChildEnvironment(parent:NodeJS.ProcessEnv,request:Record<string,unknown>) {
  const env:NodeJS.ProcessEnv={...parent};
  for (const key of ["DAILY_SYNC_CAFE24_RAW_ALL_ITEMS_V1_VERIFIED","DAILY_SYNC_CAFE24_RAW_ALL_ITEMS_V1_VERIFIED_AT",
    "DAILY_SYNC_CAFE24_VERIFIED_V1_STATUSES","DAILY_SYNC_CAFE24_VERIFIED_NORMAL_STATUSES",
    "DAILY_SYNC_CAFE24_CHANGED_ITEM_V1_PARITY_VERIFIED","DAILY_SYNC_CAFE24_CHANGED_ITEM_V1_PARITY_VERIFIED_AT",
    "DAILY_SYNC_CAFE24_CHANGED_ITEM_V1_PARITY_VERIFIED_DAY"]) delete env[key];
  return Object.assign(env,{DAILY_SYNC_FEATURE_ENABLED:"true",
    DAILY_SYNC_CAFE24_LIVE_CHILD_ACK:"EXPLICIT_06_ONE_DAY_CANONICAL_CHILD",
    DAILY_SYNC_CAFE24_DAY_ACTIVATION_ENABLED:"true",
    DAILY_SYNC_CAFE24_SCHEDULED_API_ONLY_ACTIVATION_ENABLED:"false"},approvedCafe24LiveProjection(request));
}
const safeFields = new Set(["mode", "day", "runStatus", "failurePreserved", "configurationObservedAt",
  "configurationFingerprint", "configurationCounts", "configurationStateDigest","configurationDateRepairApplied","repairedDateFieldCount","repairedTimestampFieldCount","configurationRepairDataPreserved",
  "csvMappingReviewedLineCount","csvMappingChangedLineCount","csvMappingEquivalent","csvOriginalContentPreserved","csvUndatedMappingPreserved","csvRematchPerformed","currentApiLines", "apiVersionRows", "currentApiVersions",
  "currentApiLinks", "nullProviderUpdatedLines", "csvUndatedLines", "visibleCsvLines", "visibleApiLines",
  "coverageState", "inputDifferences", "lastSuccessPreserved", "primarySource", "providerCacheFreshnessVerified",
  "providerModificationTimeInvented", "authenticationEvidence", "activationSnapshotDigest", "calculationEvidence",
  "allProviderOrderStatusesAbsent","syncExecutionEvidence","connectionAccessState","connectionEnabled","credentialRevisions","providerFailureDiagnosticCode"]);
const countFields = new Set(["currentApiLines", "apiVersionRows", "currentApiVersions", "currentApiLinks",
  "nullProviderUpdatedLines", "csvUndatedLines", "visibleCsvLines", "visibleApiLines","repairedDateFieldCount","repairedTimestampFieldCount","csvMappingReviewedLineCount","csvMappingChangedLineCount"]);

export function validateLiveChildResult(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("ISOLATED_CHILD_RESPONSE_INVALID");
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((field) => !safeFields.has(field)) || result.day !== "2026-10-01" ||
      !["seed", "publish", "failure", "inspect", "activate", "rotate", "revoke","repair-configuration-dates"].includes(String(result.mode)) ||
      Object.entries(result).some(([field,cell]) => countFields.has(field) &&
        (field==="csvMappingChangedLineCount" && cell===null ? false : !Number.isSafeInteger(cell) || Number(cell)<0 || Number(cell)>100_000)))
    throw new Error("ISOLATED_CHILD_RESPONSE_INVALID");
  if (result.configurationObservedAt != null && (typeof result.configurationObservedAt !== "string" ||
      !Number.isFinite(Date.parse(result.configurationObservedAt)))) throw new Error("ISOLATED_CHILD_RESPONSE_INVALID");
  if (result.configurationFingerprint != null && (typeof result.configurationFingerprint !== "string" ||
      !/^[a-f0-9]{64}$/.test(result.configurationFingerprint))) throw new Error("ISOLATED_CHILD_RESPONSE_INVALID");
  if (result.activationSnapshotDigest != null && (typeof result.activationSnapshotDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(result.activationSnapshotDigest))) throw new Error("ISOLATED_CHILD_RESPONSE_INVALID");
  if(result.configurationStateDigest!=null && (typeof result.configurationStateDigest!=="string" || !/^[a-f0-9]{64}$/.test(result.configurationStateDigest)))throw new Error("ISOLATED_CHILD_RESPONSE_INVALID");
  if(result.connectionAccessState!==undefined && !["PENDING","READY","REAUTH_REQUIRED","BLOCKED"].includes(String(result.connectionAccessState)))throw new Error("ISOLATED_CHILD_RESPONSE_INVALID");
  if(result.connectionEnabled!==undefined && typeof result.connectionEnabled!=="boolean")throw new Error("ISOLATED_CHILD_RESPONSE_INVALID");
  if(result.providerFailureDiagnosticCode!==undefined && result.providerFailureDiagnosticCode!==null && !isCafe24FailureDiagnosticCode(result.providerFailureDiagnosticCode))throw new Error("ISOLATED_CHILD_RESPONSE_INVALID");
  if(result.credentialRevisions!==undefined && (!Array.isArray(result.credentialRevisions) || result.credentialRevisions.length!==2 ||
    result.credentialRevisions.some(value=>!Number.isSafeInteger(value)||value<1)))throw new Error("ISOLATED_CHILD_RESPONSE_INVALID");
  if(result.syncExecutionEvidence!==undefined) {
    const evidence=result.syncExecutionEvidence as Record<string,unknown>;
    if(!evidence || typeof evidence!=="object" || Array.isArray(evidence) || Object.keys(evidence).sort().join(",")!=="lastRunStatus,lastSafeCode,leaseActive,leasePresent,runCount,runPresent,runStatuses,selection,unitCount,unitStatuses" ||
      typeof evidence.runPresent!=="boolean" || typeof evidence.leasePresent!=="boolean" || typeof evidence.leaseActive!=="boolean" ||
      (evidence.leaseActive&&!evidence.leasePresent) || !Number.isSafeInteger(evidence.unitCount) || Number(evidence.unitCount)<0 || Number(evidence.unitCount)>32 ||
      !Number.isSafeInteger(evidence.runCount) || Number(evidence.runCount)<0 || Number(evidence.runCount)>100000 ||
      !Array.isArray(evidence.runStatuses) || evidence.runStatuses.length>7 || new Set(evidence.runStatuses).size!==evidence.runStatuses.length ||
      evidence.runStatuses.some(value=>!["QUEUED","RUNNING","SUCCEEDED","PARTIAL","FAILED","ACTION_REQUIRED","CANCELLED"].includes(String(value))) ||
      !["NONE","ONLY_DAY_RUN","LATEST_STARTED_RUN","AMBIGUOUS_RUN_ORDER"].includes(String(evidence.selection)) ||
      !Array.isArray(evidence.unitStatuses) || evidence.unitStatuses.length>5 || new Set(evidence.unitStatuses).size!==evidence.unitStatuses.length ||
      evidence.unitStatuses.some(value=>!["QUEUED","RUNNING","SUCCEEDED","FAILED","ACTION_REQUIRED"].includes(String(value))) ||
      (evidence.lastRunStatus!==null && !["QUEUED","RUNNING","SUCCEEDED","PARTIAL","FAILED","ACTION_REQUIRED","CANCELLED"].includes(String(evidence.lastRunStatus))) ||
      (evidence.lastSafeCode!==null && (typeof evidence.lastSafeCode!=="string" || !SAFE_SYNC_CODES.has(evidence.lastSafeCode))) ||
      (!evidence.runPresent && (evidence.runCount!==0 || evidence.runStatuses.length!==0 || evidence.selection!=="NONE" || evidence.lastRunStatus!==null || evidence.lastSafeCode!==null || evidence.unitCount!==0 || evidence.unitStatuses.length!==0)) ||
      (evidence.runPresent && (Number(evidence.runCount)<1 || evidence.runStatuses.length<1 || evidence.selection==="NONE")) ||
      (evidence.selection==="AMBIGUOUS_RUN_ORDER" && (evidence.lastRunStatus!==null || evidence.lastSafeCode!==null || evidence.unitCount!==0 || evidence.unitStatuses.length!==0)))throw new Error("ISOLATED_CHILD_RESPONSE_INVALID");
  }
  for (const field of ["runStatus","coverageState","primarySource"])
    if (result[field] != null && (typeof result[field] !== "string" || !/^[A-Z_]{1,64}$/.test(result[field] as string)))
      throw new Error("ISOLATED_CHILD_RESPONSE_INVALID");
  for (const field of ["failurePreserved", "lastSuccessPreserved", "providerCacheFreshnessVerified", "providerModificationTimeInvented","allProviderOrderStatusesAbsent","configurationDateRepairApplied","configurationRepairDataPreserved","csvMappingEquivalent","csvOriginalContentPreserved","csvUndatedMappingPreserved","csvRematchPerformed"])
    if (result[field] != null && typeof result[field] !== "boolean") throw new Error("ISOLATED_CHILD_RESPONSE_INVALID");
  if (result.configurationCounts != null) {
    const counts = result.configurationCounts as Record<string, unknown>;
    if (!counts || typeof counts !== "object" || Array.isArray(counts) ||
        Object.keys(counts).sort().join(",") !== "costRules,couponRules,productRules,products" ||
        Object.values(counts).some((count) => !Number.isSafeInteger(count) || Number(count)<0 || Number(count)>1000))
      throw new Error("ISOLATED_CHILD_RESPONSE_INVALID");
  }
  if (result.inputDifferences != null) {
    const counts = result.inputDifferences as Record<string, unknown>;
    if (!counts || typeof counts !== "object" || Array.isArray(counts) ||
        Object.keys(counts).sort().join(",") !== "couponSignalOrders,paidOrders,paymentMethodOrders,productNameOrders,totalOrderOrders" ||
        Object.entries(counts).some(([field,count]) => count===null ? !["couponSignalOrders","productNameOrders"].includes(field) :
          !Number.isSafeInteger(count) || Number(count)<0 || Number(count)>422) ||
        ["couponSignalOrders","productNameOrders"].some(field=>counts[field]!==null && Number(counts[field])>0 && Number(counts[field])<10))
      throw new Error("ISOLATED_CHILD_RESPONSE_INVALID");
  }
  if (result.authenticationEvidence != null) {
    const evidence=result.authenticationEvidence as Record<string,unknown>;
    const allowed=new Set(["tokenPairRotated","priorRevisions","currentRevisions","tokenCopied",
      "providerRevocationSucceeded","realReadAuthenticationFailure","reauthRequired",
      "lastSuccessAndCurrentPreserved","oldPairRestored"]);
    if (!evidence || typeof evidence !== "object" || Array.isArray(evidence) ||
        Object.keys(evidence).some((field) => !allowed.has(field)) ||
        Object.entries(evidence).some(([field,cell]) => field.endsWith("Revisions")
          ? !Array.isArray(cell) || cell.length !== 2 || cell.some((revision) => !Number.isSafeInteger(revision) || revision<1)
          : typeof cell !== "boolean")) throw new Error("ISOLATED_CHILD_RESPONSE_INVALID");
  }
  if (result.calculationEvidence != null) {
    const evidence=result.calculationEvidence as Record<string,unknown>;
    const counts=new Set(["matchedLineCount","unmatchedLineCount","missingCostProductCount",
      "couponRuleFitOrderCount","couponEstimatedOrderCount","couponUnmatchedOrderCount","couponUnknownOrderCount",
      "paymentComponentMismatchOrders","paymentComponentUnavailableOrders"]);
    const amounts=new Set(["revenueKrw","grossCostKrw","couponDeductionKrw","marginBeforeAdSpendKrw"]);
    const allowed=new Set(["day","projectionScope","completeProjection","warningCodes","sourceLineCounts",...counts,...amounts,"adSpendKrw","fullMarginKrw"]);
    if (!evidence || typeof evidence!=="object" || Array.isArray(evidence) || evidence.day!=="2026-10-01" ||
        Object.keys(evidence).length!==allowed.size || Object.keys(evidence).some((field)=>!allowed.has(field)) ||
        Object.entries(evidence).some(([field,cell])=> counts.has(field)
          ? cell!==null && (!Number.isSafeInteger(cell) || Number(cell)<0 || Number(cell)>100_000)
          : amounts.has(field) && cell!==null && (typeof cell!=="number" || !Number.isFinite(cell) || Math.abs(cell)>1e12)) ||
        evidence.adSpendKrw!==null || evidence.fullMarginKrw!==null || typeof evidence.completeProjection!=="boolean" ||
        !["COMPLETE_API_DAY","DATED_CSV_ROWS"].includes(String(evidence.projectionScope)) ||
        !Array.isArray(evidence.warningCodes) || evidence.warningCodes.some((code)=>!["CAFE24_DIAGNOSTIC_SCOPE_UNVERIFIED",
          "CAFE24_PAYMENT_COMPONENTS_DIFFER","CAFE24_PAYMENT_COMPONENTS_UNAVAILABLE","CAFE24_COUPON_SIGNAL_UNKNOWN",
          "CAFE24_DIAGNOSTIC_SMALL_UNMATCHED_COHORT","CAFE24_MATCHED_ONLY_CALCULATION"].includes(code)))
      throw new Error("ISOLATED_CHILD_RESPONSE_INVALID");
    const source=evidence.sourceLineCounts as Record<string,unknown>;
    if (!source || typeof source!=="object" || Array.isArray(source) || Object.keys(source).sort().join(",")!=="api,csv" ||
        Object.values(source).some((cell)=>cell!==null && (!Number.isSafeInteger(cell) || Number(cell)<0 || Number(cell)>100_000)))
      throw new Error("ISOLATED_CHILD_RESPONSE_INVALID");
    const coupon=["couponRuleFitOrderCount","couponEstimatedOrderCount","couponUnmatchedOrderCount","couponUnknownOrderCount"];
    const suppressedCoupon=coupon.some(field=>evidence[field]===null);
    if ((suppressedCoupon && coupon.some(field=>evidence[field]!==null)) ||
        coupon.some(field=>evidence[field]!==null && Number(evidence[field])>0 && Number(evidence[field])<10) ||
        (Object.values(source).some(cell=>cell===null) && (Object.values(source).some(cell=>cell!==null) ||
          evidence.matchedLineCount!==null || evidence.unmatchedLineCount!==null || [...amounts].some(field=>evidence[field]!==null))) ||
        (!evidence.completeProjection && ([...counts,...amounts].some(field=>evidence[field]!==null) ||
          Object.values(source).some(cell=>cell!==null))) ||
        (evidence.completeProjection && Object.values(source).every(cell=>cell!==null) &&
          Number(source.api)+Number(source.csv)<10))
      throw new Error("ISOLATED_CHILD_RESPONSE_INVALID");
  }
  return result;
}

/** One child at a time is enforced by the existing authenticated callback job.
 * This process retains FEATURE_OFF. Only the exact child receives FEATURE_ON. */
export function runCafe24LiveChild(prisma: PrismaClient, request: Record<string, unknown>) {
  const running=runChild(prisma,request);
  const closure=running.then(() => undefined,() => undefined);
  childClosures.add(closure);
  void closure.then(() => childClosures.delete(closure));
  return running;
}

async function runChild(prisma: PrismaClient, request: Record<string, unknown>) {
  const stage:{value:typeof LIVE_CHILD_STAGES[number]}={value:"PARENT_INPUT"};
  try {return await runChildBody(prisma,request,stage);}
  catch(error) {throw error instanceof Cafe24LiveChildFailure?error:parseLiveChildFailure(liveChildFailure(error,stage.value));}
}
async function runChildBody(prisma:PrismaClient,request:Record<string,unknown>,stage:{value:typeof LIVE_CHILD_STAGES[number]}) {
  assertLiveSetupEnvironment(process.env);
  if (!request || request.day !== "2026-10-01" ||
      !["seed","publish","failure","inspect","activate","rotate","revoke","repair-configuration-dates"].includes(String(request.mode)))
    throw new Error("ISOLATED_CHILD_INPUT_INVALID");
  const childEnv=createCafe24LiveChildEnvironment(process.env,request);
  const bytes = Buffer.from(JSON.stringify(request));
  if (bytes.length > maxBytes) { bytes.fill(0); throw new Error("ISOLATED_CHILD_INPUT_LIMIT"); }
  stage.value="PARENT_CONNECTION";
  const connections = await prisma.sourceConnection.findMany({ where: {
    provider: "CAFE24", externalAccountId: "didadi0729", shopKey: "shop1"
  }, select: { id: true, enabled: true, accessState: true, updatedAt: true } });
  const connection = connections[0];
  if (connections.length !== 1 || !connection || connection.enabled ||
      (request.mode !== "inspect" && connection.accessState !== "READY")) {
    bytes.fill(0); throw new Error("ISOLATED_CHILD_CONNECTION_NOT_READY");
  }
  let temporaryEnabled = false;
  try {
    if (request.mode !== "inspect") {
      stage.value="PARENT_ENABLE";
      const changed = await prisma.sourceConnection.updateMany({ where: { id: connection.id,
        provider: "CAFE24", enabled: false, accessState: "READY", updatedAt: connection.updatedAt },
      data: { enabled: true } });
      if (changed.count !== 1) throw new Error("ISOLATED_CHILD_CONNECTION_CHANGED");
      temporaryEnabled = true;
    }
    if (request.mode === "revoke") {
      if (typeof request.registeredRedirectVerifiedAt !== "string" ||
          !Number.isFinite(Date.parse(request.registeredRedirectVerifiedAt)))
        throw new Error("REGISTERED_ISOLATED_REDIRECT_EVIDENCE_REQUIRED");
      Object.assign(childEnv,{ DAILY_SYNC_CAFE24_REGISTERED_ISOLATED_REDIRECT_VERIFIED:"true",
        DAILY_SYNC_CAFE24_REGISTERED_ISOLATED_REDIRECT_VERIFIED_AT:request.registeredRedirectVerifiedAt });
    }
    const result = await new Promise<Record<string, unknown>>((resolveResult,reject) => {
      const child = spawn(process.execPath,[resolve(__dirname,"cafe24-live-canonical.cli.js")], {
        env: childEnv, stdio: ["pipe","pipe","pipe"], windowsHide: true
      });
      liveChildren.add(child);
      const output: Buffer[] = [];
      let outputBytes=0;
      let failed:typeof LIVE_CHILD_GUARDS[number]|null=null;
      const fail = (guard:typeof LIVE_CHILD_GUARDS[number]) => {failed??=guard;child.kill("SIGTERM");};
      const timeout = setTimeout(()=>fail("CHILD_TIMEOUT"), 10*60_000 + 30_000);
      timeout.unref();
      child.on("error",()=>fail("CHILD_SPAWN_FAILED"));
      child.stdin.on("error",()=>fail("CHILD_STDIN_FAILED"));
      child.stdout.on("data",(chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes>32*1024) { chunk.fill(0); fail("CHILD_OUTPUT_LIMIT"); return; }
        output.push(chunk);
      });
      // Never echo Prisma/provider error text or arbitrary stderr to the parent.
      child.stderr.on("data",(chunk: Buffer) => chunk.fill(0));
      child.on("close",(code,signal) => {
        liveChildren.delete(child);
        clearTimeout(timeout);
        const body=Buffer.concat(output);
        try {
          if (failed) throw processLiveChildFailure(failed,code,signal);
          if (!body.length)throw processLiveChildFailure("CHILD_OUTPUT_EMPTY",code,signal);
          let parsed:unknown;
          try {parsed=JSON.parse(body.toString("utf8"));}catch {throw processLiveChildFailure("CHILD_OUTPUT_INVALID_JSON",code,signal);}
          if (code !== 0) {
            try {throw parseLiveChildFailure(parsed);}catch(error) {
              throw error instanceof Cafe24LiveChildFailure?error:processLiveChildFailure("CHILD_OUTPUT_INVALID_FAILURE",code,signal);
            }
          }
          try {resolveResult(validateLiveChildResult(parsed));}catch {throw processLiveChildFailure("CHILD_OUTPUT_INVALID_RESULT",code,signal);}
        } catch (error) { reject(error instanceof Cafe24LiveChildFailure ? error : processLiveChildFailure("CHILD_OUTPUT_INVALID_RESULT",code,signal)); }
        finally { body.fill(0); output.forEach((chunk) => chunk.fill(0)); }
      });
      child.stdin.end(bytes,() => bytes.fill(0));
    });
    return result;
  } finally {
    bytes.fill(0);
    if (temporaryEnabled) {
      const previousStage=stage.value;
      stage.value="PARENT_RESTORE";
      // Preserve any READY/REAUTH_REQUIRED/credential rotation changes. Restore
      // only enabled=false, with a fresh metadata CAS and bounded retries.
      let restored=false;
      for (let attempt=0; attempt<3; attempt++) {
        const current=await prisma.sourceConnection.findUnique({ where: { id: connection.id },
          select: { enabled: true, updatedAt: true } });
        if (!current) throw new Error("ISOLATED_CHILD_CONNECTION_MISSING");
        if (!current.enabled) { restored=true; break; }
        const changed=await prisma.sourceConnection.updateMany({ where: { id: connection.id,
          provider: "CAFE24", externalAccountId: "didadi0729", shopKey: "shop1",
          enabled: true, updatedAt: current.updatedAt }, data: { enabled: false } });
        if (changed.count===1) { restored=true; break; }
      }
      if (!restored) throw new Error("ISOLATED_CHILD_DISABLE_NOT_CONFIRMED");
      stage.value=previousStage;
    }
  }
}
