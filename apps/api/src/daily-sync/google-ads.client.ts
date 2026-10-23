import { Injectable } from "@nestjs/common";
import { GoogleAuth } from "google-auth-library";
import { SourceDataKind } from "@prisma/client";
import { boundedProviderRequest, collectBoundedPages, ProviderFailure, retryAfterMs } from "./bounded-request";
import { parseIsoDate } from "./sync-contract";

// Keep the REST major version pinned until its fields and response shape are rechecked.
export const GOOGLE_ADS_API_VERSION = "v25";
const ADS_SCOPE = "https://www.googleapis.com/auth/adwords";
const INT64_MAX = 9_223_372_036_854_775_807n;
const GOOGLE_PAGE_BYTES = 12 * 1024 * 1024;
const ACCOUNT_QUERY = "SELECT customer.id, customer.currency_code, customer.time_zone FROM customer LIMIT 1";

export type GoogleCampaignRow = {
  campaignId: string; campaignName: string; channelType: string;
  costMicros: bigint; impressions: bigint; clicks: bigint;
};
export type GoogleDaySnapshot = {
  rows: GoogleCampaignRow[]; pageCount: number; accountCostMicros: bigint;
  currencyCode: string; timeZone: string; requestId: string | null;
};
type SearchPage = { results?: unknown[]; nextPageToken?: unknown; requestId?: unknown };
type TokenProvider = { getAccessToken(): Promise<string | null | undefined> };

function int64(value: unknown): bigint {
  // Protobuf JSON omits scalar fields at their zero default.
  if (value === undefined || value === null) return 0n;
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value))
    throw new ProviderFailure("FIELD_UNSUPPORTED", false);
  const parsed = BigInt(value);
  if (parsed > INT64_MAX) throw new ProviderFailure("FIELD_UNSUPPORTED", false);
  return parsed;
}
function safeId(value: unknown) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : null;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ProviderFailure("FIELD_UNSUPPORTED", false);
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new ProviderFailure("FIELD_UNSUPPORTED", false);
  return value;
}
function parseRow(raw: unknown, day: string): GoogleCampaignRow {
  const row = object(raw), campaign = object(row.campaign);
  const metrics = row.metrics == null ? {} : object(row.metrics);
  const segments = object(row.segments);
  if (segments.date !== day) throw new ProviderFailure("RECONCILIATION_FAILED", false);
  return {
    campaignId: text(campaign.id, 256), campaignName: text(campaign.name, 256),
    channelType: text(campaign.advertisingChannelType, 64),
    costMicros: int64(metrics.costMicros), impressions: int64(metrics.impressions),
    clicks: int64(metrics.clicks)
  };
}
function classifyError(status: number, body: unknown, retryHeader: string | null,
  headerId: string | null): ProviderFailure {
  let code = "PROVIDER_UNAVAILABLE";
  let requestId = headerId;
  let customerNotFound = false;
  try {
    const error = object(object(body).error);
    if (!requestId) requestId = safeId(error.requestId);
    const details = Array.isArray(error.details) ? error.details : [];
    const errors = details.flatMap((detail) => {
      const item = object(detail);
      if (!requestId) requestId = safeId(item.requestId);
      return Array.isArray(item.errors) ? item.errors.map((entry) => object(object(entry).errorCode)) : [];
    });
    const codes = errors.flatMap((entry) => Object.keys(entry));
    customerNotFound = errors.some((entry) =>
      Object.values(entry).some((value) => value === "CUSTOMER_NOT_FOUND"));
    if (codes.some((item) => /QUERY|FIELD|UNRECOGNIZED|UNSUPPORTED|REQUEST_ERROR/i.test(item)))
      code = "FIELD_UNSUPPORTED";
    else if (status === 401 || status === 403) code = "PROVIDER_AUTH_REQUIRED";
    else if (status === 429 || codes.some((item) => /QUOTA|RATE_LIMIT/i.test(item)))
      code = "PROVIDER_RATE_LIMITED";
  } catch { /* Never surface provider text or credential-bearing payloads. */ }
  if (customerNotFound) code = "ACCOUNT_SCOPE_MISMATCH";
  else if ((status === 401 || status === 403) && code !== "FIELD_UNSUPPORTED")
    code = "PROVIDER_AUTH_REQUIRED";
  if (status === 429) code = "PROVIDER_RATE_LIMITED";
  if ((status === 400 || status === 404) && code === "PROVIDER_UNAVAILABLE")
    code = "FIELD_UNSUPPORTED"; // The safe code also covers an unsupported REST version.
  const diagnosticCode = customerNotFound ? "GOOGLE_CUSTOMER_NOT_FOUND" :
    status === 403 ? "GOOGLE_ADS_ACCESS_DENIED" :
    status === 401 ? "GOOGLE_ACCESS_TOKEN_REJECTED" : null;
  return new ProviderFailure(code, status === 429 || status >= 500,
    retryAfterMs(retryHeader), requestId, diagnosticCode);
}

@Injectable()
export class GoogleAdsClient {
  private readonly auth: TokenProvider;
  constructor(auth?: TokenProvider, private readonly request: typeof fetch = fetch) {
    this.auth = auth ?? new GoogleAuth({ scopes: [ADS_SCOPE] });
  }

