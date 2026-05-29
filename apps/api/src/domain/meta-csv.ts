import { parse } from "csv-parse/sync";
import { createHash } from "node:crypto";
import { AdsetNameNormalizer } from "./adset-name-normalizer";
import { ParseIssue, parseDateString, parseNumberValue, toDateOnly } from "./date-number";

export const META_ADSET_REQUIRED_COLUMNS = [
  "보고 시작",
  "보고 종료",
  "광고 세트 이름",
  "광고 세트 게재",
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
  "시작",
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
  "랜딩 페이지 조회당 비용 (USD)"
] as const;

export type MetaCsvColumn = (typeof META_ADSET_REQUIRED_COLUMNS)[number];

export type ParsedMetaAdsetRow = {
  dateStart: Date;
  dateEnd: Date;
  metricDate: Date;
  adsetName: string;
  adsetNameKey: string;
  deliveryStatus: string | null;
  attributionSetting: string | null;
  resultCount: number;
  resultIndicator: string | null;
  reach: number;
  frequency: number | null;
  costPerResultUsd: number | null;
  adsetBudgetLabel: string | null;
  adsetBudgetType: string | null;
  spendUsd: number;
  endStatus: string | null;
  startDate: Date | null;
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

export class CsvHeaderValidator {
  static validate(headers: string[]): { valid: boolean; missingColumns: string[] } {
    const headerSet = new Set(headers.map((header) => header.replace(/^\uFEFF/, "").trim()));
    const missingColumns = META_ADSET_REQUIRED_COLUMNS.filter((column) => !headerSet.has(column));
    return { valid: missingColumns.length === 0, missingColumns };
  }
}

export class MetaCsvParser {
  parseBuffer(buffer: Buffer): { headers: string[]; rows: Record<string, string>[] } {
    return this.parseDecodedText(this.decodeCsvText(buffer));
  }

  parseHeadersOnly(buffer: Buffer): string[] {
    return this.parseHeadersOnlyText(this.decodeCsvText(buffer));
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

  parseRow(rawRow: Record<string, string>): { parsedRow: ParsedMetaAdsetRow | null; issues: ParseIssue[] } {
    const issues: ParseIssue[] = [];
    const dateStart = this.requiredDate(rawRow, "보고 시작", issues);
    const dateEnd = this.requiredDate(rawRow, "보고 종료", issues);
    const startDate = this.optionalDate(rawRow, "시작", issues);
    const adsetName = textValue(rawRow["광고 세트 이름"]);

    if (!adsetName) {
      issues.push({
        columnName: "광고 세트 이름",
        errorCode: "REQUIRED",
        message: "광고 세트 이름은 필수입니다.",
        rawValue: rawRow["광고 세트 이름"]
      });
    }

    const resultCount = this.count(rawRow, "결과", issues);
    const reach = this.count(rawRow, "도달", issues);
    const impressions = this.count(rawRow, "노출", issues);
    const linkClicks = this.count(rawRow, "링크 클릭", issues);
    const shopClicks = this.count(rawRow, "shop_clicks", issues);
    const clicksAll = this.count(rawRow, "클릭(전체)", issues);
    const landingPageViews = this.count(rawRow, "랜딩 페이지 조회", issues);
    const spendUsd = this.count(rawRow, "지출 금액 (USD)", issues, true);

    const parsedRow =
      dateStart && dateEnd && adsetName
        ? {
            dateStart,
            dateEnd,
            metricDate: dateStart,
            adsetName: AdsetNameNormalizer.normalizeName(adsetName),
            adsetNameKey: AdsetNameNormalizer.toKey(adsetName),
            deliveryStatus: textValue(rawRow["광고 세트 게재"]),
            attributionSetting: textValue(rawRow["기여 설정"]),
            resultCount,
            resultIndicator: textValue(rawRow["결과 표시 도구"]),
            reach,
            frequency: this.optionalNumber(rawRow, "빈도", issues),
            costPerResultUsd: this.optionalNumber(rawRow, "결과당 비용", issues),
            adsetBudgetLabel: textValue(rawRow["광고 세트 예산"]),
            adsetBudgetType: textValue(rawRow["광고 세트 예산 유형"]),
            spendUsd,
            endStatus: textValue(rawRow["종료"]),
            startDate,
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

  private optionalDate(rawRow: Record<string, string>, columnName: string, issues: ParseIssue[]): Date | null {
    const rawValue = rawRow[columnName];
    if (!textValue(rawValue)) {
      return null;
    }
    const parsed = parseDateString(rawValue);
    if (!parsed) {
      issues.push({
        columnName,
        errorCode: "INVALID_DATE",
        message: `${columnName} 날짜 형식이 올바르지 않습니다.`,
        rawValue
      });
      return null;
    }
    return toDateOnly(parsed);
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
    return parsed;
  }
}

export function hashRecord(record: unknown): string {
  return createHash("sha256").update(JSON.stringify(record)).digest("hex");
}

function textValue(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function headerMatchScore(headers: string[]) {
  const headerSet = new Set(headers.map((header) => header.replace(/^\uFEFF/, "").trim()));
  return META_ADSET_REQUIRED_COLUMNS.filter((column) => headerSet.has(column)).length;
}
