import { Injectable } from "@nestjs/common";
import { GoogleAuth } from "google-auth-library";
import { SourceDataKind } from "@prisma/client";
import { boundedProviderRequest, collectBoundedPages, ProviderFailure, retryAfterMs } from "./bounded-request";
import { parseIsoDate } from "./sync-contract";
import { GoogleCreativeAsset, GoogleCreativeMetric, GoogleCampaignCreatives, validGoogleCreatives } from "../domain/google-creative-metrics";

// Keep the REST major version pinned until its fields and response shape are rechecked.
export const GOOGLE_ADS_API_VERSION = "v25";
const ADS_SCOPE = "https://www.googleapis.com/auth/adwords";
const INT64_MAX = 9_223_372_036_854_775_807n;
const GOOGLE_PAGE_BYTES = 12 * 1024 * 1024;
const ACCOUNT_QUERY = "SELECT customer.id, customer.currency_code, customer.time_zone FROM customer LIMIT 1";

export type GoogleCampaignRow = {
  campaignId: string; campaignName: string; channelType: string;
  costMicros: bigint; impressions: bigint; clicks: bigint;
  creativeMetrics?: GoogleCampaignCreatives;
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
      "campaign.advertising_channel_type, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.all_conversions " +
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
    // Fetch and reconcile all child facts before publishing any part of this day.
    const creatives = await this.fetchCreatives(input, rows);
    requestId = creatives.requestId ?? requestId;
    return { rows, pageCount: campaigns.pageCount, accountCostMicros,
      currencyCode, timeZone, requestId };
  }

  private async fetchCreatives(input: { customerId: string; day: string; deadlineAt: number; loginCustomerId?: string | null }, campaigns: GoogleCampaignRow[]) {
    const where = `WHERE segments.date = '${input.day}'`;
    const ads = await this.searchAll(input, "SELECT segments.date, campaign.id, ad_group.id, ad_group.name, " +
      "ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.ad.type, ad_group_ad.status, " +
      "ad_group_ad.ad.demand_gen_multi_asset_ad.marketing_images, ad_group_ad.ad.demand_gen_multi_asset_ad.square_marketing_images, " +
      "ad_group_ad.ad.demand_gen_multi_asset_ad.portrait_marketing_images, ad_group_ad.ad.demand_gen_video_responsive_ad.videos, " +
      `metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.all_conversions FROM ad_group_ad ${where}`);
    const purchases = await this.searchAll(input, "SELECT segments.date, campaign.id, ad_group.id, ad_group_ad.ad.id, " +
      `segments.conversion_action_category, metrics.conversions, metrics.conversions_value FROM ad_group_ad ${where} ` +
      "AND segments.conversion_action_category = 'PURCHASE'");
    // Video-only fields suppress image rows, so collect them independently.
    const videos = await this.searchAll(input, "SELECT segments.date, campaign.id, ad_group.id, ad_group_ad.ad.id, metrics.video_trueview_views, " +
      "metrics.video_trueview_view_rate, metrics.video_quartile_p25_rate, metrics.video_quartile_p50_rate, " +
      `metrics.video_quartile_p75_rate, metrics.video_quartile_p100_rate FROM ad_group_ad ${where}`);
    const identity = (row: Record<string, unknown>) => {
      if (object(row.segments).date !== input.day) throw new ProviderFailure("RECONCILIATION_FAILED", false);
      return [text(object(row.campaign).id, 20), text(object(row.adGroup).id, 20), text(object(object(row.adGroupAd).ad).id, 20)].join("/");
    };
    const facts = new Map<string, GoogleCreativeMetric>();
    const assetRefs = new Map<string, string[]>();
    const decimal = (v: unknown) => {
      const n = v == null ? 0 : Number(v);
      if (!Number.isFinite(n) || Math.abs(n) > 1e15) throw new ProviderFailure("FIELD_UNSUPPORTED", false);
      return n;
    };
    const count = (v: unknown) => {
      const n = int64(v); if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new ProviderFailure("FIELD_UNSUPPORTED", false);
      return Number(n);
    };
    for (const raw of ads.rows) {
      const row = object(raw), key = identity(row), ad = object(object(row.adGroupAd).ad), group = object(row.adGroup), metrics = object(row.metrics ?? {});
      if (facts.has(key)) throw new ProviderFailure("RECONCILIATION_FAILED", false);
      const references: string[] = [];
      const image = ad.demandGenMultiAssetAd == null ? {} : object(ad.demandGenMultiAssetAd);
      const video = ad.demandGenVideoResponsiveAd == null ? {} : object(ad.demandGenVideoResponsiveAd);
      for (const list of [image.marketingImages, image.squareMarketingImages, image.portraitMarketingImages, video.videos]) {
        if (list == null) continue;
        if (!Array.isArray(list) || list.length > 100) throw new ProviderFailure("FIELD_UNSUPPORTED", false);
        for (const item of list) {
          const ref = text(object(item).asset, 256);
          if (!new RegExp(`^customers/${input.customerId}/assets/[0-9]{1,20}$`).test(ref)) throw new ProviderFailure("ACCOUNT_SCOPE_MISMATCH", false);
          references.push(ref);
        }
      }
      assetRefs.set(key, [...new Set(references)]);
      facts.set(key, { adGroupId: text(group.id, 20), adGroupName: text(group.name, 1024), adId: text(ad.id, 20),
        adName: typeof ad.name === "string" && ad.name.trim() ? text(ad.name, 1024) : `광고 ${ad.id}`,
        adType: text(ad.type, 64), status: text(object(row.adGroupAd).status, 64),
        costMicros: int64(metrics.costMicros).toString(), impressions: count(metrics.impressions), clicks: count(metrics.clicks),
        purchaseCount: 0, purchaseValue: 0, videoViews: null, videoViewRate: null, videoP25: null, videoP50: null, videoP75: null, videoP100: null, assets: [] });
    }
    const purchaseSeen = new Set<string>();
    for (const raw of purchases.rows) {
      const row = object(raw), key = identity(row), fact = facts.get(key), metrics = object(row.metrics ?? {});
      if (!fact || purchaseSeen.has(key) || object(row.segments).conversionActionCategory !== "PURCHASE") throw new ProviderFailure("RECONCILIATION_FAILED", false);
      purchaseSeen.add(key);
      fact.purchaseCount += decimal(metrics.conversions); fact.purchaseValue += decimal(metrics.conversionsValue);
    }
    const videoSeen = new Set<string>();
    for (const raw of videos.rows) {
      const row = object(raw), key = identity(row), fact = facts.get(key), metrics = object(row.metrics ?? {});
      if (!fact || videoSeen.has(key)) throw new ProviderFailure("RECONCILIATION_FAILED", false);
      videoSeen.add(key);
      fact.videoViews = count(metrics.videoTrueviewViews); fact.videoViewRate = decimal(metrics.videoTrueviewViewRate);
      fact.videoP25 = decimal(metrics.videoQuartileP25Rate); fact.videoP50 = decimal(metrics.videoQuartileP50Rate);
      fact.videoP75 = decimal(metrics.videoQuartileP75Rate); fact.videoP100 = decimal(metrics.videoQuartileP100Rate);
    }
    const references = [...new Set([...assetRefs.values()].flat())].sort();
    const assets = new Map<string, GoogleCreativeAsset>();
    for (let start = 0; start < references.length; start += 200) {
      const ids = references.slice(start, start + 200).map(ref => ref.split("/").at(-1)!);
      const details = await this.searchAll(input, "SELECT asset.resource_name, asset.id, asset.name, asset.type, asset.image_asset.full_size.url, " +
        `asset.youtube_video_asset.youtube_video_id, asset.youtube_video_asset.youtube_video_title FROM asset WHERE asset.id IN (${ids.join(",")})`);
      for (const raw of details.rows) {
        const asset = object(object(raw).asset), type = text(asset.type, 64);
        if (type !== "IMAGE" && type !== "YOUTUBE_VIDEO") throw new ProviderFailure("FIELD_UNSUPPORTED", false);
        const video = asset.youtubeVideoAsset == null ? {} : object(asset.youtubeVideoAsset);
        const image = asset.imageAsset == null ? {} : object(asset.imageAsset);
        assets.set(text(asset.resourceName, 256), { id: text(asset.id, 20), type,
          name: typeof video.youtubeVideoTitle === "string" ? video.youtubeVideoTitle : typeof asset.name === "string" ? asset.name : "",
          imageUrl: image.fullSize == null ? null : text(object(image.fullSize).url, 8192),
          videoId: video.youtubeVideoId == null ? null : text(video.youtubeVideoId, 64) });
      }
    }
    const campaignIds = new Set(campaigns.map(c => c.campaignId));
    for (const [key, fact] of facts) {
      if (!campaignIds.has(key.split("/")[0])) throw new ProviderFailure("RECONCILIATION_FAILED", false);
      fact.assets = (assetRefs.get(key) ?? []).map(ref => {
        const asset = assets.get(ref); if (!asset) throw new ProviderFailure("PARTIAL_PAGE", false); return asset;
      });
    }
    for (const campaign of campaigns) {
      const payload: GoogleCampaignCreatives = { schemaVersion: 1, ads: [...facts].filter(([key]) => key.split("/")[0] === campaign.campaignId)
        .map(([, fact]) => fact).sort((a, b) => `${a.adGroupId}/${a.adId}`.localeCompare(`${b.adGroupId}/${b.adId}`)) };
      if (!validGoogleCreatives(payload, campaign)) throw new ProviderFailure("RECONCILIATION_FAILED", false);
      campaign.creativeMetrics = payload;
    }
    return { requestId: videos.requestId ?? purchases.requestId ?? ads.requestId };
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
