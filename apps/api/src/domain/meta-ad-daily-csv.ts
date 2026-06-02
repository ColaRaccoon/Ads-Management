import { parse } from "csv-parse/sync";
import { createHash } from "node:crypto";
import { ParseIssue, parseDateString, parseNumberValue, toDateOnly } from "./date-number";

export const META_AD_DAILY_SCHEMA_VERSION = "meta_ad_daily_v1";

export const META_AD_DAILY_CSV_COLUMNS = [
  "보고 시작",
  "보고 종료",
  "광고 이름",
  "광고 게재",
  "기여 설정",
  "결과",
  "결과 표시 도구",
  "도달",
  "빈도",
  "결과당 비용",
  "광고 세트 예산",
  "광고 세트 예산 유형",
  "지출 금액 (USD)",
  "종료",
  "품질 순위",
  "참여율 순위",
  "전환율 순위",
  "노출",
  "CPM(1,000회 노출당 비용) (USD)",
  "링크 클릭",
  "shop_clicks",
  "CPC(링크 클릭당 비용) (USD)",
  "CTR(링크 클릭률)",
  "클릭(전체)",
  "CTR(전체)",
  "CPC(전체) (USD)",
  "랜딩 페이지 조회",
  "랜딩 페이지 조회당 비용 (USD)",
  "광고 세트 이름",
  "캠페인 이름",
  "광고 세트 ID",
  "캠페인 ID"
] as const;

export const META_AD_DAILY_CSV_COLUMN_MAPPINGS = [
  { csvColumn: "보고 시작", fieldName: "date_start", requirement: "required" },
  { csvColumn: "보고 종료", fieldName: "date_end", requirement: "required" },
  { csvColumn: "광고 이름", fieldName: "ad_name", requirement: "required" },
  { csvColumn: "광고 게재", fieldName: "ad_delivery_status", requirement: "required" },
  { csvColumn: "기여 설정", fieldName: "attribution_setting", requirement: "recommended" },
  { csvColumn: "결과", fieldName: "result_count", requirement: "recommended" },
  { csvColumn: "결과 표시 도구", fieldName: "result_indicator", requirement: "recommended" },
  { csvColumn: "도달", fieldName: "reach", requirement: "recommended" },
  { csvColumn: "빈도", fieldName: "frequency", requirement: "recommended" },
  { csvColumn: "결과당 비용", fieldName: "cost_per_result_usd", requirement: "recommended" },
  { csvColumn: "광고 세트 예산", fieldName: "adset_budget", requirement: "optional" },
  { csvColumn: "광고 세트 예산 유형", fieldName: "adset_budget_type", requirement: "optional" },
  { csvColumn: "지출 금액 (USD)", fieldName: "spend_usd", requirement: "required" },
  { csvColumn: "종료", fieldName: "end_status", requirement: "optional" },
  { csvColumn: "품질 순위", fieldName: "quality_ranking", requirement: "optional" },
  { csvColumn: "참여율 순위", fieldName: "engagement_rate_ranking", requirement: "optional" },
  { csvColumn: "전환율 순위", fieldName: "conversion_rate_ranking", requirement: "optional" },
  { csvColumn: "노출", fieldName: "impressions", requirement: "required" },
  { csvColumn: "CPM(1,000회 노출당 비용) (USD)", fieldName: "cpm_usd", requirement: "recommended" },
  { csvColumn: "링크 클릭", fieldName: "link_clicks", requirement: "recommended" },
  { csvColumn: "shop_clicks", fieldName: "shop_clicks", requirement: "optional" },
  { csvColumn: "CPC(링크 클릭당 비용) (USD)", fieldName: "cpc_link_usd", requirement: "recommended" },
  { csvColumn: "CTR(링크 클릭률)", fieldName: "ctr_link", requirement: "recommended" },
  { csvColumn: "클릭(전체)", fieldName: "clicks_all", requirement: "recommended" },
  { csvColumn: "CTR(전체)", fieldName: "ctr_all", requirement: "recommended" },
  { csvColumn: "CPC(전체) (USD)", fieldName: "cpc_all_usd", requirement: "recommended" },
  { csvColumn: "랜딩 페이지 조회", fieldName: "landing_page_views", requirement: "recommended" },
  { csvColumn: "랜딩 페이지 조회당 비용 (USD)", fieldName: "cost_per_lpv_usd", requirement: "recommended" },
  { csvColumn: "광고 세트 이름", fieldName: "adset_name", requirement: "required" },
  { csvColumn: "캠페인 이름", fieldName: "campaign_name", requirement: "required" },
  { csvColumn: "광고 세트 ID", fieldName: "meta_adset_id", requirement: "required" },
  { csvColumn: "캠페인 ID", fieldName: "meta_campaign_id", requirement: "required" },
  { csvColumn: "광고 ID", fieldName: "meta_ad_id", requirement: "optional" }
] as const;

