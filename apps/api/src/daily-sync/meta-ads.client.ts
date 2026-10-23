import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { Prisma, SourceDataKind } from "@prisma/client";
import { MetaUnavailableReasons, sumComplete } from "../domain/meta-conditional-metrics";
import { CreativeNameParser } from "../domain/creative-name-parser";
import { MetaApiAd, MetaApiAdset } from "./canonical-api-writer.service";
import { boundedProviderRequest, collectBoundedPages, ProviderFailure, retryAfterMs } from "./bounded-request";
import { parseIsoDate } from "./sync-contract";
import { MetaDayReader } from "./meta-day-reader";
import { MetaCurrentAsset, MetaCurrentMetadata, currentDeliveryStatus, validCurrentMetadata, MetaMcpNullBasicProjection } from "../domain/meta-current-metadata";

// 01 verified this major version with the target account. Change only after a new field audit.
export const META_GRAPH_API_VERSION = "v26.0";
const GRAPH = `https://graph.facebook.com/${META_GRAPH_API_VERSION}`;
const PAGE_BYTES = 2 * 1024 * 1024;
const ACCOUNT_FIELDS = "id,currency,timezone_name";
const INSIGHT_FIELDS = ["date_start", "date_stop", "account_id", "campaign_id", "adset_id", "ad_id",
  "spend", "impressions", "inline_link_clicks", "clicks", "reach", "frequency", "attribution_setting", "actions",
  "video_p25_watched_actions",
  "video_p50_watched_actions", "video_p75_watched_actions", "video_p100_watched_actions",
  "cpm", "cost_per_inline_link_click",
  "inline_link_click_ctr", "ctr", "cpc"].join(",");

type Json = Record<string, unknown>;
type TokenProvider = { getAccessToken(): Promise<string | null> };
type GraphPage = { data?: unknown; paging?: { cursors?: { after?: unknown } }; error?: unknown };
export type MetaReadSettings = {
  actionReportTime: "conversion" | "impression" | "mixed" | "MCP_PROVIDER_DEFAULT_UNVERIFIED";
  attributionWindows: readonly ("1d_click" | "7d_click" | "1d_view" | "7d_view")[];
  resultActionTypesByDay?: Record<string, Record<string, string>>;
  expectedAttributionSetting?: string;
  expectedAttributionSettingsByDay?: Record<string, Record<string, string>>;
};
export type MetaDaySnapshot = {
  ads: MetaApiAd[]; adsets: MetaApiAdset[]; pageCount: number;nullBasicParentProjection?:MetaMcpNullBasicProjection;
  accountSpendUsd: string; currencyCode: string; timeZone: string;
  accountPurchaseCount?:number;accountPurchaseValueUsd?:string;
  requestId: string | null; settings: MetaReadSettings;
  transport?: "GRAPH" | "MCP"; protocolVersion?: "2025-06-18";
};
export type MetaAdProbeRow = { adId: string; spendUsd: string; impressions: string; inlineLinkClicks: number };
export type MetaDayProbe = { currencyCode: string; timeZone: string; accountSpendUsd: string;
  accountImpressions: string; accountInlineLinkClicks: number; ads: MetaAdProbeRow[];
  pageCount: number; shopClicksFieldPresent: boolean; actionTypes: string[];
  attributionSettings: string[];
  actionTotals: { purchase: number | null; addToCart: number | null;
    video3s: number | null; video25: number | null; video50: number | null;
    video75: number | null; video100: number | null } };

