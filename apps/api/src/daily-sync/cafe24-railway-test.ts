import {precheckCafe24OptionCapacity,expandCafe24OptionCapacity} from "./cafe24-live-option-capacity";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { HttpException } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { Cafe24OauthService } from "./cafe24-oauth.service";
import { Cafe24OrderPreflightClient } from "./cafe24-order-preflight.client";
import { Cafe24ObservationService } from "./cafe24-observation.service";
import { CredentialVault } from "./credential-vault";
import { Cafe24TestConnectionService } from "./cafe24-test-connection.service";
import { ProviderFailure } from "./bounded-request";
import { safeSyncCode } from "./sync-contract";
import { Cafe24LiveSetupDiagnostic,precheckCafe24LiveSchema,safeCafe24LiveSetupDiagnostic,setupCafe24LiveSchema } from "./cafe24-live-setup";
import { Cafe24LiveChildFailure,type Cafe24LiveChildDiagnostic } from "./cafe24-live-failure";
import {type Cafe24MappingReviewEvidence} from "./cafe24-live-mapping-review-error";
import { recoverCafe24LiveEnable, runCafe24LiveChild, stopCafe24LiveChildren } from "./cafe24-live-child";

const basePath = "/backend-api/integrations/cafe24/oauth";
const callbackPath = `${basePath}/callback`;
// URL-encoded safe CSV/config JSON can use three wire bytes per source byte.
// The canonical child separately enforces 512 KiB of decoded input.
const maxBodyBytes = 2 * 1024 * 1024;
const maxAsyncResponseBytes = 192 * 1024;
const asyncJobTtlMs = 12 * 60_000;
const optionDiagnosticCategories = new Set(["ITEM_SHAPE", "ITEM_CODE", "PRODUCT_NO",
  "PRODUCT_NAME", "OPTION_VALUE", "QUANTITY", "PRODUCT_PRICE",
  "OPTION_PRICE_EMPTY", "OPTION_PRICE_FORMAT", "OPTION_PRICE_TYPE",
  "OPTION_PRICE_UNSAFE_NUMBER",
  "ITEM_REQUEST_OR_JSON", "ORDER_OR_SHARED_SHAPE"]);
const isolatedRailway = {
  project: "d72f4256-8632-437a-9dae-9b5d96736fc7",
  environment: "d261a432-a6a4-4031-b8ea-c619ac263cc3",
  callbackService: "deaaeaf9-ee5c-42fa-b32f-600c7a90befc",
  databaseService: "ef46528f-4b59-4ee6-9d9c-b0852b5a9274"
} as const;
const page = `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="robots" content="noindex">
<title>Cafe24 06 테스트</title><h1>Cafe24 06 테스트</h1>
<form method="post" action="/action"><label>운영자 확인값 <input type="password" name="operator" required></label>
<label>작업 <select name="mode"><option value="authorize">앱 연결</option><option value="summary">일별 합계</option>
<option value="probe">필드 형태</option><option value="diagnose">조회 진단</option><option value="statuses">상태 코드 건수</option></select></label>
<label>조회일 <input type="date" name="day"></label><button type="submit">실행</button></form></html>`;

export function railwayPrivateDatabaseUrl(value: string | undefined, expectedHost: string | undefined,
  expectedName: string | undefined) {
  let url: URL;
  try { url = new URL(value ?? ""); } catch { throw new Error("ISOLATED_DATABASE_REQUIRED"); }
  if (!expectedHost || !expectedName || !expectedHost.endsWith(".railway.internal") ||
      url.protocol !== "postgresql:" && url.protocol !== "postgres:" ||
      url.hostname !== expectedHost || url.port !== "5432" ||
      url.pathname !== `/${expectedName}` || !url.username || !url.password ||
      [...url.searchParams.keys()].some((key) => key !== "schema") ||
      (url.searchParams.has("schema") && url.searchParams.get("schema") !== "public"))
    throw new Error("ISOLATED_DATABASE_REQUIRED");
  return value!;
}

