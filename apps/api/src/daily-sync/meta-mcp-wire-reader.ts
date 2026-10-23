/** Raw MCP wire contract. This reader has no database, lifecycle or production activation path. */
export type MetaMcpLevel = "ad" | "adset" | "campaign" | "ad_account";
export type MetaMcpEnvelopeReader = (response: Response, maxBytes: number) => Promise<unknown>;
type Json = Record<string, unknown>;
export type MetaMcpMoney = { value: string; unit: string };
export type MetaMcpWireSnapshot = {
  profile?: "PURCHASE_V1";
  version: 1; transport: "META_ADS_MCP"; accountId: string; day: string;
  observedAtUtc: string; clientConversationId: string; pageCount: number; byteCount: number;
  status: "COMPLETE_WIRE_ONLY" | "COMPLETE_WIRE_UNVERIFIED_IDENTITY"; levels: Record<MetaMcpLevel, Json[]>;
  queries: Record<MetaMcpLevel, Json>; moneyUnits: string[];
  paginationComplete: true; datesVerified: true; identityVerified: boolean;
  missingParentIds?: { campaign: string[]; adset: string[] }; identityDiagnostic?: MetaMcpWireDiagnostic;
  currencyVerified: false; attributionVerified: false; metricsNormalized: false; productionReady: false;
};
export const META_MCP_WIRE_CODES = ["INPUT_INVALID", "CATALOG_INVALID", "SCHEMA_INVALID", "HTTP_UNAVAILABLE",
  "ENVELOPE_INVALID", "TOOL_ERROR", "OUTPUT_INVALID", "OUTPUT_MISMATCH", "ROW_INVALID", "DATE_MISMATCH",
  "ACCOUNT_SCOPE_MISMATCH", "IDENTITY_MISMATCH", "DUPLICATE_ID", "CURSOR_INVALID", "MONEY_INVALID",
  "METRIC_INVALID", "SUMMARY_MISMATCH", "RUN_LIMIT_EXCEEDED", "TOKEN_REFLECTION"] as const;
export type MetaMcpWireDiagnostic = { level: MetaMcpLevel; field: "id" | "account_id" | "campaign_id" | "adset_id" | "campaign_name" | "adset_name" | "attribution_spec" | "OTHER";
  rowIndex: number; reasonCategory: "ABSENT" | "NULL" | "NONSTRING" | "INVALID_FORMAT" | "NESTED_ID" | "PARENT_MISSING" | "PARENT_NAME_MISMATCH" };
