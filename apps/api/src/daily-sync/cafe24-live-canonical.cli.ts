import {reviewCafe24LiveInputCounts,suppressCafe24LiveInputCounts} from "./cafe24-live-input-review";
import {isSafeCafe24LiveCsvCell} from "./cafe24-live-csv-input";
import "reflect-metadata";
import { createHash, randomUUID } from "node:crypto";
import { Prisma, PrismaClient, ConflictPolicy, SourceDataKind, SourceKind, SyncTrigger } from "@prisma/client";
import { PrismaService } from "../common/prisma.service";
import { selectCurrentSourceRows } from "../common/source-read-policy";
import { CAFE24_ORDER_COLUMN_ALIASES, Cafe24CsvParser } from "../domain/cafe24-csv";
import { hasCafe24CouponPaymentToken } from "../domain/cafe24-coupon-matcher";
import { Cafe24UploadsService, isCompleteCafe24UploadBatch } from "../sales/cafe24-uploads.service";
import { SalesMetricsService } from "../sales/sales-metrics.service";
import { CredentialVault } from "./credential-vault";
import { Cafe24OauthService } from "./cafe24-oauth.service";
import { Cafe24OrdersClient } from "./cafe24-orders.client";
import { Cafe24SyncRunnerService } from "./cafe24-sync-runner.service";
import { Cafe24CanonicalWriterService } from "./cafe24-canonical-writer.service";
import { SourceConnectionsService } from "./source-connections.service";
import { SyncFoundationService } from "./sync-foundation.service";
import { ProviderFailure } from "./bounded-request";
import { cafe24TestAccount } from "./cafe24-test-connection.service";
import { rotateCafe24LiveCredential, revokeCafe24LiveCredential } from "./cafe24-live-auth";
import { computeCafe24ActivationEvidence } from "./cafe24-activation-evidence";
import {safeSyncCode} from "./sync-contract";
import {isCafe24FailureDiagnosticCode} from "./cafe24-failure-diagnostic";
import { liveChildFailure,LIVE_CHILD_STAGES } from "./cafe24-live-failure";
import {configurationStateDigest,repairConfigurationDates,seedConfiguration} from "./cafe24-live-configuration";
import {assertCafe24OptionCapacity} from "./cafe24-live-option-capacity";
let childStage:typeof LIVE_CHILD_STAGES[number]="CHILD_INPUT";

// This file is a child-process entrypoint. The callback remains feature-off.
// No credential is transported through stdin/stdout or copied to another DB.
const day = "2026-10-01";
const dayDate = new Date(`${day}T00:00:00.000Z`);
const actorName = "Cafe24 phase06 isolated canonical operator";
const expectedTables = ["app_users", "cafe24_coupon_rules", "cafe24_oauth_attempts",
  "cafe24_observed_day_checkpoints", "cafe24_observed_order_revisions", "cafe24_order_api_versions",
  "cafe24_order_lines", "cafe24_product_rules", "cafe24_upload_batches", "cafe24_upload_row_errors",
  "exchange_rates", "product_cost_rules", "products", "run_units", "security_audit_events",
  "source_connections", "source_coverage", "source_credentials", "source_policies",
  "source_record_links", "sync_leases", "sync_runs"].sort();
const csvFields = ["orderNo", "lineOrderNo", "productNo", "productName", "optionName", "quantity",
  "salePriceKrw", "totalOrderKrw", "totalPaidKrw", "paymentMethod", "orderedAt"] as const;
type Mode = "seed" | "publish" | "failure" | "inspect" | "activate" | "rotate" | "revoke" | "repair-configuration-dates";