function fail(code = "FIELD_UNSUPPORTED"): never { throw new ProviderFailure(code, false); }
function obj(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  return value as Json;
}
function str(value: unknown, max = 256): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) fail();
  return value.trim();
}
function id(value: unknown): string {
  const result = str(value);
  if (!/^\d{1,30}$/.test(result)) fail("ACCOUNT_SCOPE_MISMATCH");
  return result;
}
function accountId(value: unknown): string {
  const result = str(value);
  const match = /^(?:act_)?(\d{1,30})$/.exec(result);
  if (!match) fail("ACCOUNT_SCOPE_MISMATCH");
  return match[1];
}
function decimal(value: unknown, scale: number): string {
  const result = value === undefined || value === null ? "0" : str(value, 40);
  if (!/^(0|[1-9]\d{0,13})(\.\d{1,6})?$/.test(result)) fail();
  const parsed = new Prisma.Decimal(result);
  if (parsed.decimalPlaces() > scale) fail();
  return parsed.toFixed(scale);
}
function integer(value: unknown, max = 2_147_483_647): number {
  // Graph omits zero-valued scalar insight fields.
  if (value === undefined || value === null) return 0;
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) fail();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > max) fail();
  return parsed;
}
function int64(value: unknown): string {
  if (value === undefined || value === null) return "0";
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value) ||
      BigInt(value) > 9_223_372_036_854_775_807n) fail();
  return value;
}
function countActions(value: unknown, actionType: string): number | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) fail();
  const matches = actionRows(value).filter((row) => row.action_type === actionType);
  if (matches.length > 1) fail("RECONCILIATION_FAILED");
  return matches.length ? integer(matches[0].value) : 0;
}
function countMetricActions(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) fail();
  const parsed = actionRows(value);
  if (parsed.length === 0) return 0;
  // Video metrics may include several action types. Do not add aliases together.
  if (parsed.length !== 1 || parsed[0].action_type !== "video_view") return null;
  return integer(parsed[0].value);
}
function optionalDecimal(value: unknown, scale: number): string | null {
  return value === undefined || value === null ? null : decimal(value, scale);
}
function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function requiredSettings(settings: MetaReadSettings): MetaReadSettings {
  if (!["conversion", "impression", "mixed"].includes(settings.actionReportTime) ||
      !Array.isArray(settings.attributionWindows) || settings.attributionWindows.length < 1 ||
      settings.attributionWindows.length > 4 ||
      new Set(settings.attributionWindows).size !== settings.attributionWindows.length ||
      settings.attributionWindows.some((item) => !["1d_click", "7d_click", "1d_view", "7d_view"].includes(item)))
    fail("ATTRIBUTION_MISMATCH");
  return settings;
}

/** Read-only Graph adapter. It never requests ads_management or changes account assets. */
@Injectable()
export class MetaAdsClient extends MetaDayReader {
  readonly transport = "GRAPH" as const;
  private readonly parser = new CreativeNameParser();
  constructor(private readonly token: TokenProvider = {
    getAccessToken: async () => process.env.DAILY_SYNC_META_ACCESS_TOKEN ?? null
  }, private readonly request: typeof fetch = fetch) { super(); }