export const META_AD_DAILY_REQUIRED_COLUMNS = [
  "보고 시작",
  "보고 종료",
  "캠페인 이름",
  "캠페인 ID",
  "광고 세트 이름",
  "광고 세트 ID",
  "광고 이름",
  "광고 게재",
  "지출 금액 (USD)",
  "노출"
] as const;

export const META_AD_DAILY_RECOMMENDED_COLUMNS = [
  "결과",
  "결과 표시 도구",
  "링크 클릭",
  "랜딩 페이지 조회",
  "CPC(링크 클릭당 비용) (USD)",
  "CTR(링크 클릭률)"
] as const;

export const META_AD_DAILY_OPTIONAL_COLUMNS = ["광고 ID"] as const;

export type ParsedMetaAdDailyRow = {
  dateStart: Date;
  dateEnd: Date;
  metricDate: Date;
  campaignName: string;
  metaCampaignId: string;
  adsetName: string;
  metaAdsetExternalId: string;
  adName: string;
  metaAdId: string | null;
  syntheticAdKey: string;
  adIdentityKey: string;
  adDeliveryStatus: string | null;
  attributionSetting: string | null;
  resultCount: number;
  resultIndicator: string | null;
  purchaseCount: number;
  reach: number;
  frequency: number | null;
  costPerResultUsd: number | null;
  adsetBudgetLabel: string | null;
  adsetBudgetType: string | null;
  spendUsd: number;
  endStatus: string | null;
  qualityRanking: string | null;
  engagementRateRanking: string | null;
  conversionRateRanking: string | null;
  impressions: number;
  cpmUsd: number | null;
  linkClicks: number;
  shopClicks: number;
  cpcLinkUsd: number | null;
  ctrLinkPct: number | null;
  clicksAll: number;
  ctrAllPct: number | null;
  cpcAllUsd: number | null;
  landingPageViews: number;
  costPerLandingPageViewUsd: number | null;
};

export type MetaAdDailyPreviewSummary = {
  schemaVersion: string;
  rowCount: number;
  columnCount: number;
  missingRequiredColumns: string[];
  warnings: string[];
  campaignCount: number;
  adsetCount: number;
  adCount: number;
  uniqueAdNameCount: number;
  dailyAdKeyCount: number;
  duplicateKeys: string[];
  totalSpendUsd: number;
  totalPurchases: number;
  sampleRows: ParsedMetaAdDailyRow[];
};

export class MetaAdDailyCsvValidator {
  static validate(headers: string[]): { valid: boolean; missingColumns: string[]; warnings: string[] } {
    const headerSet = normalizedHeaderSet(headers);
    const missingColumns = META_AD_DAILY_REQUIRED_COLUMNS.filter((column) => !headerSet.has(column));
    const warnings = META_AD_DAILY_RECOMMENDED_COLUMNS.filter((column) => !headerSet.has(column)).map(
      (column) => `권장 컬럼이 없습니다: ${column}`
    );

    if (!headerSet.has("광고 ID")) {
      warnings.push(
        "광고 ID가 없어 campaign_id + adset_id + ad_name 조합으로 광고를 식별합니다. Meta 다운로드 설정에서 광고 ID 컬럼 추가를 권장합니다."
      );
    }

    return { valid: missingColumns.length === 0, missingColumns, warnings };
  }
}

export class MetaAdDailyCsvParser {
  parseBuffer(buffer: Buffer): { headers: string[]; rows: Record<string, string>[] } {
    return this.parseDecodedText(this.decodeCsvText(buffer));
  }