export function assertLiveCanonicalEnvironment(env: NodeJS.ProcessEnv) {
  if (env.RAILWAY_PROJECT_ID !== "d72f4256-8632-437a-9dae-9b5d96736fc7" ||
      env.RAILWAY_ENVIRONMENT_ID !== "d261a432-a6a4-4031-b8ea-c619ac263cc3" ||
      env.RAILWAY_SERVICE_ID !== "deaaeaf9-ee5c-42fa-b32f-600c7a90befc" ||
      env.DAILY_SYNC_CAFE24_DB_SERVICE_ID !== "ef46528f-4b59-4ee6-9d9c-b0852b5a9274" ||
      env.DAILY_SYNC_CAFE24_LIVE_CHILD_ACK !== "EXPLICIT_06_ONE_DAY_CANONICAL_CHILD" ||
      env.DAILY_SYNC_CAFE24_TEST_ENABLED !== "true" || env.DAILY_SYNC_FEATURE_ENABLED !== "true")
    throw new Error("ISOLATED_CANONICAL_CHILD_REQUIRED");
  let url: URL;
  try { url = new URL(env.DATABASE_URL ?? ""); }
  catch { throw new Error("ISOLATED_DATABASE_REQUIRED"); }
  if (!env.DAILY_SYNC_CAFE24_DB_HOST?.endsWith(".railway.internal") ||
      !env.DAILY_SYNC_CAFE24_DB_NAME || url.hostname !== env.DAILY_SYNC_CAFE24_DB_HOST ||
      !["postgres:", "postgresql:"].includes(url.protocol) || url.port !== "5432" ||
      url.pathname !== `/${env.DAILY_SYNC_CAFE24_DB_NAME}` || !url.username || !url.password ||
      [...url.searchParams.keys()].some((key) => key !== "schema") ||
      (url.searchParams.get("schema") ?? "public") !== "public")
    throw new Error("ISOLATED_DATABASE_REQUIRED");
  const account = cafe24TestAccount(env);
  if (account.mallId !== "didadi0729" || account.shopKey !== "shop1")
    throw new Error("ISOLATED_ACCOUNT_REQUIRED");
}

async function readInput() {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 512 * 1024) throw new Error("CANONICAL_INPUT_LIMIT");
    chunks.push(bytes);
  }
  const inputBytes = Buffer.concat(chunks);
  try {
    const value: unknown = JSON.parse(inputBytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("CANONICAL_INPUT_INVALID");
    const input = value as Record<string, unknown>;
    if (Object.keys(input).some((key) => !["mode", "day", "csvRows", "configuration", "acknowledgement", "couponInputSource", "registeredRedirectVerifiedAt", "expectedInputDifferences", "expectedSnapshotDigest",
      "approvedStatusCodes","projectionAcknowledgement","projectionVerifiedAt","expectedConfigurationDigest"].includes(key)) ||
        input.day !== day || !["seed", "publish", "failure", "inspect", "activate", "rotate", "revoke","repair-configuration-dates"].includes(String(input.mode)))
      throw new Error("CANONICAL_INPUT_INVALID");
    return input as Record<string, unknown> & { mode: Mode; day: string };
  } finally { inputBytes.fill(0); chunks.forEach((chunk) => chunk.fill(0)); }
}

async function assertDatabase(prisma: PrismaClient, mode: Mode) {
  const [identity] = await prisma.$queryRaw<Array<{ database: string; schema: string }>>`
    SELECT current_database() AS database, current_schema() AS schema`;
  if (identity?.database !== process.env.DAILY_SYNC_CAFE24_DB_NAME || identity.schema !== "public")
    throw new Error("ISOLATED_DATABASE_IDENTITY_MISMATCH");
  const tables = await prisma.$queryRaw<Array<{ name: string }>>`
    SELECT table_name AS name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`;
  if (JSON.stringify(tables.map((table) => table.name)) !== JSON.stringify(expectedTables))
    throw new Error("ISOLATED_SCHEMA_INVENTORY_MISMATCH");
  await assertCafe24OptionCapacity(prisma);
  const connections = await prisma.sourceConnection.findMany();
  const connection = connections[0];
  if (connections.length !== 1 || connection.provider !== "CAFE24" ||
      connection.externalAccountId !== "didadi0729" || connection.shopKey !== "shop1" ||
      (mode !== "inspect" && (!connection.enabled || connection.accessState !== "READY")) ||
      connection.currencyCode !== "KRW" || connection.timeZone !== "Asia/Seoul")
    throw new Error("ISOLATED_CONNECTION_MISMATCH");
  const credentials = await prisma.sourceCredential.findMany({
    select: { connectionId: true, kind: true, revision: true, keyVersion: true }
  });
  if (credentials.length !== 2 || new Set(credentials.map((row) => row.kind)).size !== 2 ||
      credentials.some((row) => row.connectionId !== connection.id ||
        !["CAFE24_ACCESS", "CAFE24_REFRESH"].includes(row.kind) || row.revision < 1 || row.keyVersion < 1))
    throw new Error("ISOLATED_CREDENTIAL_OWNER_MISMATCH");
  return connection;
}