export function cafe24TestEnvironment(env: NodeJS.ProcessEnv) {
  if (env.DAILY_SYNC_FEATURE_ENABLED === "true" || env.DAILY_SYNC_CAFE24_TEST_ENABLED !== "true")
    throw new Error("FEATURE_OFF");
  if (env.RAILWAY_PROJECT_ID !== isolatedRailway.project ||
      env.RAILWAY_ENVIRONMENT_ID !== isolatedRailway.environment ||
      env.RAILWAY_SERVICE_ID !== isolatedRailway.callbackService ||
      env.DAILY_SYNC_CAFE24_DB_SERVICE_ID !== isolatedRailway.databaseService)
    throw new Error("ISOLATED_RAILWAY_REQUIRED");
  const databaseUrl = railwayPrivateDatabaseUrl(env.DATABASE_URL,
    env.DAILY_SYNC_CAFE24_DB_HOST, env.DAILY_SYNC_CAFE24_DB_NAME);
  const redirect = new URL(env.DAILY_SYNC_CAFE24_REDIRECT_URI ?? "");
  if (redirect.protocol !== "https:" ||
      redirect.href !== `${redirect.origin}${callbackPath}` ||
      redirect.origin !== env.DAILY_SYNC_CAFE24_ISOLATED_ORIGIN)
    throw new Error("REDIRECT_INVALID");
  const operator = env.DAILY_SYNC_CAFE24_TEST_OPERATOR_SECRET ?? "";
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(operator)) throw new Error("OPERATOR_SECRET_REQUIRED");
  const port = Number(env.PORT);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("PORT_INVALID");
  return { databaseUrl, origin: redirect.origin, host: redirect.host,
    operator: Buffer.from(operator), port };
}

function fixedHeaders(response: ServerResponse) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Content-Security-Policy", "default-src 'none'; form-action 'self'");
}

function fixed(response: ServerResponse, status: number, body: string) {
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" }).end(body);
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" })
    .end(JSON.stringify(body));
}

export function callbackFailureCategory(error: unknown) {
  if (error instanceof HttpException) {
    const response = error.getResponse();
    if (response && typeof response === "object" && "code" in response)
      return safeSyncCode(response.code);
  }
  if (error && typeof error === "object" && "safeCode" in error)
    return safeSyncCode(error.safeCode);
  return "PROVIDER_UNAVAILABLE";
}

async function formBody(request: IncomingMessage) {
  if (!/^application\/x-www-form-urlencoded(?:;|$)/i.test(String(request.headers["content-type"] ?? "")))
    throw new Error("BAD_FORM");
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBodyBytes) throw new Error("BAD_FORM");
    chunks.push(bytes);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