  parseRow(rawRow: Record<string, string>): { parsedRow: ParsedMetaAdDailyRow | null; issues: ParseIssue[] } {
    const issues: ParseIssue[] = [];
    const dateStart = this.requiredDate(rawRow, "보고 시작", issues);
    const dateEnd = this.requiredDate(rawRow, "보고 종료", issues);
    const campaignName = this.requiredText(rawRow, "캠페인 이름", issues);
    const metaCampaignId = this.requiredText(rawRow, "캠페인 ID", issues);
    const adsetName = this.requiredText(rawRow, "광고 세트 이름", issues);
    const metaAdsetExternalId = this.requiredText(rawRow, "광고 세트 ID", issues);
    const adName = this.requiredText(rawRow, "광고 이름", issues);
    const metaAdId = textValue(rawRow["광고 ID"]);

    const resultCount = this.count(rawRow, "결과", issues);
    const reach = this.count(rawRow, "도달", issues);
    const impressions = this.count(rawRow, "노출", issues);
    const linkClicks = this.count(rawRow, "링크 클릭", issues);
    const shopClicks = this.count(rawRow, "shop_clicks", issues);
    const clicksAll = this.count(rawRow, "클릭(전체)", issues);
    const landingPageViews = this.count(rawRow, "랜딩 페이지 조회", issues);
    const spendUsd = this.count(rawRow, "지출 금액 (USD)", issues, true);
    const resultIndicator = textValue(rawRow["결과 표시 도구"]);

    const parsedRow =
      dateStart && dateEnd && campaignName && metaCampaignId && adsetName && metaAdsetExternalId && adName
        ? {
            dateStart,
            dateEnd,
            metricDate: dateStart,
            campaignName,
            metaCampaignId,
            adsetName,
            metaAdsetExternalId,
            adName,
            metaAdId,
            syntheticAdKey: syntheticAdKey(metaCampaignId, metaAdsetExternalId, adName),
            adIdentityKey: metaAdId ?? syntheticAdKey(metaCampaignId, metaAdsetExternalId, adName),
            adDeliveryStatus: textValue(rawRow["광고 게재"]),
            attributionSetting: textValue(rawRow["기여 설정"]),
            resultCount,
            resultIndicator,
            purchaseCount: isPurchaseResult(resultIndicator) ? resultCount : 0,
            reach,
            frequency: this.optionalNumber(rawRow, "빈도", issues),
            costPerResultUsd: this.optionalNumber(rawRow, "결과당 비용", issues),
            adsetBudgetLabel: textValue(rawRow["광고 세트 예산"]),
            adsetBudgetType: textValue(rawRow["광고 세트 예산 유형"]),
            spendUsd,
            endStatus: textValue(rawRow["종료"]),
            qualityRanking: textValue(rawRow["품질 순위"]),
            engagementRateRanking: textValue(rawRow["참여율 순위"]),
            conversionRateRanking: textValue(rawRow["전환율 순위"]),
            impressions,
            cpmUsd: this.optionalNumber(rawRow, "CPM(1,000회 노출당 비용) (USD)", issues),
            linkClicks,
            shopClicks,
            cpcLinkUsd: this.optionalNumber(rawRow, "CPC(링크 클릭당 비용) (USD)", issues),
            ctrLinkPct: this.optionalNumber(rawRow, "CTR(링크 클릭률)", issues),
            clicksAll,
            ctrAllPct: this.optionalNumber(rawRow, "CTR(전체)", issues),
            cpcAllUsd: this.optionalNumber(rawRow, "CPC(전체) (USD)", issues),
            landingPageViews,
            costPerLandingPageViewUsd: this.optionalNumber(rawRow, "랜딩 페이지 조회당 비용 (USD)", issues)
          }
        : null;

    return { parsedRow, issues };
  }

  preview(buffer: Buffer): MetaAdDailyPreviewSummary {
    const { headers, rows } = this.parseBuffer(buffer);
    const headerValidation = MetaAdDailyCsvValidator.validate(headers);
    const parsedRows = rows.map((rawRow) => this.parseRow(rawRow));
    const validRows = parsedRows.map((row) => row.parsedRow).filter((row): row is ParsedMetaAdDailyRow => Boolean(row));
    const dailyKeys = validRows.map((row) => dailyAdMetricKey(row));
    const duplicateKeys = duplicates(dailyKeys);

    return {
      schemaVersion: META_AD_DAILY_SCHEMA_VERSION,
      rowCount: rows.length,
      columnCount: headers.length,
      missingRequiredColumns: headerValidation.missingColumns,
      warnings: [...headerValidation.warnings, ...duplicateKeys.map((key) => `중복 광고 일별 키가 있습니다: ${key}`)],
      campaignCount: new Set(validRows.map((row) => row.metaCampaignId)).size,
      adsetCount: new Set(validRows.map((row) => `${row.metaCampaignId}:${row.metaAdsetExternalId}`)).size,
      adCount: new Set(validRows.map((row) => `${row.metaCampaignId}:${row.metaAdsetExternalId}:${row.adIdentityKey}`)).size,
      uniqueAdNameCount: new Set(validRows.map((row) => row.adName)).size,
      dailyAdKeyCount: new Set(dailyKeys).size,
      duplicateKeys,
      totalSpendUsd: round2(validRows.reduce((sum, row) => sum + row.spendUsd, 0)),
      totalPurchases: validRows.reduce((sum, row) => sum + row.purchaseCount, 0),
      sampleRows: validRows.slice(0, 5)
    };
  }

  private parseDecodedText(text: string): { headers: string[]; rows: Record<string, string>[] } {
    const rows = parse(text, {
      bom: true,
      columns: true,
      skip_empty_lines: true,
      trim: false
    }) as Record<string, string>[];

    const headers = rows.length > 0 ? Object.keys(rows[0]) : this.parseHeadersOnlyText(text);
    return { headers: headers.map((header) => header.replace(/^\uFEFF/, "")), rows };
  }