function safeCsv(value: unknown) {
  if (!Array.isArray(value) || value.length !== 477 || value.some((row) =>
    !Array.isArray(row) || row.length !== csvFields.length || row.some((cell,index) => !isSafeCafe24LiveCsvCell(cell,index))))
    throw new Error("CANONICAL_CSV_INPUT_INVALID");
  const quote = (cell: string) => `"${cell.replaceAll('"', '""')}"`;
  const csv = `${csvFields.map((key) => quote(CAFE24_ORDER_COLUMN_ALIASES[key][0])).join(",")}\n` +
    value.map((row: string[]) => row.map(quote).join(",")).join("\n") + "\n";
  const buffer = Buffer.from(csv, "utf8");
  const parser = new Cafe24CsvParser();
  const parsed = parser.parseBuffer(buffer).rows.map((row) => parser.parseRow(row).parsedRow);
  if (parsed.some((row) => !row || (row.orderDate && row.orderDate.getTime() !== dayDate.getTime())) ||
      new Set(parsed.map((row) => row!.orderNo)).size !== 422)
    throw new Error("CANONICAL_CSV_SCOPE_MISMATCH");
  // Blank dates and sibling timestamps remain exactly as supplied by the CSV.
  return buffer;
}

class PartiallyFailingOrdersClient extends Cafe24OrdersClient {
  private itemReads = 0;
  protected override async getJson(url: URL, token: string, deadlineAt: number) {
    if (url.pathname.endsWith("/items") && ++this.itemReads === 3)
      throw new ProviderFailure("PARTIAL_PAGE", false);
    return super.getJson(url, token, deadlineAt);
  }
}

async function snapshotState(prisma: PrismaClient, connectionId: string) {
  const scope = { connectionId, orderDate: dayDate, source: SourceKind.API };
  const [rows, versions, links, coverage, policies, csvUndated] = await Promise.all([
    prisma.cafe24OrderLine.findMany({ where: { ...scope, isCurrent: true }, orderBy: { id: "asc" } }),
    prisma.cafe24OrderApiVersion.findMany({ where: { connectionId, orderDate: dayDate },
      select: { id: true, version: true, isCurrent: true, contentFingerprint: true, fetchedAt: true,orderStatus:true }, orderBy: { id: "asc" } }),
    prisma.sourceRecordLink.findMany({ where: { connectionId, dataKind: SourceDataKind.CAFE24_ORDER,
      source: SourceKind.API }, orderBy: { id: "asc" } }),
    prisma.sourceCoverage.findUnique({ where: { connectionId_dataKind_metricDate: {
      connectionId, dataKind: SourceDataKind.CAFE24_ORDER, metricDate: dayDate } } }),
    prisma.sourcePolicy.findMany({ where: { connectionId, dataKind: SourceDataKind.CAFE24_ORDER,
      fromDate: { lte: dayDate }, OR: [{ toDate: null }, { toDate: { gt: dayDate } }] } }),
    prisma.cafe24OrderLine.count({ where: { connectionId, source: SourceKind.CSV, orderDate: null } })
  ]);
  // This digest stays in the child process and is never returned or persisted.
  const privateDigest = createHash("sha256").update(JSON.stringify({ rows, versions, links })).digest("hex");
  return { privateDigest, currentLines: rows.length, versionRows: versions.length,
    currentOrderCount:new Set(rows.map((row)=>row.orderNo)).size,
    currentVersions: versions.filter((row) => row.isCurrent).length,
    currentLinks: links.filter((row) => row.isCurrent).length,
    allProviderOrderStatusesAbsent:rows.length===477&&versions.filter(row=>row.isCurrent).length===477&&coverage?.lastSuccessRunId ? versions.filter(row=>row.isCurrent).every(row=>row.orderStatus===null):null,
    nullProviderUpdatedLines: rows.filter((row) => row.providerUpdatedAt === null).length,
    coverage, policies, csvUndated };
}