  /** A read-only evidence path for temporary ads_read user tokens; it never publishes. */
  async probeDay(input: { accountId: string; day: string; deadlineAt: number;
    settings: MetaReadSettings }): Promise<MetaDayProbe> {
    parseIsoDate(input.day);
    if (!/^\d{1,30}$/.test(input.accountId)) fail("ACCOUNT_SCOPE_MISMATCH");
    const settings = requiredSettings(input.settings);
    const path = `act_${input.accountId}`;
    const account = obj(await this.get(`${GRAPH}/${path}`,
      new URLSearchParams({ fields: ACCOUNT_FIELDS }), input.deadlineAt, null));
    if (accountId(account.id) !== input.accountId) fail("ACCOUNT_SCOPE_MISMATCH");
    const base = new URLSearchParams({ fields: INSIGHT_FIELDS,
      time_range: JSON.stringify({ since: input.day, until: input.day }), time_increment: "1",
      action_report_time: settings.actionReportTime,
      action_attribution_windows: JSON.stringify(settings.attributionWindows),
      use_unified_attribution_setting: "true", limit: "500" });
    const adPages = await this.pages(`${GRAPH}/${path}/insights`, new URLSearchParams(base),
      SourceDataKind.META_AD, input.deadlineAt, null, { level: "ad" });
    const accountPages = await this.pages(`${GRAPH}/${path}/insights`, new URLSearchParams(base),
      SourceDataKind.META_AD, input.deadlineAt, null, { level: "account" });
    if (accountPages.rows.length > 1) fail("RECONCILIATION_FAILED");
    const accountRow = accountPages.rows[0] ? obj(accountPages.rows[0]) : null;
    if (accountRow) this.assertInsightScope(accountRow, input.accountId, input.day);
    const seen = new Set<string>();
    let shopClicksFieldPresent = adPages.rows.length > 0;
    const actionTypes = new Set<string>();
    const attributionSettings = new Set<string>();
    const ads = adPages.rows.map((raw) => {
      const row = obj(raw);
      this.assertInsightScope(row, input.accountId, input.day);
      const adId = id(row.ad_id);
      if (seen.has(adId)) fail("RECONCILIATION_FAILED");
      seen.add(adId);
      if (row.shop_clicks === undefined) shopClicksFieldPresent = false;
      attributionSettings.add(row.attribution_setting == null ? "MISSING" : str(row.attribution_setting, 128));
      if (row.actions !== undefined) {
        if (!Array.isArray(row.actions)) fail();
        for (const action of row.actions.map(obj)) actionTypes.add(str(action.action_type, 128));
      }
      return { adId, spendUsd: decimal(row.spend, 4), impressions: int64(row.impressions),
        inlineLinkClicks: integer(row.inline_link_clicks) };
    });
    const adSpend = ads.reduce((sum, row) => sum.plus(row.spendUsd), new Prisma.Decimal(0));
    const adImpressions = ads.reduce((sum, row) => sum + BigInt(row.impressions), 0n);
    const adClicks = ads.reduce((sum, row) => sum + row.inlineLinkClicks, 0);
    const accountSpendUsd = decimal(accountRow?.spend, 4);
    const accountImpressions = int64(accountRow?.impressions);
    const accountInlineLinkClicks = integer(accountRow?.inline_link_clicks);
    if (!adSpend.eq(accountSpendUsd) || adImpressions !== BigInt(accountImpressions) ||
        adClicks !== accountInlineLinkClicks) fail("RECONCILIATION_FAILED");
    return { currencyCode: str(account.currency, 3), timeZone: str(account.timezone_name, 128),
      accountSpendUsd, accountImpressions, accountInlineLinkClicks, ads,
      pageCount: adPages.pageCount + accountPages.pageCount, shopClicksFieldPresent,
      actionTypes: [...actionTypes].sort(), attributionSettings: [...attributionSettings].sort(), actionTotals: {
        purchase: accountRow?.actions == null ? null : purchase(accountRow.actions),
        addToCart: countActions(accountRow?.actions, "add_to_cart"),
        video3s: countActions(accountRow?.actions, "video_view"),
        video25: countMetricActions(accountRow?.video_p25_watched_actions),
        video50: countMetricActions(accountRow?.video_p50_watched_actions),
        video75: countMetricActions(accountRow?.video_p75_watched_actions),
        video100: countMetricActions(accountRow?.video_p100_watched_actions) } };
  }