export function createCafe24RailwayTestServer(input: {
  origin: string; host: string; operator: Buffer;
  sources: Pick<Cafe24TestConnectionService, "createCafe24Test">;
  oauth: Pick<Cafe24OauthService, "begin" | "callback">;
  orders: Pick<Cafe24OrderPreflightClient, "readDaySummary" | "probeDayShape" |
    "probeDayStatuses" | "diagnoseDayContract" | "diagnoseDetailFields" |
    "readDayHmac" | "readDayDateHmac" |
    "diagnosePaidDifferences" | "compareDayOptionKeys" | "compareDayOrderAmounts"> &
    Partial<Pick<Cafe24OrderPreflightClient, "readDayBusinessAggregate">>;
  observation?: Pick<Cafe24ObservationService, "observeDay">;
  live?: { precheck: () => Promise<unknown>; setup: (acknowledgement: string,expectedSchemaDigest:string) => Promise<unknown>;
    optionCapacityPrecheck?:()=>Promise<unknown>;
    optionCapacityExpand?:(acknowledgement:string,digest:string,verifiedAt:string)=>Promise<unknown>;
    recover?: (acknowledgement:string,verifiedAt:string)=>Promise<unknown>;
    execute: (payload: Record<string, unknown>) => Promise<unknown> };
}) {
  let minute = Date.now();
  let actionCount = 0;
  let callbackCount = 0;
  let pollCount = 0;
  let activeAction = false;
  type AsyncJob = { id: string; running: boolean; body: string | null;
    errorCode: string | null; diagnosticCategory: string | null;
    setupDiagnostic?:Cafe24LiveSetupDiagnostic|Cafe24LiveChildDiagnostic;
    mappingReviewEvidence?:Cafe24MappingReviewEvidence;
    processEvidence?:{exitCode:number|null;signal:string|null};
    key: Buffer | null; expired: boolean };
  let activeJob: AsyncJob | null = null;
  const withinLimit = (kind: "action" | "callback" | "poll") => {
    if (Date.now() - minute >= 60_000) {
      minute = Date.now(); actionCount = 0; callbackCount = 0; pollCount = 0;
    }
    return kind === "action" ? ++actionCount <= 5
      : kind === "callback" ? ++callbackCount <= 30 : ++pollCount <= 12;
  };
  const server = createServer(async (request, response) => {
    fixedHeaders(response);
    if ((request.url?.length ?? 0) > 2048) { fixed(response, 414, "Request too long."); return; }
    let url: URL;
    try {
      const target = request.url ?? "";
      if (!target.startsWith("/") || target.startsWith("//")) throw new Error("BAD_TARGET");
      url = new URL(target, input.origin);
      if (url.origin !== input.origin) throw new Error("BAD_TARGET");
    } catch { fixed(response, 400, "Invalid request."); return; }
    if (request.method === "GET" && url.pathname === "/health") {
      fixed(response, 200, "ready"); return;
    }
    if (request.headers.host !== input.host) { fixed(response, 421, "Invalid host."); return; }
    if (request.method === "GET" && url.pathname === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(page);
      return;
    }
    if (request.method === "GET" && url.pathname === `${basePath}/complete`) {
      fixed(response, 200, "Cafe24 connection completed. Return to the application."); return;
    }
    if (request.method === "GET" && url.pathname === `${basePath}/failed`) {
      fixed(response, 400, "Cafe24 connection failed. Start a new authorization attempt."); return;
    }
    if (request.method === "GET" && url.pathname === callbackPath) {
      if (activeAction || activeJob?.running) { fixed(response,409,"A test action is running. Start a new authorization afterwards."); return; }
      if (!withinLimit("callback")) { fixed(response, 429, "Try again later."); return; }
      let result = "failed";
      try {
        await input.oauth.callback({ state: url.searchParams.get("state") ?? undefined,
          code: url.searchParams.get("code") ?? undefined,
          error: url.searchParams.get("error") ?? undefined });
        result = "complete";
      } catch (error) {
        // Fixed categories only: never log code, state, URL, token, or provider payload.
        process.stdout.write(`${JSON.stringify({ event: "cafe24.callback.failed",
          category: callbackFailureCategory(error) })}\n`);
      }
      response.writeHead(303, { Location: `${basePath}/${result}` }).end();
      return;
    }
    if (request.method !== "POST" ||
        url.pathname !== "/action" && url.pathname !== "/action-status") {
      fixed(response, 404, "Not found."); return;
    }
    if (url.search || request.headers.origin !== input.origin) {
      fixed(response, 403, "Action unavailable."); return;
    }
    let operatorVerified = false;
    try {
      const form = await formBody(request);
      const supplied = Buffer.from(form.get("operator") ?? "");
      const validOperator = supplied.length === input.operator.length &&
        timingSafeEqual(supplied, input.operator);
      supplied.fill(0);
      if (!validOperator) {
        fixed(response, 403, "Action unavailable."); return;
      }
      operatorVerified = true;
      if (url.pathname === "/action-status") {
        if (!withinLimit("poll")) { fixed(response, 429, "Try again later."); return; }
        const ids = form.getAll("jobId");
        if (ids.length !== 1 || !/^[a-f0-9-]{36}$/.test(ids[0]) ||
            !activeJob || activeJob.id !== ids[0] || activeJob.expired) {
          fixed(response, 404, "Not found."); return;
        }
        if (activeJob.running) { json(response, 202, { status: "RUNNING" }); return; }
        const completed = activeJob;
        activeJob = null; // A result can be retrieved once only.
        if (completed.errorCode) {
          json(response, 409, completed.setupDiagnostic ? {code:completed.errorCode,diagnostic:completed.setupDiagnostic,
            ...(completed.mappingReviewEvidence?{mappingReviewEvidence:completed.mappingReviewEvidence}:{}),
            ...(completed.processEvidence?{processEvidence:completed.processEvidence}:{})} : completed.diagnosticCategory
            ? { code: completed.errorCode, category: completed.diagnosticCategory }
            : { code: completed.errorCode }); return;
        }
        if (!completed.body) { fixed(response, 503, "Action unavailable."); return; }
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" })
          .end(completed.body);
        completed.body = null;
        return;
      }
      if (!withinLimit("action")) { fixed(response, 429, "Try again later."); return; }
      const mode = form.get("mode");
      if (!mode || !["authorize", "summary", "probe", "diagnose", "statuses",
          "detail-fields", "hmac", "date-hmac", "option-compare", "paid-diagnose",
          "observe", "business-aggregate", "amount-compare", "live-precheck", "live-setup", "live-canonical", "live-recover","live-option-precheck","live-option-expand"].includes(mode)) {
        fixed(response, 400, "Invalid action."); return;
      }
      if (activeJob || activeAction) {
        json(response, 429, { code: "RUN_LIMIT_EXCEEDED" }); return;
      }
      activeAction = true;
      try {
      if (mode === "live-precheck" || mode === "live-setup" || mode === "live-canonical" || mode === "live-recover" || mode === "live-option-precheck" || mode === "live-option-expand") {
        if (!input.live) { fixed(response,503,"Action unavailable."); return; }
        if ([...form.keys()].some((field) => !["operator","mode","acknowledgement","payload","singleInstanceVerifiedAt","expectedSchemaDigest"].includes(field)) ||
            form.getAll("mode").length !== 1) { fixed(response,400,"Invalid action."); return; }
        if (mode === "live-precheck") {
          if ([...form.keys()].some((field)=>!["operator","mode"].includes(field))) {fixed(response,400,"Invalid action.");return;}
          json(response,200,await input.live.precheck()); return;
        }
        if(mode === "live-option-precheck") {
          if(!input.live.optionCapacityPrecheck || [...form.keys()].some(field=>!["operator","mode"].includes(field))){fixed(response,400,"Invalid action.");return;}
          json(response,200,await input.live.optionCapacityPrecheck());return;
        }
        if(mode === "live-option-expand" && (!input.live.optionCapacityExpand || form.getAll("acknowledgement").length!==1 || form.get("acknowledgement")!=="EXPAND_ISOLATED_06_DERIVED_OPTION_NAME_256_TO_514_ONLY" || form.getAll("expectedSchemaDigest").length!==1 || !/^[a-f0-9]{64}$/.test(form.get("expectedSchemaDigest")!) || form.getAll("singleInstanceVerifiedAt").length!==1 || form.has("payload"))){fixed(response,400,"Invalid action.");return;}
        if (mode === "live-recover") {
          if (!input.live.recover || form.getAll("acknowledgement").length!==1 ||
              form.getAll("singleInstanceVerifiedAt").length!==1 || form.has("payload") || form.has("expectedSchemaDigest")) {
            fixed(response,400,"Invalid action."); return;
          }
          json(response,200,await input.live.recover(form.get("acknowledgement")!,form.get("singleInstanceVerifiedAt")!)); return;
        }
        const acknowledgements=form.getAll("acknowledgement");
        const payloads=form.getAll("payload");
        let payload: Record<string,unknown> | null=null;
        if (mode === "live-setup" && (acknowledgements.length !== 1 ||
            acknowledgements[0] !== "ADD_06_TABLES_AND_EXTEND_AUDIT_ACTOR_CHECK" || payloads.length !== 0 ||
            form.has("singleInstanceVerifiedAt") || form.getAll("expectedSchemaDigest").length!==1 ||
            !/^[a-f0-9]{64}$/.test(form.get("expectedSchemaDigest")!))) {
          fixed(response,400,"Invalid action."); return;
        }
        if (mode === "live-canonical") {
          if (payloads.length !== 1 || Buffer.byteLength(payloads[0],"utf8")>512*1024 || acknowledgements.length !== 0 ||
              form.has("singleInstanceVerifiedAt") || form.has("expectedSchemaDigest")) {
            fixed(response,400,"Invalid action."); return;
          }
          try {
            const parsed: unknown=JSON.parse(payloads[0]);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("BAD_PAYLOAD");
            payload=parsed as Record<string,unknown>;
          } catch { fixed(response,400,"Invalid action."); return; }
        }
        form.delete("payload"); payloads.fill("");
        const job: AsyncJob={ id: randomUUID(),running:true,body:null,errorCode:null,diagnosticCategory:null,key:null,expired:false };
        activeJob=job;
        const expiry=setTimeout(() => { if (activeJob===job) { job.expired=true; job.body=null;
          if (!job.running) activeJob=null; } },asyncJobTtlMs);
        expiry.unref();
        void(async () => {
          try {
            const result=mode === "live-setup" ? await input.live!.setup(acknowledgements[0],form.get("expectedSchemaDigest")!)
              : mode === "live-option-expand" ? await input.live!.optionCapacityExpand!(acknowledgements[0],form.get("expectedSchemaDigest")!,form.get("singleInstanceVerifiedAt")!) : await input.live!.execute(payload!);
            const body=JSON.stringify(result);
            if (Buffer.byteLength(body,"utf8")>32*1024) throw new Error("LIVE_RESPONSE_LIMIT");
            if (activeJob===job) job.body=body;
          } catch (error) {
            if (activeJob===job) {
              job.errorCode=callbackFailureCategory(error);
              const diagnostic=safeCafe24LiveSetupDiagnostic(error);
              if (diagnostic) job.setupDiagnostic=diagnostic;
              else if (error instanceof Cafe24LiveChildFailure) {job.setupDiagnostic=error.diagnostic;job.mappingReviewEvidence=error.mappingReviewEvidence;job.processEvidence=error.processEvidence;}
            }
          } finally { payload=null; acknowledgements.fill(""); job.running=false;
            if (job.expired && activeJob===job) activeJob=null; }
        })();
        json(response,202,{ jobId:job.id,status:"RUNNING" }); return;
      }
      if (mode === "authorize") {
        const connection = await input.sources.createCafe24Test();
        const { authorizeUrl } = await input.oauth.begin(connection.id, null);
        response.writeHead(303, { Location: authorizeUrl }).end();
        return;
      }
      const day = form.get("day") ?? "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) { fixed(response, 400, "Invalid day."); return; }
      if (mode === "observe" || mode === "business-aggregate") {
        if (mode === "observe" && !input.observation ||
            mode === "business-aggregate" && !input.orders.readDayBusinessAggregate) {
          fixed(response, 503, "Action unavailable."); return;
        }
        const job: AsyncJob = { id: randomUUID(), running: true, body: null,
          errorCode: null, diagnosticCategory: null, key: null, expired: false };
        activeJob = job;
        const expiry = setTimeout(() => {
          if (activeJob === job) {
            job.expired = true;
            job.body = null;
            if (!job.running) activeJob = null;
          }
        }, asyncJobTtlMs);
        expiry.unref();
        void (async () => {
          try {
            const connection = await input.sources.createCafe24Test();
            const result = mode === "observe"
              ? await input.observation!.observeDay(connection.id, day)
              : await input.orders.readDayBusinessAggregate!(connection.id, day);
            const body = JSON.stringify(result);
            if (Buffer.byteLength(body, "utf8") > maxAsyncResponseBytes)
              throw new Error("OBSERVATION_RESPONSE_LIMIT");
            if (activeJob === job) job.body = body;
          } catch (error) {
            if (activeJob === job) job.errorCode = callbackFailureCategory(error);
          } finally {
            job.running = false;
            if (job.expired && activeJob === job) activeJob = null;
          }
        })();
        json(response, 202, { jobId: job.id, status: "RUNNING" });
        return;
      }
      if (mode === "hmac" || mode === "date-hmac" || mode === "option-compare" ||
          mode === "amount-compare" ||
          mode === "paid-diagnose") {
        const values = form.getAll("hmacKey");
        if (values.length !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(values[0])) {
          fixed(response, 400, "Invalid comparison key."); return;
        }
        const key = Buffer.from(values[0], "base64url");
        form.delete("hmacKey");
        if (key.length !== 32 || key.toString("base64url") !== values[0]) {
          key.fill(0); fixed(response, 400, "Invalid comparison key."); return;
        }
        values[0] = "";
        let targets: string[] = [];
        let optionRows: string[] = [];
        let amountRows: string[] = [];
        if (mode === "paid-diagnose") {
          const encoded = form.getAll("orderHmacs");
          if (encoded.length !== 1 ||
              !/^[a-f0-9]{64}(?:,[a-f0-9]{64}){5}$/.test(encoded[0])) {
            key.fill(0); fixed(response, 400, "Invalid comparison selection."); return;
          }
          targets = encoded[0].split(",");
          form.delete("orderHmacs");
          encoded[0] = "";
        }
        if (mode === "option-compare") {
          const encoded = form.getAll("optionRows");
          if (encoded.length !== 1 || encoded[0].length > 220_000) {
            key.fill(0); fixed(response, 400, "Invalid comparison selection."); return;
          }
          optionRows = encoded[0].split(";");
          form.delete("optionRows");
          encoded[0] = "";
          if (optionRows.length < 1 || optionRows.length > 600 ||
              optionRows.some((row) => !/^[a-f0-9]{64}(?:\.[a-f0-9]{64}){4}$/.test(row))) {
            key.fill(0); optionRows.fill("");
            fixed(response, 400, "Invalid comparison selection."); return;
          }
        }
        if (mode === "amount-compare") {
          const encoded = form.getAll("amountRows");
          if (encoded.length !== 1 || encoded[0].length > 170_000) {
            key.fill(0); fixed(response, 400, "Invalid comparison selection."); return;
          }
          amountRows = encoded[0].split(";");
          form.delete("amountRows");
          encoded[0] = "";
          if (amountRows.length < 10 || amountRows.length > 500 ||
              amountRows.some((row) => !/^[a-f0-9]{64}(?:\.[a-f0-9]{64}){4}$/.test(row))) {
            key.fill(0); amountRows.fill("");
            fixed(response, 400, "Invalid comparison selection."); return;
          }
        }
        if (mode === "hmac" || mode === "date-hmac" || mode === "option-compare" ||
            mode === "amount-compare") {
          const job: AsyncJob = { id: randomUUID(), running: true, body: null,
            errorCode: null, diagnosticCategory: null, key, expired: false };
          activeJob = job;
          const expiry = setTimeout(() => {
            if (activeJob === job) {
              job.expired = true;
              job.body = null;
              if (!job.running) activeJob = null;
            }
          }, asyncJobTtlMs);
          expiry.unref();
          void (async () => {
            try {
              const connection = await input.sources.createCafe24Test();
              const result = mode === "hmac"
                ? await input.orders.readDayHmac(connection.id, day, key)
                : mode === "date-hmac"
                  ? await input.orders.readDayDateHmac(connection.id, day, key)
                  : mode === "option-compare"
                    ? await input.orders.compareDayOptionKeys(connection.id, day, key, optionRows)
                    : await input.orders.compareDayOrderAmounts(connection.id, day, key, amountRows);
              const body = JSON.stringify(result);
              if (Buffer.byteLength(body, "utf8") > maxAsyncResponseBytes)
                throw new Error("HMAC_RESPONSE_LIMIT");
              if (activeJob === job) job.body = body;
            } catch (error) {
              if (activeJob === job) {
                job.errorCode = callbackFailureCategory(error);
                if (mode === "option-compare" && error instanceof ProviderFailure &&
                    optionDiagnosticCategories.has(error.diagnosticCode ?? ""))
                  job.diagnosticCategory = error.diagnosticCode;
              }
            } finally {
              key.fill(0); optionRows.fill(""); amountRows.fill(""); job.running = false;
              if (job.expired && activeJob === job) activeJob = null;
            }
          })();
          json(response, 202, { jobId: job.id, status: "RUNNING" });
          return;
        }
        try {
          const connection = await input.sources.createCafe24Test();
          const result = await input.orders.diagnosePaidDifferences(
            connection.id, day, key, targets);
          const body = JSON.stringify(result);
          if (Buffer.byteLength(body, "utf8") > maxAsyncResponseBytes)
            throw new Error("HMAC_RESPONSE_LIMIT");
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }).end(body);
        } finally { key.fill(0); targets.fill(""); }
        return;
      }
      const connection = await input.sources.createCafe24Test();
      const result = mode === "summary" ? await input.orders.readDaySummary(connection.id, day)
        : mode === "probe" ? await input.orders.probeDayShape(connection.id, day)
          : mode === "diagnose" ? await input.orders.diagnoseDayContract(connection.id, day)
            : mode === "detail-fields" ? await input.orders.diagnoseDetailFields(connection.id, day)
            : await input.orders.probeDayStatuses(connection.id, day);
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" })
        .end(JSON.stringify(result));
      } finally { activeAction = false; }
    } catch (error) {
      if (!operatorVerified) { fixed(response, 400, "Invalid action."); return; }
      response.writeHead(409, { "Content-Type": "application/json; charset=utf-8" })
        .end(JSON.stringify({ code: callbackFailureCategory(error) }));
    }
  });
  server.on("close", () => {
    activeJob?.key?.fill(0);
    if (activeJob) activeJob.body = null;
    activeJob = null;
  });
  return server;
}