async function inputDifferences(prisma: PrismaClient, connectionId: string) {
  const rows = await prisma.cafe24OrderLine.findMany({ where: { connectionId, isCurrent: true,
    OR: [{ orderDate: dayDate }, { source: SourceKind.CSV, orderDate: null }] } });
  const api = rows.filter((row) => row.source === SourceKind.API);
  const key = (row: typeof rows[number]) => JSON.stringify([row.orderNo,row.lineOrderNo,row.productNo,row.optionName].map((part) => part.trim()));
  const csv = new Map(rows.filter((row) => row.source === SourceKind.CSV).map((row) => [key(row),row]));
  const differences = { totalOrderOrders: new Set<string>(), paidOrders: new Set<string>(),
    paymentMethodOrders: new Set<string>(), couponSignalOrders: new Set<string>(), productNameOrders:new Set<string>() };
  for (const row of api) {
    const other = csv.get(key(row));
    if (!other) throw new Error("ISOLATED_CSV_API_IDENTITY_MISMATCH");
    if (row.totalOrderKrw === null ? other.totalOrderKrw !== null : !row.totalOrderKrw.eq(other.totalOrderKrw ?? -1))
      differences.totalOrderOrders.add(row.orderNo);
    if (!row.totalPaidKrw.eq(other.totalPaidKrw)) differences.paidOrders.add(row.orderNo);
    if(row.productName!==other.productName)differences.productNameOrders.add(row.orderNo);
    if (row.paymentMethod !== other.paymentMethod) differences.paymentMethodOrders.add(row.orderNo);
    if (row.providerCouponSignal !== hasCafe24CouponPaymentToken(other.paymentMethod))
      differences.couponSignalOrders.add(row.orderNo);
  }
  return Object.fromEntries(Object.entries(differences).map(([field,values]) => [field,values.size])) as {
    totalOrderOrders: number; paidOrders: number; paymentMethodOrders: number; couponSignalOrders: number; productNameOrders:number
  };
}