export class MetaMcpWireFailure extends Error {
  constructor(readonly safeCode: typeof META_MCP_WIRE_CODES[number], readonly requestCount = 0, readonly diagnostic?: MetaMcpWireDiagnostic) { super(safeCode); }
}
const MCP = "https://mcp.facebook.com/ads", PAGE_BYTES = 2 * 1024 * 1024;
const LEVELS: MetaMcpLevel[] = ["ad", "adset", "campaign", "ad_account"];
const CORE = ["amount_spent", "impressions", "link_click", "clicks", "reach", "frequency"];
export const META_MCP_DAY_FIELDS: Readonly<Record<MetaMcpLevel, readonly string[]>> = Object.freeze({
  ad: ["id", "name", "account_id", "campaign_id", "campaign_name", "adset_id", "adset_name", "status", "effective_status", ...CORE],
  adset: ["id", "name", "account_id", "campaign_id", "campaign_name", "status", "effective_status", "attribution_setting", "attribution_spec", "daily_budget", "lifetime_budget", "start_time", "stop_time", "end_time", ...CORE],
  campaign: ["id", "name", "account_id", "status", "effective_status", "daily_budget", "lifetime_budget", "start_time", "stop_time", ...CORE],
  ad_account: ["id", "name", "timezone_name", ...CORE]
});
for (const fields of Object.values(META_MCP_DAY_FIELDS)) Object.freeze(fields);
export const META_MCP_PURCHASE_NAMES = Object.freeze(["omni_purchase","offsite_conversion_fb_pixel_purchase","omni_purchase_values","offsite_conversion_fb_pixel_purchase_values"]);
export const META_MCP_PURCHASE_FIELDS = Object.freeze(Object.fromEntries(Object.entries(META_MCP_DAY_FIELDS).map(([level,fields])=>[level,Object.freeze([...fields,...META_MCP_PURCHASE_NAMES])])) as Record<MetaMcpLevel,readonly string[]>);
const DROP = new Set(["next_actions", "_additional_context", "additional_info", "error", "errors", "token", "access_token", "authorization"]);
const object = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);
function fail(code: typeof META_MCP_WIRE_CODES[number]): never { throw new MetaMcpWireFailure(code); }
function text(v: unknown, max = 8192): string {
  if (typeof v !== "string" || v.length > max || v.includes("\0")) fail("ROW_INVALID");
  return v;
}
function numericId(v: unknown): string {
  if (typeof v !== "string" || !/^\d{1,30}$(?![\s\S])/.test(v)) fail("IDENTITY_MISMATCH");
  return v;
}
function conversationId(v: unknown): string {
  if (typeof v !== "string" || !/^[A-Za-z0-9]{20}$(?![\s\S])/.test(v) || !/[A-Z]/.test(v) || !/[a-z]/.test(v) || !/[0-9]/.test(v)) fail("INPUT_INVALID");
  return v;
}
function decimal(v: unknown): string {
  if (typeof v !== "string" || !/^(0|[1-9]\d{0,13})(\.\d{1,6})?$(?![\s\S])/.test(v)) fail("MONEY_INVALID");
  return v;
}
function money(v: unknown): MetaMcpMoney {
  if (!object(v) || typeof v.unit !== "string" || !v.unit.length || v.unit.length > 32 || /[\u0000-\u001f\u007f-\u009f]/.test(v.unit)) fail("MONEY_INVALID");
  return { value: decimal(v.value), unit: v.unit };
}
function metric(v: unknown, integer: boolean): string {
  if (typeof v !== "string" || !(integer ? /^(0|[1-9]\d{0,18})$(?![\s\S])/ : /^(0|[1-9]\d{0,13})(\.\d{1,12})?$(?![\s\S])/).test(v)) fail("METRIC_INVALID");
  if (integer && BigInt(v) > 9_223_372_036_854_775_807n) fail("METRIC_INVALID");
  return v;
}
function rawMetadata(v: unknown, accountId: string, state: { nodes: number }, depth = 0): unknown {
  if (++state.nodes > 25000 || depth > 40) fail("RUN_LIMIT_EXCEEDED");
  if (v === null || typeof v === "boolean") return v;
  if (typeof v === "string") return text(v);
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (Array.isArray(v)) return v.map(value => rawMetadata(value, accountId, state, depth + 1));
  if (!object(v)) fail("ROW_INVALID");
  const out: Json = Object.create(null) as Json;
  for (const [key, value] of Object.entries(v)) {
    if (DROP.has(key)) continue;
    if (!/^[\x21-\x7e]{1,96}$(?![\s\S])/.test(key)) fail("ROW_INVALID");
    if (key === "account_id" && value !== null && value !== accountId && value !== `act_${accountId}`) fail("ACCOUNT_SCOPE_MISMATCH");
    if (["id", "ad_id", "adset_id", "campaign_id", "business_id", "user_id"].includes(key)) fail("IDENTITY_MISMATCH");
    out[key] = rawMetadata(value, accountId, state, depth + 1);
  }
  return out;
}
function row(raw: unknown, level: MetaMcpLevel, accountId: string, day: string, rowIndex = 0, profile?:"PURCHASE_V1"): Json {
  if (!object(raw) || Object.keys(raw).length > 256) fail("ROW_INVALID");
  if (raw.date_start !== day || raw.date_stop !== day) fail("DATE_MISMATCH");
  const out: Json = { date_start: day, date_stop: day };
  if (level === "ad_account") {
    if (raw.id !== accountId && raw.id !== `act_${accountId}`) fail("ACCOUNT_SCOPE_MISMATCH");
  } else if (raw.account_id !== accountId && raw.account_id !== `act_${accountId}`) fail("ACCOUNT_SCOPE_MISMATCH");
  for (const field of (profile?META_MCP_PURCHASE_FIELDS:META_MCP_DAY_FIELDS)[level]) {
    try {
    if (CORE.includes(field) && !Object.hasOwn(raw, field)) fail(field === "amount_spent" ? "MONEY_INVALID" : "METRIC_INVALID");
    const value = raw[field];
    if (META_MCP_PURCHASE_NAMES.includes(field)) {
      if (!Object.hasOwn(raw,field)) fail("METRIC_INVALID");
      out[field]=value===null?null:field.endsWith("_values")?money(value):metric(value,true);
    } else if (field === "amount_spent") out[field] = money(value);
    // Wire-only scalars retain explicit null; missing fields still fail.
    // Canonical normalization independently requires verified numeric values.
    else if (CORE.includes(field) && value === null) out[field] = null;
    else if (CORE.includes(field)) out[field] = metric(value, field !== "frequency");
    else if (["id", "account_id", "campaign_id", "adset_id"].includes(field)) out[field] =
      field === "id" && level === "ad_account" ? text(value, 34) : field === "account_id" ? text(value, 34) : numericId(value);
    else if (["name", "campaign_name", "adset_name", "timezone_name", "status", "effective_status"].includes(field)) {
      if (typeof value !== "string" || !value.length) fail("ROW_INVALID");
      out[field] = text(value);
    } else if (value !== undefined) {
      // Current budgets are kept in the provider's unit. No minor-unit conversion occurs here.
      out[field] = ["daily_budget", "lifetime_budget"].includes(field) && value !== null
        ? money(value) : rawMetadata(value, accountId, { nodes: 0 });
    }
    } catch (error) {
      if (error instanceof MetaMcpWireFailure && error.safeCode === "IDENTITY_MISMATCH") {
        const value = raw[field];
        const fixedField: MetaMcpWireDiagnostic["field"] = ["id","account_id","campaign_id","adset_id","campaign_name","adset_name","attribution_spec"].includes(field) ? field as MetaMcpWireDiagnostic["field"] : "OTHER";
        const reasonCategory: MetaMcpWireDiagnostic["reasonCategory"] = !Object.hasOwn(raw,field) ? "ABSENT" : value === null ? "NULL" :
          typeof value === "object" ? "NESTED_ID" : typeof value !== "string" ? "NONSTRING" : "INVALID_FORMAT";
        throw new MetaMcpWireFailure(error.safeCode,0,{level,field:fixedField,rowIndex,reasonCategory});
      }
      throw error;
    }
  }
  if (level === "ad_account" && out.timezone_name !== "Asia/Seoul") fail("ACCOUNT_SCOPE_MISMATCH");
  return out;
}
function page(value: unknown, level: MetaMcpLevel, accountId: string, day: string, clientId: string, profile?:"PURCHASE_V1") {
  if (!object(value) || typeof value.ad_entities !== "string" || Buffer.byteLength(value.ad_entities) > PAGE_BYTES || "ad_drafts" in value) fail("OUTPUT_INVALID");
  let entities: unknown; try { entities = JSON.parse(value.ad_entities); } catch { fail("OUTPUT_INVALID"); }
  if (!Array.isArray(entities) || entities.length > 1000) fail("OUTPUT_INVALID");
  if ("client_conversation_id" in value && value.client_conversation_id !== clientId) fail("IDENTITY_MISMATCH");
  let nextCursor: string | null = null;
  if ("pagination" in value) {
    if (!object(value.pagination) || typeof value.pagination.next_cursor !== "string" || !/^[\x21-\x7e]{1,4096}$(?![\s\S])/.test(value.pagination.next_cursor)) fail("CURSOR_INVALID");
    nextCursor = value.pagination.next_cursor;
  }
  let totalCount: number | null = null;
  if ("summary" in value) {
    if (!object(value.summary)) fail("SUMMARY_MISMATCH");
    if ("total_count" in value.summary) {
      if (!Number.isSafeInteger(value.summary.total_count) || (value.summary.total_count as number) < 0) fail("SUMMARY_MISMATCH");
      totalCount = value.summary.total_count as number;
    }
  }
  if ("additional_info" in value && value.additional_info !== "") fail("OUTPUT_INVALID");
  return { rows: entities.map((raw,index) => row(raw, level, accountId, day,index,profile)), nextCursor, totalCount };
}
function toolOutput(result: unknown, level: MetaMcpLevel, accountId: string, day: string, clientId: string, profile?:"PURCHASE_V1") {
  if (!object(result) || ("isError" in result && result.isError !== false)) fail("TOOL_ERROR");
  let structured: ReturnType<typeof page> | null = null, textual: ReturnType<typeof page> | null = null;
  if ("structuredContent" in result) structured = page(result.structuredContent, level, accountId, day, clientId,profile);
  if ("content" in result) {
    if (!Array.isArray(result.content) || result.content.length > 16) fail("OUTPUT_INVALID");
    for (const block of result.content) {
      if (!object(block) || block.type !== "text" || typeof block.text !== "string") fail("OUTPUT_INVALID");
      if (!block.text.trim()) continue; if (textual) fail("OUTPUT_INVALID");
      let decoded: unknown; try { decoded = JSON.parse(block.text); } catch { fail("OUTPUT_INVALID"); }
      textual = page(decoded, level, accountId, day, clientId,profile);
    }
  }
  if (!structured && !textual) fail("OUTPUT_INVALID");
  if (structured && textual && JSON.stringify(structured) !== JSON.stringify(textual)) fail("OUTPUT_MISMATCH");
  return (structured ?? textual)!;
}
/** Shared strict projection for an explicitly bounded, single-page predicate proof. */
export const validateMetaMcpToolOutput = toolOutput;
function catalog(catalog: unknown, reporting: unknown, clientId: string, profile?:"PURCHASE_V1") {
  if (!object(catalog) || catalog.version !== 1 || catalog.server !== MCP || catalog.tool !== "ads_get_field_context" || catalog.client_conversation_id !== clientId || !Array.isArray(catalog.fields)) fail("CATALOG_INVALID");
  const fields = catalog.fields;
  for (const level of LEVELS) for (const name of (profile?META_MCP_PURCHASE_FIELDS:META_MCP_DAY_FIELDS)[level]) {
    const matches = fields.filter(f => object(f) && f.name === name);
    if (matches.length !== 1 || !object(matches[0]) || !Array.isArray(matches[0].levels) || !matches[0].levels.includes(level)) fail("CATALOG_INVALID");
  }
  if (!object(reporting) || reporting.server !== MCP || !object(reporting.reportingTool)) fail("SCHEMA_INVALID");
  const tool = reporting.reportingTool;
  if (tool.name !== "ads_get_ad_entities" || !object(tool.annotations) || tool.annotations.readOnlyHint !== true || tool.annotations.destructiveHint !== false || !object(tool.inputSchema) || !object(tool.inputSchema.properties) || !object(tool.outputSchema) || !object(tool.outputSchema.properties)) fail("SCHEMA_INVALID");
  for (const key of ["ad_account_id", "fields", "level", "time_range", "time_increment", "object_state", "include_additional_context", "client_conversation_id", "cursor", "limit"]) if (!object(tool.inputSchema.properties[key])) fail("SCHEMA_INVALID");
  if (!object(tool.inputSchema.properties.limit) || tool.inputSchema.properties.limit.type !== "integer") fail("SCHEMA_INVALID");
  const entities = tool.outputSchema.properties.ad_entities; if (!object(entities) || entities.type !== "string") fail("SCHEMA_INVALID");
}
// Replay normalization uses the same raw validators as a fresh network read.
export { row as validateMetaMcpWireRow, catalog as validateMetaMcpCatalog };
/** Sequential tools/call only, with identical parameters on subsequent pages and no retries. */
export class MetaMcpWireReader {
  constructor(private readonly request: typeof fetch, private readonly readEnvelope: MetaMcpEnvelopeReader) {}
  async fetchDay(provided: { accountId: string; day: string; clientConversationId: string; accessToken: string;
    catalog: unknown; reporting: unknown; deadlineAt: number; allowUnverifiedIdentityCapture?: boolean;profile?:"PURCHASE_V1" }): Promise<MetaMcpWireSnapshot> {
    const input = Object.freeze({ ...provided });
    let requestCount = 0;
    try {
      const date = new Date(`${input.day}T00:00:00Z`);
      if (!/^\d{1,30}$(?![\s\S])/.test(input.accountId) || !/^\d{4}-\d{2}-\d{2}$(?![\s\S])/.test(input.day) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0,10) !== input.day || !/^[\x21-\x7e]{40,4096}$(?![\s\S])/.test(input.accessToken) || !Number.isFinite(input.deadlineAt) || input.deadlineAt <= Date.now() || input.deadlineAt > Date.now() + 600000) fail("INPUT_INVALID");
      if(input.profile!==undefined&&input.profile!=="PURCHASE_V1")fail("INPUT_INVALID");
      const clientId = conversationId(input.clientConversationId); catalog(input.catalog, input.reporting, clientId,input.profile);
      if (input.allowUnverifiedIdentityCapture !== undefined && typeof input.allowUnverifiedIdentityCapture !== "boolean") fail("INPUT_INVALID");
      const levels = {} as Record<MetaMcpLevel, Json[]>, queries = {} as Record<MetaMcpLevel, Json>; let byteCount = 0, rowCount = 0;
      for (const level of LEVELS) {
        const base: Json = { ad_account_id: input.accountId, fields: [...(input.profile?META_MCP_PURCHASE_FIELDS:META_MCP_DAY_FIELDS)[level]], level,
          time_range: JSON.stringify({ since: input.day, until: input.day }), time_increment: "1",
          object_state: "live", include_additional_context: false, client_conversation_id: clientId, limit: 1000 };
        queries[level] = base; levels[level] = []; let cursor: string | null = null, expectedCount: number | null = null;
        const seenCursors = new Set<string>(), seenIds = new Set<string>();
        do {
          if (requestCount >= 100 || Date.now() >= input.deadlineAt) fail("RUN_LIMIT_EXCEEDED");
          const controller = new AbortController();
          let rejectTimeout: ((error: MetaMcpWireFailure) => void) | undefined;
          const timeout = new Promise<never>((_resolve,reject) => { rejectTimeout = reject; });
          const timer = setTimeout(() => { controller.abort(); rejectTimeout?.(new MetaMcpWireFailure("HTTP_UNAVAILABLE")); }, Math.min(20000,input.deadlineAt-Date.now()));
          let envelope: unknown;
          try {
            requestCount++;
            envelope = await Promise.race([(async () => {
              const response = await this.request(MCP, { method: "POST", redirect: "error", signal: controller.signal,
                headers: { Authorization: `Bearer ${input.accessToken}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" },
                body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ads_get_ad_entities", arguments: cursor === null ? base : { ...base, cursor } } }) });
              if (response.redirected || response.status !== 200 || !response.body) fail("HTTP_UNAVAILABLE");
              const counted = response.body.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({ transform(chunk, controller) {
                byteCount += chunk.byteLength;
                if (byteCount > 16 * 1024 * 1024) fail("RUN_LIMIT_EXCEEDED");
                controller.enqueue(chunk);
              } }));
              return this.readEnvelope(new Response(counted,{ status: response.status, headers: response.headers }),PAGE_BYTES);
            })(),timeout]);
          } finally { clearTimeout(timer); controller.abort(); }
          if (!object(envelope) || envelope.jsonrpc !== "2.0" || envelope.id !== 1 || "error" in envelope || "method" in envelope) fail("ENVELOPE_INVALID");
          const fetched = toolOutput(envelope.result,level,input.accountId,input.day,clientId,input.profile);
          if(JSON.stringify(fetched).includes(input.accessToken))fail("TOKEN_REFLECTION");
          if (fetched.totalCount !== null) { if (expectedCount !== null && expectedCount !== fetched.totalCount) fail("SUMMARY_MISMATCH"); expectedCount = fetched.totalCount; }
          for (const current of fetched.rows) { const key = current.id as string; if (seenIds.has(key)) fail("DUPLICATE_ID"); seenIds.add(key); }
          rowCount += fetched.rows.length; if (rowCount > 50000) fail("RUN_LIMIT_EXCEEDED");
          levels[level].push(...fetched.rows);
          // Search pagination can contain an empty day-result page with a fresh cursor.
          // Bound progress by unique cursors, requests, bytes and the overall deadline.
          if (fetched.nextCursor !== null && seenCursors.has(fetched.nextCursor)) fail("CURSOR_INVALID");
          if (fetched.nextCursor !== null) seenCursors.add(fetched.nextCursor); cursor = fetched.nextCursor;
        } while (cursor !== null);
        if (expectedCount !== null && expectedCount !== levels[level].length) fail("SUMMARY_MISMATCH");
      }
      if (levels.ad_account.length !== 1) fail("ACCOUNT_SCOPE_MISMATCH");
      const campaigns = new Map(levels.campaign.map(r => [r.id,r])), adsets = new Map(levels.adset.map(r => [r.id,r]));
      let identityDiagnostic: MetaMcpWireDiagnostic | undefined;
      const missingCampaigns = new Set<string>(), missingAdsets = new Set<string>();
      const identityFailure = (diagnostic: MetaMcpWireDiagnostic) => {
        if (!input.allowUnverifiedIdentityCapture) throw new MetaMcpWireFailure("IDENTITY_MISMATCH",0,diagnostic);
        identityDiagnostic ??= diagnostic;
      };
      for (const [rowIndex,adset] of levels.adset.entries()) { const parent = campaigns.get(adset.campaign_id); if (!parent || parent.name !== adset.campaign_name)
        { if (!parent) missingCampaigns.add(adset.campaign_id as string);
          identityFailure({level:"adset",field:!parent?"campaign_id":"campaign_name",rowIndex,reasonCategory:!parent?"PARENT_MISSING":"PARENT_NAME_MISMATCH"}); } }
      for (const [rowIndex,ad] of levels.ad.entries()) { const parent = adsets.get(ad.adset_id), campaign = campaigns.get(ad.campaign_id);
        if (!parent) missingAdsets.add(ad.adset_id as string); if (!campaign) missingCampaigns.add(ad.campaign_id as string);
        if (!parent || !campaign || parent.campaign_id !== ad.campaign_id || parent.name !== ad.adset_name || campaign.name !== ad.campaign_name)
          identityFailure({level:"ad",field:!parent?"adset_id":!campaign||parent.campaign_id!==ad.campaign_id?"campaign_id":parent.name!==ad.adset_name?"adset_name":"campaign_name",rowIndex,reasonCategory:!parent||!campaign?"PARENT_MISSING":"PARENT_NAME_MISMATCH"}); }
      const moneyUnits = [...new Set(LEVELS.flatMap(level => levels[level].map(r => (r.amount_spent as MetaMcpMoney).unit)))].sort();
      const snapshot: MetaMcpWireSnapshot = { version: 1, transport: "META_ADS_MCP", accountId: input.accountId, day: input.day, observedAtUtc: new Date().toISOString(), clientConversationId: clientId,
        ...(input.profile?{profile:input.profile}:{}),
        pageCount: requestCount, byteCount, status: input.allowUnverifiedIdentityCapture ? "COMPLETE_WIRE_UNVERIFIED_IDENTITY" : "COMPLETE_WIRE_ONLY", levels, queries, moneyUnits, paginationComplete: true, datesVerified: true, identityVerified: !input.allowUnverifiedIdentityCapture,
        ...(input.allowUnverifiedIdentityCapture ? {missingParentIds:{campaign:[...missingCampaigns].sort(),adset:[...missingAdsets].sort()},...(identityDiagnostic?{identityDiagnostic}:{})}:{}),
        currencyVerified: false, attributionVerified: false, metricsNormalized: false, productionReady: false };
      if (JSON.stringify(snapshot).includes(input.accessToken)) fail("TOKEN_REFLECTION");
      return snapshot;
    } catch (error) { throw new MetaMcpWireFailure(error instanceof MetaMcpWireFailure ? error.safeCode : "HTTP_UNAVAILABLE",requestCount,error instanceof MetaMcpWireFailure ? error.diagnostic : undefined); }
  }
}