  async fetchDay(input: { accountId: string; day: string; deadlineAt: number;
    settings: MetaReadSettings; accessToken: string }): Promise<MetaDaySnapshot> {
    parseIsoDate(input.day);
    if (!/^\d{1,30}$/.test(input.accountId)) fail("ACCOUNT_SCOPE_MISMATCH");
    if (typeof input.accessToken !== "string" || !/^[\x21-\x7e]{40,4096}$/.test(input.accessToken))
      fail("PROVIDER_AUTH_REQUIRED");
    const settings = requiredSettings(input.settings);
    const resultMap = settings.resultActionTypesByDay?.[input.day] ?? {};
    const path = `act_${input.accountId}`;
    const account = obj(await this.get(`${GRAPH}/${path}`, new URLSearchParams({ fields: ACCOUNT_FIELDS }),
      input.deadlineAt, input.accessToken));
    if (accountId(account.id) !== input.accountId) fail("ACCOUNT_SCOPE_MISMATCH");
    const currencyCode = str(account.currency, 3);
    const timeZone = str(account.timezone_name, 128);
    if (currencyCode !== "USD" || timeZone !== "Asia/Seoul") fail("ACCOUNT_SCOPE_MISMATCH");
    const base = new URLSearchParams({ fields: INSIGHT_FIELDS,
      time_range: JSON.stringify({ since: input.day, until: input.day }), time_increment: "1",
      action_report_time: settings.actionReportTime,
      action_attribution_windows: JSON.stringify(settings.attributionWindows),
      use_unified_attribution_setting: "true", limit: "500" });
    const adPages = await this.pages(`${GRAPH}/${path}/insights`, new URLSearchParams(base),
      SourceDataKind.META_AD, input.deadlineAt, input.accessToken, { level: "ad" });
    const adsetPages = await this.pages(`${GRAPH}/${path}/insights`, new URLSearchParams(base),
      SourceDataKind.META_ADSET, input.deadlineAt, input.accessToken, { level: "adset" });
    const accountPages = await this.pages(`${GRAPH}/${path}/insights`, new URLSearchParams(base),
      SourceDataKind.META_AD, input.deadlineAt, input.accessToken, { level: "account" });
    if (accountPages.rows.length > 1) fail("RECONCILIATION_FAILED");
    const campaigns = await this.pages(`${GRAPH}/${path}/campaigns`,
      new URLSearchParams({ fields: "id,name,status,effective_status,daily_budget,lifetime_budget,start_time,stop_time", limit: "500" }),
      SourceDataKind.META_AD, input.deadlineAt, input.accessToken);
    const adsetsMeta = await this.pages(`${GRAPH}/${path}/adsets`,
      new URLSearchParams({ fields: "id,name,campaign_id,status,effective_status,daily_budget,lifetime_budget,start_time,end_time", limit: "500" }),
      SourceDataKind.META_ADSET, input.deadlineAt, input.accessToken);
    const adsMeta = await this.pages(`${GRAPH}/${path}/ads`,
      new URLSearchParams({ fields: "id,name,campaign_id,adset_id,status,effective_status", limit: "500" }),
      SourceDataKind.META_AD, input.deadlineAt, input.accessToken);
    const campaignMap = uniqueMap(campaigns.rows), adsetMap = uniqueMap(adsetsMeta.rows), adMap = uniqueMap(adsMeta.rows);
    const metadataObservedAt = new Date();
    const seenAds = new Set<string>(), seenAdsets = new Set<string>();
    const ads = adPages.rows.map((raw) => {
      const row = obj(raw), adId = id(row.ad_id), adsetId = id(row.adset_id), campaignId = id(row.campaign_id);
      if (seenAds.has(adId)) fail("RECONCILIATION_FAILED");
      seenAds.add(adId);
      const ad = adMap.get(adId), adset = adsetMap.get(adsetId), campaign = campaignMap.get(campaignId);
      if (!ad || !adset || !campaign || id(ad.adset_id) !== adsetId || id(ad.campaign_id) !== campaignId ||
          id(adset.campaign_id) !== campaignId) fail("RECONCILIATION_FAILED");
      const resultType = resultMap[adId];
      if (resultType && !(resultType === "NONE" || /^[a-z][a-z0-9_.]{1,127}$/.test(resultType)))
        fail("FIELD_UNSUPPORTED");
      this.assertInsightScope(row, input.accountId, input.day, true);
      const expected = settings.expectedAttributionSettingsByDay?.[input.day]?.[adId] ?? settings.expectedAttributionSetting;
      const common = this.common(row, settings, expected);
      const reasons = common.metricUnavailableReasons;
      const action = (field: string, value: number | null, raw: unknown = row.actions) => conditionalAction(field, value, common.attributionSetting, expected, reasons, raw == null ? "UNSUPPORTED_FIELD" : "AMBIGUOUS_ACTION");
      const adName = str(ad.name);
      const currentMetadata = currentMetadataOf(campaign, adset, ad);
      const normalized: MetaApiAd = { ...common, campaignId, campaignName: str(campaign.name),
        adsetId, adsetName: str(adset.name), adId, adName, creative: this.parser.parse(adName),
        sourceRevision: "", deliveryStatus: currentDeliveryStatus(currentMetadata.ad!), currentMetadata,
        adsetBudgetLabel: null, adsetBudgetType: null,
        resultIndicator: !resultType || resultType === "NONE" ? null : resultType,
        resultCount: resultType && resultType !== "NONE" ? action("resultCount", purchaseAction(resultType) ? purchase(row.actions) : countActions(row.actions, resultType)) :
          unavailable("resultCount", resultType === "NONE" ? "NOT_APPLICABLE" : "RESULT_MAPPING_UNVERIFIED", reasons),
        purchaseCount: action("purchaseCount", purchase(row.actions)),
        videoPlay3sCount: action("videoPlay3sCount", countActions(row.actions, "video_view")),
        videoPlay25Count: action("videoPlay25Count", countMetricActions(row.video_p25_watched_actions), row.video_p25_watched_actions),
        videoPlay50Count: action("videoPlay50Count", countMetricActions(row.video_p50_watched_actions), row.video_p50_watched_actions),
        videoPlay75Count: action("videoPlay75Count", countMetricActions(row.video_p75_watched_actions), row.video_p75_watched_actions),
        videoPlay100Count: action("videoPlay100Count", countMetricActions(row.video_p100_watched_actions), row.video_p100_watched_actions),
        addToCartCount: action("addToCartCount", countActions(row.actions, "add_to_cart")) };
      normalized.sourceRevision = fingerprint(normalized);
      normalized.metadataObservedAt = metadataObservedAt;
      return normalized;
    });
    const adsets = adsetPages.rows.map((raw) => {
      const row = obj(raw), adsetId = id(row.adset_id), campaignId = id(row.campaign_id);
      if (seenAdsets.has(adsetId)) fail("RECONCILIATION_FAILED");
      seenAdsets.add(adsetId);
      const adset = adsetMap.get(adsetId), campaign = campaignMap.get(campaignId);
      if (!adset || !campaign || id(adset.campaign_id) !== campaignId) fail("RECONCILIATION_FAILED");
      this.assertInsightScope(row, input.accountId, input.day, true);
      const adRows = ads.filter((ad) => ad.adsetId === adsetId);
      const resultTypes = new Set(adRows.map((ad) => ad.resultIndicator));
      const attributions = new Set(adRows.map((ad) => ad.attributionSetting));
      const expected = attributions.size === 1 && adRows.every((ad) => !ad.metricUnavailableReasons.purchaseCount)
        ? adRows[0]?.attributionSetting ?? undefined : undefined;
      const common = this.common(row, settings, expected);
      const reasons = common.metricUnavailableReasons;
      const resultType = resultTypes.size === 1 ? adRows[0]?.resultIndicator : null;
      let resultCount: number | null = null;
      const adResultCount = sumComplete(adRows.map((ad) => ad.resultCount));
      if (attributions.size > 1) unavailable("resultCount", "MIXED_ATTRIBUTION", reasons);
      else if (resultTypes.size > 1) unavailable("resultCount", "MIXED_RESULT", reasons);
      else if (resultType && adResultCount !== null) {
        resultCount = conditionalAction("resultCount", purchaseAction(resultType) ? purchase(row.actions) : countActions(row.actions, resultType),
          common.attributionSetting, expected, reasons);
        if (resultCount !== null && resultCount !== adResultCount) fail("RECONCILIATION_FAILED");
      } else unavailable("resultCount", adRows.length > 0 && adRows.every((ad) => ad.metricUnavailableReasons.resultCount === "NOT_APPLICABLE")
        ? "NOT_APPLICABLE" : "RESULT_MAPPING_UNVERIFIED", reasons);
      const currentMetadata = currentMetadataOf(campaign, adset, null);
      const normalized: MetaApiAdset = { ...common,
        campaignId, campaignName: str(campaign.name), adsetId, adsetName: str(adset.name),
        sourceRevision: "", deliveryStatus: currentDeliveryStatus(currentMetadata.adset), currentMetadata,
        adsetBudgetLabel: null, adsetBudgetType: null,
        resultIndicator: resultType ?? null, resultCount,
        startDate: null, endStatus: null };
      normalized.sourceRevision = fingerprint(normalized);
      normalized.metadataObservedAt = metadataObservedAt;
      return normalized;
    });
    const accountRow = accountPages.rows[0] ? obj(accountPages.rows[0]) : null;
    if (accountRow) this.assertInsightScope(accountRow, input.accountId, input.day, true);
    if (!accountRow && (adPages.rows.length || adsetPages.rows.length)) fail("RECONCILIATION_FAILED");
    const comparableAttribution = accountRow?.attribution_setting != null &&
      ads.every((ad) => ad.attributionSetting === accountRow.attribution_setting &&
        !["ATTRIBUTION_UNVERIFIED", "ATTRIBUTION_MISMATCH"].includes(ad.metricUnavailableReasons.purchaseCount ?? "")) &&
      adsets.every((adset) => adset.attributionSetting === accountRow.attribution_setting);
    if (accountRow && comparableAttribution) {
      // Conditional metrics reconcile only when every level actually supplies them.
      // Missing arrays remain unknown and do not invalidate complete base measurements.
      const rawAds = adPages.rows.map(obj), rawAdsets = adsetPages.rows.map(obj);
      const actionTypes = new Set(["add_to_cart", "video_view",
        ...Object.values(resultMap).filter((value) => value !== "NONE" && value !== "purchase" && value !== "offsite_conversion.fb_pixel_purchase")]);
      const accountPurchase = purchase(accountRow.actions);
      const adPurchase = sumComplete(rawAds.map((row) => purchase(row.actions)));
      const adsetPurchase = sumComplete(rawAdsets.map((row) => purchase(row.actions)));
      if (accountPurchase !== null && adPurchase !== null && adsetPurchase !== null &&
          (accountPurchase !== adPurchase || accountPurchase !== adsetPurchase)) fail("RECONCILIATION_FAILED");
      for (const actionType of actionTypes) {
        const expected = countActions(accountRow.actions, actionType);
        const adTotal = sumComplete(rawAds.map((row) => countActions(row.actions, actionType)));
        const adsetTotal = sumComplete(rawAdsets.map((row) => countActions(row.actions, actionType)));
        if (expected !== null && adTotal !== null && adsetTotal !== null &&
            (expected !== adTotal || expected !== adsetTotal)) fail("RECONCILIATION_FAILED");
      }
      for (const field of ["video_p25_watched_actions", "video_p50_watched_actions",
        "video_p75_watched_actions", "video_p100_watched_actions"] as const) {
        const expected = countMetricActions(accountRow[field]);
        const adTotal = sumComplete(rawAds.map((row) => countMetricActions(row[field])));
        const adsetTotal = sumComplete(rawAdsets.map((row) => countMetricActions(row[field])));
        if (expected !== null && adTotal !== null && adsetTotal !== null &&
            (expected !== adTotal || expected !== adsetTotal)) fail("RECONCILIATION_FAILED");
      }
    }
    const accountSpend = new Prisma.Decimal(decimal(accountRow?.spend, 4));
    const adSpend = ads.reduce((sum, row) => sum.plus(row.spendUsd), new Prisma.Decimal(0));
    const adsetSpend = adsets.reduce((sum, row) => sum.plus(row.spendUsd), new Prisma.Decimal(0));
    const accountImpressions = BigInt(int64(accountRow?.impressions));
    const adImpressions = ads.reduce((sum, row) => sum + BigInt(row.impressions), 0n);
    const adsetImpressions = adsets.reduce((sum, row) => sum + BigInt(row.impressions), 0n);
    const accountLinkClicks = integer(accountRow?.inline_link_clicks);
    const adLinkClicks = ads.reduce((sum, row) => sum + row.inlineLinkClicks, 0);
    const adsetLinkClicks = adsets.reduce((sum, row) => sum + row.inlineLinkClicks, 0);
    if (!accountSpend.eq(adSpend) || !adSpend.eq(adsetSpend) ||
        accountImpressions !== adImpressions || adImpressions !== adsetImpressions ||
        accountLinkClicks !== adLinkClicks || adLinkClicks !== adsetLinkClicks ||
        ads.some((row) => !seenAdsets.has(row.adsetId))) fail("RECONCILIATION_FAILED");
    return { ads, adsets, pageCount: adPages.pageCount + adsetPages.pageCount + accountPages.pageCount +
      campaigns.pageCount + adsetsMeta.pageCount + adsMeta.pageCount,
      accountSpendUsd: accountSpend.toFixed(4), currencyCode, timeZone, requestId: null, settings };
  }