  private parseHeadersOnlyText(text: string): string[] {
    const records = parse(text, {
      bom: true,
      to_line: 1,
      relax_column_count: true
    }) as string[][];
    return (records[0] ?? []).map((header) => header.replace(/^\uFEFF/, ""));
  }

  private decodeCsvText(buffer: Buffer): string {
    const candidates = [
      new TextDecoder("utf-8").decode(buffer),
      new TextDecoder("euc-kr").decode(buffer)
    ];
    let bestText = candidates[0];
    let bestScore = -1;
    for (const text of candidates) {
      try {
        const headers = this.parseDecodedText(text).headers;
        const score = headerMatchScore(headers);
        if (score > bestScore) {
          bestText = text;
          bestScore = score;
        }
      } catch {
        // Keep the default UTF-8 path if a fallback candidate cannot be parsed.
      }
    }
    return bestText;
  }

  private requiredDate(rawRow: Record<string, string>, columnName: string, issues: ParseIssue[]): Date | null {
    const rawValue = rawRow[columnName];
    const date = toDateOnly(rawValue);
    if (!date) {
      issues.push({
        columnName,
        errorCode: "INVALID_DATE",
        message: `${columnName} 날짜 형식이 올바르지 않습니다.`,
        rawValue
      });
    }
    return date;
  }

  private requiredText(rawRow: Record<string, string>, columnName: string, issues: ParseIssue[]): string | null {
    const value = textValue(rawRow[columnName]);
    if (!value) {
      issues.push({
        columnName,
        errorCode: "REQUIRED",
        message: `${columnName}은 필수입니다.`,
        rawValue: rawRow[columnName]
      });
    }
    return value;
  }

  private count(rawRow: Record<string, string>, columnName: string, issues: ParseIssue[], allowFraction = false): number {
    const parsed = parseNumberValue(rawRow[columnName], { emptyAs: 0 });
    if (parsed === null) {
      issues.push({
        columnName,
        errorCode: "INVALID_NUMBER",
        message: `${columnName} 숫자 형식이 올바르지 않습니다.`,
        rawValue: rawRow[columnName]
      });
      return 0;
    }
    if (parsed < 0) {
      issues.push({
        columnName,
        errorCode: "NEGATIVE_NUMBER",
        message: `${columnName}은 음수일 수 없습니다.`,
        rawValue: rawRow[columnName]
      });
      return 0;
    }
    return allowFraction ? parsed : Math.trunc(parsed);
  }

  private optionalNumber(rawRow: Record<string, string>, columnName: string, issues: ParseIssue[]): number | null {
    const parsed = parseNumberValue(rawRow[columnName], { emptyAs: null });
    if (parsed === null && textValue(rawRow[columnName])) {
      issues.push({
        columnName,
        errorCode: "INVALID_NUMBER",
        message: `${columnName} 숫자 형식이 올바르지 않습니다.`,
        rawValue: rawRow[columnName]
      });
    }
    if (parsed !== null && parsed < 0) {
      issues.push({
        columnName,
        errorCode: "NEGATIVE_NUMBER",
        message: `${columnName}은 음수일 수 없습니다.`,
        rawValue: rawRow[columnName]
      });
      return null;
    }
    return parsed;
  }
}

export function syntheticAdKey(metaCampaignId: string, metaAdsetId: string, adName: string) {
  return createHash("sha1").update(`${metaCampaignId}|${metaAdsetId}|${adName}`).digest("hex");
}

export function dailyAdMetricKey(row: ParsedMetaAdDailyRow) {
  return `${formatAdDate(row.dateStart)}:${row.metaCampaignId}:${row.metaAdsetExternalId}:${row.adIdentityKey}`;
}

export function isPurchaseResult(resultIndicator: string | null) {
  if (!resultIndicator) {
    return false;
  }
  const normalized = resultIndicator.toLowerCase();
  return normalized.includes("purchase") || normalized.includes("구매");
}

function textValue(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizedHeaderSet(headers: string[]) {
  return new Set(headers.map((header) => header.replace(/^\uFEFF/, "").trim()));
}

function headerMatchScore(headers: string[]) {
  const headerSet = normalizedHeaderSet(headers);
  return META_AD_DAILY_REQUIRED_COLUMNS.filter((column) => headerSet.has(column)).length;
}

function duplicates(values: string[]) {
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      duplicated.add(value);
    }
    seen.add(value);
  }
  return Array.from(duplicated);
}

function formatAdDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function round2(value: number) {
  return Math.round(value * 100) / 100;
}