async function main() {
  assertLiveCanonicalEnvironment(process.env);
  const input = await readInput();
  const prisma = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL,
    log: [] });
  try {
    childStage="CHILD_DATABASE";
    const connection = await assertDatabase(prisma,input.mode);
    const users = await prisma.appUser.findMany();
    let actor = users.find((user) => user.name === actorName);
    if (users.some((user) => user.name !== actorName)) throw new Error("ISOLATED_ACTOR_INVENTORY_MISMATCH");
    if (!actor && input.mode === "seed") actor = await prisma.appUser.create({ data: {
      name: actorName, role: "ADMIN", isActive: true
    } });
    if (!actor) throw new Error("ISOLATED_SEED_REQUIRED");
    const client = prisma as unknown as PrismaService;
    const policies = new SourceConnectionsService(client);
    const gate = { tryAcquire: () => ({ release: () => undefined }) };
    const foundation = new SyncFoundationService(client, gate as never);
    const vault = new CredentialVault(client);
    const oauth = new Cafe24OauthService(client, vault);
    const writer = new Cafe24CanonicalWriterService(client, foundation);
    let runStatus: string | null = null;
    let failurePreserved: boolean | null = null;
    let configurationEvidence: Awaited<ReturnType<typeof seedConfiguration>> | null = null;
    let configurationRepairEvidence:Awaited<ReturnType<typeof repairConfigurationDates>>|null=null;
    let authenticationEvidence: Record<string,unknown> | null=null;
    if (input.mode === "seed") {
      const buffer = safeCsv(input.csvRows);
      try {
      childStage="CHILD_SEED_CONFIGURATION";
      configurationEvidence = await seedConfiguration(prisma, input.configuration);
      childStage="CHILD_SEED_POLICY";
      const before = await prisma.sourcePolicy.count({ where: { connectionId: connection.id } });
      if (!before) await policies.setPolicy(connection.id, { dataKind: SourceDataKind.CAFE24_ORDER,
        primarySource: SourceKind.CSV, fromDate: day, expectedVersion: 0,
        reason: "ISOLATED_06_CSV_PRIMARY" }, actor.id);
        const importer = new Cafe24UploadsService(client,
          { ensureUsdKrwRatesForDates: async () => undefined } as never);
        childStage="CHILD_SEED_CSV";
        await importer.importCafe24Csv({ originalname: "phase06-allowlisted.csv", buffer } as Express.Multer.File,
          ConflictPolicy.SKIP, actor.id, connection.id);
      } finally { buffer.fill(0); }
    } else if(input.mode==="repair-configuration-dates") {
      childStage="CHILD_SEED_CONFIGURATION";
      configurationRepairEvidence=await repairConfigurationDates(prisma,input.configuration,{
        acknowledgement:String(input.acknowledgement??""),expectedDigest:String(input.expectedConfigurationDigest??""),
        connectionId:connection.id,actorUserId:actor.id});
    } else if (input.mode === "publish" || input.mode === "failure") {
      childStage="CHILD_PUBLISH";
      const before = await snapshotState(prisma, connection.id);
      if (input.mode === "failure" && !before.coverage?.lastSuccessRunId)
        throw new Error("ISOLATED_SUCCESS_REQUIRED");
      const orders = input.mode === "failure" ? new PartiallyFailingOrdersClient(client, oauth)
        : new Cafe24OrdersClient(client, oauth);
      const runner = new Cafe24SyncRunnerService(client, foundation, orders, writer);
      const run = await foundation.queueRun({ connectionId: connection.id, fromDate: day, toDate: day,
        trigger: SyncTrigger.MANUAL, actorUserId: actor.id, requestKey: `live06-${randomUUID()}`,
        reason: input.mode === "failure" ? "ISOLATED_06_PARTIAL_READ_INJECTION" : "ISOLATED_06_MANUAL_DAY" });
      const result = await runner.execute(run.id);
      runStatus = result.status;
      if (input.mode === "failure") {
        const after = await snapshotState(prisma, connection.id);
        failurePreserved = after.privateDigest === before.privateDigest &&
          after.coverage?.lastSuccessRunId === before.coverage?.lastSuccessRunId &&
          after.coverage?.lastSuccessAt?.getTime() === before.coverage?.lastSuccessAt?.getTime() &&
          after.coverage?.lastAttemptRunId === run.id && result.status !== "SUCCEEDED";
        if (!failurePreserved) throw new Error("ISOLATED_SUCCESS_NOT_PRESERVED");
      }
    } else if (input.mode === "activate") {
      childStage="CHILD_ACTIVATE";
      if (input.acknowledgement !== "CHOOSE_RECORDED_API_INPUTS_FOR_REVIEWED_06_DAY" ||
          input.couponInputSource !== "API_ACTUAL_PRODUCT_PLUS_SHIPPING")
        throw new Error("ISOLATED_ACTIVATION_INPUT_CHOICE_REQUIRED");
      const before = await snapshotState(prisma, connection.id);
      if (before.policies.length !== 1 || !before.coverage?.lastSuccessRunId)
        throw new Error("ISOLATED_SHADOW_REQUIRED");
      const expected=input.expectedInputDifferences;
      if (!expected || typeof expected !== "object" || Array.isArray(expected) ||
          Object.keys(expected).sort().join(",") !== "couponSignalOrders,paidOrders,paymentMethodOrders,productNameOrders,totalOrderOrders" ||
          typeof input.expectedSnapshotDigest !== "string" || !/^[a-f0-9]{64}$/.test(input.expectedSnapshotDigest))
        throw new Error("ISOLATED_REVIEWED_INPUT_EVIDENCE_REQUIRED");
      const observed=await inputDifferences(prisma,connection.id);
      reviewCafe24LiveInputCounts(observed,expected);
      await policies.activateCafe24Day(connection.id, { day,
        expectedPolicyVersion: before.policies[0].version,
        expectedSuccessRunId: before.coverage.lastSuccessRunId,
        reason: "ISOLATED_06_REVIEWED_DAY_ACTIVATION", mode: "CSV_REVIEWED",
        couponInputSource: input.couponInputSource,
        // Only privacy-suppressed small coupon/name counts are resolved internally;
        // every visible count and the protected exact snapshot were supplied
        // by the reviewer. The service rechecks the digest under its DB lock.
        expectedInputDifferences: observed, expectedSnapshotDigest:input.expectedSnapshotDigest }, actor.id);
    } else if (input.mode === "rotate") {
      childStage="CHILD_AUTH";
      authenticationEvidence=await rotateCafe24LiveCredential({ prisma,connectionId:connection.id,oauth },
        String(input.acknowledgement ?? ""));
    } else if (input.mode === "revoke") {
      childStage="CHILD_AUTH";
      const before=await snapshotState(prisma,connection.id);
      if (!before.coverage?.lastSuccessRunId) throw new Error("ISOLATED_SUCCESS_REQUIRED");
      const run=await foundation.queueRun({ connectionId:connection.id,fromDate:day,toDate:day,
        trigger:SyncTrigger.MANUAL,actorUserId:actor.id,requestKey:`live06-auth-${randomUUID()}`,
        reason:"ISOLATED_06_ACTUAL_REVOKED_AUTH" });
      const runner=new Cafe24SyncRunnerService(client,foundation,new Cafe24OrdersClient(client,oauth),writer);
      const evidence=await revokeCafe24LiveCredential({ prisma,connectionId:connection.id,oauth },
        String(input.acknowledgement ?? ""),() => runner.execute(run.id));
      const after=await snapshotState(prisma,connection.id);
      const disconnected=await prisma.sourceConnection.findUniqueOrThrow({ where:{id:connection.id},
        select:{enabled:true,accessState:true} });
      failurePreserved=after.privateDigest===before.privateDigest &&
        after.coverage?.lastSuccessRunId===before.coverage?.lastSuccessRunId &&
        after.coverage?.lastSuccessAt?.getTime()===before.coverage?.lastSuccessAt?.getTime();
      if (evidence.result.safeErrorCode !== "PROVIDER_AUTH_REQUIRED" ||
          disconnected.accessState !== "REAUTH_REQUIRED" || disconnected.enabled || !failurePreserved)
        throw new Error("ISOLATED_REVOKED_AUTH_FAILURE_NOT_CONFIRMED");
      runStatus=evidence.result.status;
      authenticationEvidence={ providerRevocationSucceeded:true,realReadAuthenticationFailure:true,
        reauthRequired:true,lastSuccessAndCurrentPreserved:true,oldPairRestored:false,tokenCopied:false };
    }
    childStage="CHILD_RESULT_READ";
    const state = await snapshotState(prisma, connection.id);
    const visibleCandidates = await prisma.cafe24OrderLine.findMany({ where: {
      connectionId: connection.id, orderDate: dayDate, isCurrent: true
    } });
    const visible = await selectCurrentSourceRows(client, SourceDataKind.CAFE24_ORDER,
      visibleCandidates, (row) => row.orderDate);
    const differences = state.currentLines ? await inputDifferences(prisma,connection.id) : null;
    const activationSnapshotDigest=state.currentLines ? await computeCafe24ActivationEvidence(prisma,connection.id,day,
      {mode:"CSV_REVIEWED",couponInputSource:"API_ACTUAL_PRODUCT_PLUS_SHIPPING"}) : null;
    const csvCalculationScope=await prisma.cafe24OrderLine.findMany({where:{connectionId:connection.id,
      source:SourceKind.CSV,isCurrent:true,OR:[{orderDate:dayDate},{orderDate:null}]},include:{batch:true}});
    const datedCsv=csvCalculationScope.filter((row)=>row.orderDate!==null);
    const batchIds=new Set(csvCalculationScope.map((row)=>row.uploadBatchId));
    const batch=csvCalculationScope[0]?.batch;
    const completeCsv=batchIds.size===1 && batchIds.has(batch?.id ?? "") &&
      csvCalculationScope.length===477 && new Set(csvCalculationScope.map((row)=>row.orderNo)).size===422 &&
      new Set(datedCsv.map((row)=>row.orderNo)).size===419 && csvCalculationScope.every((row)=>
        row.batch && ["IMPORTED","PARTIAL"].includes(row.batch.status) &&
        row.batch.rowCount===477 && isCompleteCafe24UploadBatch({rowCount:row.batch.rowCount,storedRowCount:csvCalculationScope.length}));
    const lastSuccess=state.coverage?.lastSuccessRunId ? await prisma.syncRun.findUnique({
      where:{id:state.coverage.lastSuccessRunId},select:{status:true}}) : null;
    const completeApi=state.currentLines===477 && state.currentOrderCount===422 && state.currentVersions===477 &&
      state.currentLinks===477 && state.coverage?.rowCount===477 && lastSuccess?.status==="SUCCEEDED";
    const selectedComplete=state.policies[0]?.primarySource===SourceKind.API ? completeApi : completeCsv;
    childStage="CHILD_RESULT_CALCULATION";
    const calculationEvidence=selectedComplete && new Set(visible.map((row)=>row.orderNo)).size>=10
      ? await new SalesMetricsService(client).diagnoseCafe24OnlyDay(day,{
        expectedSelectedLineCount:visible.length,projectionScope:state.policies[0]?.primarySource===SourceKind.API
          ? "COMPLETE_API_DAY" : "DATED_CSV_ROWS"}) : null;
    const dayRunWhere={connectionId:connection.id,fromDate:dayDate,toDate:dayDate};
    const [runCount,runStatusGroups,dayRuns]=await Promise.all([
      prisma.syncRun.count({where:dayRunWhere}),
      prisma.syncRun.groupBy({by:["status"],where:dayRunWhere}),
      prisma.syncRun.findMany({where:dayRunWhere,take:2,orderBy:{startedAt:{sort:"desc",nulls:"last"}},
        select:{id:true,status:true,safeErrorCode:true,startedAt:true}})]);
    const started=dayRuns.filter(run=>run.startedAt).sort((a,b)=>b.startedAt!.getTime()-a.startedAt!.getTime());
    const latestRun=runCount===1?dayRuns[0]:started.length &&
      (started.length===1 || started[0].startedAt!.getTime()!==started[1].startedAt!.getTime())?started[0]:null;
    const selection=runCount===0?"NONE":runCount===1?"ONLY_DAY_RUN":latestRun?"LATEST_STARTED_RUN":"AMBIGUOUS_RUN_ORDER";
    const units=latestRun?await prisma.runUnit.findMany({where:{runId:latestRun.id},take:33,select:{status:true}}):[];
    const lease=await prisma.syncLease.findUnique({where:{connectionId:connection.id},select:{expiresAt:true}});
    const syncExecutionEvidence={runPresent:runCount>0,runCount,runStatuses:runStatusGroups.map(group=>group.status).sort(),selection,
      lastRunStatus:latestRun?.status??null,
      lastSafeCode:latestRun?.safeErrorCode?safeSyncCode(latestRun.safeErrorCode):null,
      unitStatuses:[...new Set(units.map(unit=>unit.status))].sort(),unitCount:units.length,
      leasePresent:lease!==null,leaseActive:!!lease&&lease.expiresAt.getTime()>Date.now()};
    const diagnosticCodes=Array.isArray(state.coverage?.warningCodes) ? [...new Set(state.coverage.warningCodes.filter(isCafe24FailureDiagnosticCode))] : [];
    const providerFailureDiagnosticCode=diagnosticCodes.length===1 ? diagnosticCodes[0] : null;
    let inspectAuthenticationEvidence:Record<string,unknown>={};
    if(input.mode==="inspect") {
      const currentConnection=await prisma.sourceConnection.findUniqueOrThrow({where:{id:connection.id},select:{accessState:true,enabled:true}});
      const pair=await prisma.sourceCredential.findMany({where:{connectionId:connection.id},orderBy:{kind:"asc"},select:{kind:true,revision:true}});
      if(pair.length!==2 || pair[0].kind!=="CAFE24_ACCESS" || pair[1].kind!=="CAFE24_REFRESH")throw new Error("ISOLATED_CREDENTIAL_OWNER_MISMATCH");
      inspectAuthenticationEvidence={connectionAccessState:currentConnection.accessState,connectionEnabled:currentConnection.enabled,
        credentialRevisions:pair.map(credential=>credential.revision)};
    }
    process.stdout.write(JSON.stringify({ mode: input.mode, day, runStatus, failurePreserved,
      calculationEvidence,
      syncExecutionEvidence,
      providerFailureDiagnosticCode,
      ...inspectAuthenticationEvidence,
      ...configurationEvidence,
      ...configurationRepairEvidence,
      configurationStateDigest:await configurationStateDigest(prisma),
      authenticationEvidence,
      currentApiLines: state.currentLines, apiVersionRows: state.versionRows,
      currentApiVersions: state.currentVersions, currentApiLinks: state.currentLinks,
      allProviderOrderStatusesAbsent:state.allProviderOrderStatusesAbsent,
      nullProviderUpdatedLines: state.nullProviderUpdatedLines, csvUndatedLines: state.csvUndated,
      visibleCsvLines: visible.filter((row) => row.source === SourceKind.CSV).length,
      visibleApiLines: visible.filter((row) => row.source === SourceKind.API).length,
      coverageState: state.coverage?.state ?? null,
      inputDifferences:differences?suppressCafe24LiveInputCounts(differences):null,
      activationSnapshotDigest,
      lastSuccessPreserved: Boolean(state.coverage?.lastSuccessRunId),
      primarySource: state.policies[0]?.primarySource ?? null,
      providerCacheFreshnessVerified: false, providerModificationTimeInvented: false }) + "\n");
  } finally { await prisma.$disconnect(); }
}

if (require.main === module) void main().catch((error: unknown) => {
  process.stdout.write(JSON.stringify(liveChildFailure(error,childStage))+"\n");
  process.exitCode = 1;
});