  private assertInsightScope(row: Json, accountId: string, day: string, requireBaseMeasures = false) {
    if (id(row.account_id) !== accountId || row.date_start !== day || row.date_stop !== day)
      fail("ACCOUNT_SCOPE_MISMATCH");
    if (requireBaseMeasures && ["spend", "impressions", "inline_link_clicks"].some((field) => row[field] == null))
      fail("FIELD_UNSUPPORTED");
  }

  private common(row: Json, settings: MetaReadSettings, expected?: string) {
    const metricUnavailableReasons: MetaUnavailableReasons = {};
    const attributionSetting = row.attribution_setting == null ? null : str(row.attribution_setting, 128);
    const spendUsd = decimal(row.spend, 4);
    const impressions = int64(row.impressions);
    const inlineLinkClicks = integer(row.inline_link_clicks);
    return { spendUsd, impressions, inlineLinkClicks,
      reach: integer(row.reach), frequency: optionalDecimal(row.frequency, 6),
      attributionSetting, actionReportTime: settings.actionReportTime,
      // Requested windows; unified attribution may use each adset's setting instead.
      attributionWindows: [...settings.attributionWindows], metricUnavailableReasons,
      // The user excluded shop clicks from the collection scope on 2026-10-08.
      shopClicks: unavailable("shopClicks", "NOT_APPLICABLE", metricUnavailableReasons),
      clicksAll: integer(row.clicks),
      landingPageViews: conditionalAction("landingPageViews", countActions(row.actions, "landing_page_view"),
        attributionSetting, expected, metricUnavailableReasons),
      cpmUsd: optionalDecimal(row.cpm, 4), cpcLinkUsd: optionalDecimal(row.cost_per_inline_link_click, 4),
      ctrLinkPct: optionalDecimal(row.inline_link_click_ctr, 6),
      ctrAllPct: optionalDecimal(row.ctr, 6), cpcAllUsd: optionalDecimal(row.cpc, 4) };
  }