  async fetchDay(input: {
    customerId: string; day: string; deadlineAt: number; loginCustomerId?: string | null;
  }): Promise<GoogleDaySnapshot> {
    parseIsoDate(input.day);
    if (!/^\d{1,20}$/.test(input.customerId) ||
        (input.loginCustomerId && !/^\d{1,20}$/.test(input.loginCustomerId)))
      throw new ProviderFailure("ACCOUNT_SCOPE_MISMATCH", false);
    let requestId: string | null = null;
    const account = await this.searchAll(input, ACCOUNT_QUERY);
    requestId = account.requestId;
    if (account.rows.length !== 1) throw new ProviderFailure("ACCOUNT_SCOPE_MISMATCH", false, null, requestId);
    const customer = object(object(account.rows[0]).customer);
    if (customer.id !== input.customerId) throw new ProviderFailure("ACCOUNT_SCOPE_MISMATCH", false, null, requestId);
    const currencyCode = text(customer.currencyCode, 3), timeZone = text(customer.timeZone, 128);
    const campaignQuery = "SELECT segments.date, campaign.id, campaign.name, " +
      "campaign.advertising_channel_type, metrics.cost_micros, metrics.impressions, metrics.clicks " +
      `FROM campaign WHERE segments.date = '${input.day}'`;
    const campaigns = await this.searchAll(input, campaignQuery);
    requestId = campaigns.requestId ?? requestId;
    const rows = campaigns.rows.map((row) => parseRow(row, input.day));
    if (new Set(rows.map((row) => row.campaignId)).size !== rows.length)
      throw new ProviderFailure("RECONCILIATION_FAILED", false, null, requestId);
    const totalQuery = "SELECT segments.date, metrics.cost_micros FROM customer " +
      `WHERE segments.date = '${input.day}'`;
    const total = await this.searchAll(input, totalQuery);
    requestId = total.requestId ?? requestId;
    if (total.rows.length > 1) throw new ProviderFailure("RECONCILIATION_FAILED", false, null, requestId);
    let accountCostMicros = 0n;
    if (total.rows.length) {
      const row = object(total.rows[0]);
      if (object(row.segments).date !== input.day) throw new ProviderFailure("RECONCILIATION_FAILED", false);
      accountCostMicros = int64(row.metrics == null ? undefined : object(row.metrics).costMicros);
    }
    const campaignCost = rows.reduce((sum, row) => sum + row.costMicros, 0n);
    if (campaignCost !== accountCostMicros)
      throw new ProviderFailure("RECONCILIATION_FAILED", false, null, requestId);
    return { rows, pageCount: campaigns.pageCount, accountCostMicros,
      currencyCode, timeZone, requestId };
  }

  private async searchAll(input: { customerId: string; deadlineAt: number;
    loginCustomerId?: string | null }, query: string) {
    let requestId: string | null = null;
    const collected = await collectBoundedPages(SourceDataKind.GOOGLE_CAMPAIGN, async (cursor) => {
      const page = await boundedProviderRequest(async (signal) => {
        let token: string | null | undefined;
        try { token = await this.auth.getAccessToken(); }
        catch { throw new ProviderFailure("PROVIDER_AUTH_REQUIRED", false,
          null, null, "GOOGLE_AUTH_REFRESH_FAILED"); }
        if (!token) throw new ProviderFailure("PROVIDER_AUTH_REQUIRED", false,
          null, null, "GOOGLE_AUTH_REFRESH_FAILED");
        // ADC token refresh may ignore AbortSignal and settle after the bounded request timed out.
        // Never start an Ads request for that expired attempt, including a later retry's old promise.
        if (signal.aborted || Date.now() >= input.deadlineAt)
          throw new ProviderFailure("RUN_LIMIT_EXCEEDED", false);
        const headers: Record<string, string> = {
          Authorization: `Bearer ${token}`, "Content-Type": "application/json"
        };
        if (input.loginCustomerId) headers["login-customer-id"] = input.loginCustomerId;
        let response: Response;
        if (signal.aborted || Date.now() >= input.deadlineAt)
          throw new ProviderFailure("RUN_LIMIT_EXCEEDED", false);
        try {
          response = await this.request(`https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}` +
            `/customers/${input.customerId}/googleAds:search`, {
            method: "POST", headers, body: JSON.stringify({ query, ...(cursor ? { pageToken: cursor } : {}) }), signal
          });
        } catch { throw new ProviderFailure("PROVIDER_UNAVAILABLE", true); }
        const headerId = safeId(response.headers.get("request-id"));
        const bytes = await readResponse(response);
        let body: unknown;
        try { body = JSON.parse(bytes.toString("utf8")); }
        catch { throw new ProviderFailure("FIELD_UNSUPPORTED", false, null, headerId); }
        if (!response.ok)
          throw classifyError(response.status, body, response.headers.get("retry-after"), headerId);
        const pageBody = object(body) as SearchPage;
        const pageId = safeId(pageBody.requestId) ?? headerId;
        requestId = pageId ?? requestId;
        const results = pageBody.results ?? [];
        if (!Array.isArray(results)) throw new ProviderFailure("FIELD_UNSUPPORTED", false, null, pageId);
        const nextCursor = pageBody.nextPageToken == null ? null :
          text(pageBody.nextPageToken, 512);
        return { rows: results, nextCursor, bytes: bytes.length };
      }, input.deadlineAt);
      return page;
    }, { maxPageBytes: GOOGLE_PAGE_BYTES, maxUnitBytes: 16 * 1024 * 1024 });
    return { ...collected, requestId };
  }
}

async function readResponse(response: Response): Promise<Buffer> {
  if (!response.body) throw new ProviderFailure("PARTIAL_PAGE", false);
  const chunks: Buffer[] = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.length;
      if (size > GOOGLE_PAGE_BYTES) throw new ProviderFailure("RUN_LIMIT_EXCEEDED", false);
      chunks.push(Buffer.from(item.value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}
