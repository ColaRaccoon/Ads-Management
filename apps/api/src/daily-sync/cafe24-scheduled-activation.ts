import {PrismaService} from "../common/prisma.service";
import {SourceConnectionsService} from "./source-connections.service";
import {Prisma} from "@prisma/client";

async function publishedPolicyVersion(db:PrismaService|Prisma.TransactionClient,runId:string,day:string) {
  const events=await db.securityAuditEvent.findMany({where:{action:"SYNC_UNIT_PUBLISHED",targetType:"RUN_UNIT",targetId:`${runId}:${day}`,result:"SUCCESS"},take:2});
  if(events.length!==1 || !events[0].afterJson || typeof events[0].afterJson!=="object" || Array.isArray(events[0].afterJson)) return null;
  const version=events[0].afterJson.sourcePolicyVersion;
  return typeof version==="number" && Number.isSafeInteger(version) && version>=1 ? version : null;
}

/** A successful shadow fetch alone is not a successful scheduled API source. */
export async function cafe24ScheduledDayActivated(db:PrismaService, connectionId:string, day:string, runId:string) {
  const date=new Date(`${day}T00:00:00.000Z`);
  const next=new Date(date);next.setUTCDate(next.getUTCDate()+1);
  return db.$transaction(async tx=>{
    const run=await tx.syncRun.findUnique({where:{id:runId},include:{units:true}});
    const policies=await tx.sourcePolicy.findMany({where:{connectionId,dataKind:"CAFE24_ORDER",fromDate:{lte:date},OR:[{toDate:null},{toDate:{gt:date}}]}});
    const coverage=await tx.sourceCoverage.findUnique({where:{connectionId_dataKind_metricDate:{connectionId,dataKind:"CAFE24_ORDER",metricDate:date}}});
    const originalVersion=await publishedPolicyVersion(tx,runId,day);
    if(!run || run.connectionId!==connectionId || run.trigger!=="SCHEDULED" || run.status!=="SUCCEEDED" ||
      run.fromDate.getTime()!==date.getTime() || run.toDate.getTime()!==date.getTime() || run.units.length!==1 ||
      run.units[0].unitKey!==day || run.units[0].status!=="SUCCEEDED" || !coverage || coverage.source!=="API" ||
      !["COMPLETE_ZERO","COMPLETE_NONZERO"].includes(coverage.state) || coverage.lastSuccessRunId!==runId ||
      coverage.lastAttemptRunId!==runId || !coverage.lastSuccessAt || coverage.rowCount!==run.units[0].publishedCount ||
      coverage.reconciliationStatus!=="CAFE24_API_ONLY_VERIFIED" ||
      coverage.warningCodes.some(code=>["CAFE24_SHADOW_NOT_PRIMARY","CAFE24_SOURCE_ACTIVATION_REQUIRED"].includes(code)) ||
      policies.length!==1 || policies[0].primarySource!=="API" || policies[0].reason!=="CAFE24_SCHEDULED_API_ONLY" ||
      policies[0].fromDate.getTime()!==date.getTime() || policies[0].toDate?.getTime()!==next.getTime() ||
      originalVersion===null || ![originalVersion,originalVersion+1].includes(policies[0].version) ||
      !["UNKNOWN","API_ACTUAL_PRODUCT_PLUS_SHIPPING"].includes(policies[0].couponInputSource??"")) return false;
    // An unchanged API snapshot keeps its original version/line/link owner. The
    // new fenced publication has its own unit, coverage and policy-version audit;
    // never rewrite historical ownership just to repeat a successful API day.
    const apiBaseline=policies[0].version===originalVersion;
    const [counts]=await tx.$queryRaw<Array<{rows:bigint;valid:bigint;versions:bigint}>>`
      SELECT count(*) AS rows, count(*) FILTER(WHERE EXISTS(
        SELECT 1 FROM source_record_links l JOIN cafe24_order_api_versions a
          ON a.canonical_key_hash=l.canonical_key_hash AND a.version=l.version
          AND a.connection_id=l.connection_id AND a.is_current
          AND a.order_date=${date}::date
        WHERE l.record_id=o.id AND l.record_table='cafe24_order_lines' AND l.data_kind='CAFE24_ORDER'
          AND l.source='API' AND l.connection_id=${connectionId}::uuid AND l.is_current
          AND l.sync_run_id=a.sync_run_id AND o.sync_run_id=a.sync_run_id AND l.version=o.import_version
          AND (a.sync_run_id=${runId}::uuid OR (${apiBaseline} AND EXISTS(
            SELECT 1 FROM sync_runs prior JOIN run_units unit ON unit.run_id=prior.id
            WHERE prior.id=a.sync_run_id AND prior.connection_id=${connectionId}::uuid
              AND prior.status='SUCCEEDED'
              AND prior.from_date=${date}::date AND prior.to_date=${date}::date
              AND unit.unit_key=${day} AND unit.status='SUCCEEDED')))
          AND a.order_no=o.order_no AND a.line_order_no=o.line_order_no
          AND a.product_no=o.product_no AND a.option_name=o.option_name)) AS valid,
        (SELECT count(*) FROM cafe24_order_api_versions a WHERE a.connection_id=${connectionId}::uuid
          AND a.order_date=${date}::date AND a.is_current) AS versions
      FROM cafe24_order_lines o WHERE o.connection_id=${connectionId}::uuid AND o.order_date=${date}::date
        AND o.source='API' AND o.is_current`;
    return !!counts && Number(counts.rows)===coverage.rowCount && Number(counts.valid)===coverage.rowCount && Number(counts.versions)===coverage.rowCount;
  },{timeout:5000,maxWait:2000,isolationLevel:"RepeatableRead"});
}

/** Reconcile only the already committed same-day snapshot; never fetch a provider. */
export async function reconcileCafe24ScheduledDay(db:PrismaService,connectionId:string,day:string,runId:string) {
  if(await cafe24ScheduledDayActivated(db,connectionId,day,runId)) return true;
  if(process.env.DAILY_SYNC_CAFE24_SCHEDULED_API_ONLY_ACTIVATION_ENABLED!=="true") return false;
  const coupon=process.env.DAILY_SYNC_CAFE24_SCHEDULED_COUPON_INPUT_SOURCE;
  if(coupon!=="UNKNOWN" && coupon!=="API_ACTUAL_PRODUCT_PLUS_SHIPPING") return false;
  const date=new Date(`${day}T00:00:00.000Z`);
  const policies=await db.sourcePolicy.findMany({where:{connectionId,dataKind:"CAFE24_ORDER",fromDate:{lte:date},OR:[{toDate:null},{toDate:{gt:date}}]}});
  const originalVersion=await publishedPolicyVersion(db,runId,day);
  if(policies.length!==1 || policies[0].primarySource!=="CSV" || originalVersion===null || policies[0].version!==originalVersion || policies[0].couponInputSource!==coupon) return false;
  try {
    await new SourceConnectionsService(db).activateCafe24Day(connectionId,{day,expectedPolicyVersion:policies[0].version,
      expectedSuccessRunId:runId,reason:"CAFE24_SCHEDULED_API_ONLY",mode:"API_ONLY",couponInputSource:coupon},null);
  } catch {
    // A committed promotion with a lost response remains successful.
  }
  return cafe24ScheduledDayActivated(db,connectionId,day,runId);
}