  private async pages(url: string, query: URLSearchParams, kind: SourceDataKind,
    deadlineAt: number, accessToken: string | null, extra: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(extra)) query.set(key, value);
    return collectBoundedPages(kind, async (cursor) => {
      const params = new URLSearchParams(query);
      if (cursor) params.set("after", cursor);
      const body = obj(await this.get(url, params, deadlineAt, accessToken)) as GraphPage;
      if (!Array.isArray(body.data)) fail();
      const after = body.paging?.cursors?.after;
      const next = after === undefined ? null : str(after, 512);
      // Graph cursors alone are not proof of another page. The next link must
      // exist and stay on the same edge; never request a provider supplied URL.
      const nextUrl = body.paging && "next" in body.paging ? (body.paging as { next?: unknown }).next : null;
      if (nextUrl && (!next || typeof nextUrl !== "string" ||
          !nextUrl.startsWith(`${url}?`))) fail("PARTIAL_PAGE");
      return { rows: body.data, nextCursor: nextUrl ? next : null,
        bytes: Buffer.byteLength(JSON.stringify(body)) };
    }, { maxPageBytes: PAGE_BYTES, maxUnitBytes: 16 * 1024 * 1024 });
  }

  private async get(url: string, params: URLSearchParams, deadlineAt: number,
    accessToken: string | null): Promise<unknown> {
    return boundedProviderRequest(async (signal) => {
      let token: string | null = accessToken;
      if (token === null) {
        try { token = await this.token.getAccessToken(); }
        catch { throw new ProviderFailure("PROVIDER_AUTH_REQUIRED", false); }
      }
      if (!token) throw new ProviderFailure("PROVIDER_AUTH_REQUIRED", false);
      let response: Response;
      try { response = await this.request(`${url}?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` }, signal
      }); } catch { throw new ProviderFailure("PROVIDER_UNAVAILABLE", true); }
      if (!response.body) throw new ProviderFailure("PARTIAL_PAGE", false);
      const reader = response.body.getReader();
      const chunks: Buffer[] = [];
      let length = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          length += part.value.byteLength;
          if (length > PAGE_BYTES) throw new ProviderFailure("RUN_LIMIT_EXCEEDED", false);
          chunks.push(Buffer.from(part.value));
        }
      } finally { reader.releaseLock(); }
      let body: unknown;
      try { body = JSON.parse(Buffer.concat(chunks, length).toString("utf8")); }
      catch { throw new ProviderFailure("FIELD_UNSUPPORTED", false); }
      if (!response.ok) {
        const error = body && typeof body === "object" && "error" in body ?
          (body as { error?: unknown }).error : null;
        const code = error && typeof error === "object" && "code" in error ?
          (error as { code?: unknown }).code : null;
        const safe = response.status === 401 || response.status === 403 || code === 190
          ? "PROVIDER_AUTH_REQUIRED" : response.status === 429 || code === 17 || code === 32
            ? "PROVIDER_RATE_LIMITED" : response.status === 400 ? "FIELD_UNSUPPORTED" : "PROVIDER_UNAVAILABLE";
        throw new ProviderFailure(safe, safe === "PROVIDER_RATE_LIMITED" || response.status >= 500,
          retryAfterMs(response.headers.get("retry-after")));
      }
      return body;
    }, deadlineAt);
  }
}