async function main() {
  const settings = cafe24TestEnvironment(process.env);
  const prisma = new PrismaClient({ datasourceUrl: settings.databaseUrl });
  try {
    await prisma.$connect();
    const vault = new CredentialVault(prisma as never);
    const oauth = new Cafe24OauthService(prisma as never, vault);
    const orders = new Cafe24OrderPreflightClient(prisma as never, oauth);
    const server = createCafe24RailwayTestServer({ origin: settings.origin,
      host: settings.host, operator: settings.operator,
      sources: new Cafe24TestConnectionService(prisma), oauth,
      orders, observation: new Cafe24ObservationService(prisma as never, orders),
      live: { optionCapacityPrecheck:()=>precheckCafe24OptionCapacity(prisma),
        optionCapacityExpand:(ack,digest,verifiedAt)=>expandCafe24OptionCapacity(prisma,ack,digest,verifiedAt),
        precheck: () => precheckCafe24LiveSchema(prisma),
        recover: (acknowledgement,verifiedAt)=>recoverCafe24LiveEnable(prisma,acknowledgement,verifiedAt),
        setup: (acknowledgement,digest) => setupCafe24LiveSchema(prisma,acknowledgement,digest),
        execute: (payload) => runCafe24LiveChild(prisma,payload) } });
    await new Promise<void>((resolve) => server.listen(settings.port, "0.0.0.0", resolve));
    process.stdout.write("Cafe24 test receiver ready.\n");
    await new Promise<void>((resolve) => {
      const stop=() => { const childrenStopped=stopCafe24LiveChildren();
        server.close(() => { void childrenStopped.then(() => resolve()); }); };
      process.once("SIGINT",stop);
      process.once("SIGTERM",stop);
    });
  } finally { settings.operator.fill(0); await prisma.$disconnect(); }
}

if (require.main === module) {
  void main().catch(() => { process.stderr.write("CAFE24_TEST_START_FAILED\n"); process.exitCode = 1; });
}