function uniqueMap(rows: unknown[]) {
  const map = new Map<string, Json>();
  for (const raw of rows) {
    const row = obj(raw), key = id(row.id);
    if (map.has(key)) fail("RECONCILIATION_FAILED");
    map.set(key, row);
  }
  return map;
}
function currentMetadataOf(campaign: Json, adset: Json, ad: Json | null): MetaCurrentMetadata {
  const asset = (row: Json, campaignLevel = false): MetaCurrentAsset => ({
    status: row.status == null ? null : str(row.status, 64),
    effectiveStatus: row.effective_status == null ? null : str(row.effective_status, 64),
    dailyBudgetRaw: row.daily_budget == null ? null : str(row.daily_budget, 30),
    lifetimeBudgetRaw: row.lifetime_budget == null ? null : str(row.lifetime_budget, 30),
    startTime: row.start_time == null ? null : str(row.start_time, 40),
    endTime: (campaignLevel ? row.stop_time : row.end_time) == null ? null : str(campaignLevel ? row.stop_time : row.end_time, 40)
  });
  const result: MetaCurrentMetadata = { scope: "CURRENT_ACCESSIBLE_ASSETS", currencyCode: "USD",
    budgetUnit: "UNVERIFIED", campaign: asset(campaign, true), adset: asset(adset), ad: ad ? asset(ad) : null };
  if (!validCurrentMetadata(result)) fail("FIELD_UNSUPPORTED");
  for (const value of [result.campaign, result.adset, result.ad]) {
    for (const timestamp of [value?.startTime, value?.endTime]) {
      if (timestamp) parseIsoDate(timestamp.slice(0, 10));
    }
  }
  return result;
}
function purchase(actions: unknown): number | null {
  if (actions === undefined || actions === null) return null;
  if (!Array.isArray(actions)) fail();
  const rows = actionRows(actions);
  const preferred = rows.filter((row) => row.action_type === "purchase");
  const alias = rows.filter((row) => row.action_type === "offsite_conversion.fb_pixel_purchase");
  if (preferred.length > 1 || alias.length > 1) fail("RECONCILIATION_FAILED");
  const first = preferred.length ? integer(preferred[0].value) : null;
  const second = alias.length ? integer(alias[0].value) : null;
  if (first !== null && second !== null && first !== second) return null;
  return first ?? second ?? 0;
}

function unavailable(field: string, reason: MetaUnavailableReasons[string], reasons: MetaUnavailableReasons): null {
  reasons[field] = reason;
  return null;
}
function conditionalAction(field: string, value: number | null, attribution: string | null,
  expected: string | undefined, reasons: MetaUnavailableReasons, missingReason: MetaUnavailableReasons[string] = "UNSUPPORTED_FIELD"): number | null {
  if (!attribution || !expected) return unavailable(field, "ATTRIBUTION_UNVERIFIED", reasons);
  if (attribution !== expected) return unavailable(field, "ATTRIBUTION_MISMATCH", reasons);
  if (value === null) return unavailable(field, missingReason, reasons);
  return value;
}

function purchaseAction(actionType: string) {
  return actionType === "purchase" || actionType === "offsite_conversion.fb_pixel_purchase";
}

function actionRows(values: unknown[]): Json[] {
  return values.map((value) => {
    const row = obj(value);
    str(row.action_type, 128);
    if (row.value == null) fail("FIELD_UNSUPPORTED");
    integer(row.value);
    return row;
  });
}
