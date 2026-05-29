import { safeDivide } from "./date-number";

export type PeriodMetricRow = {
  metricDate: string;
  spendUsd: number;
  resultCount: number;
  impressions: number;
  linkClicks: number;
  clicksAll: number;
  landingPageViews: number;
  revenueKrw?: number | null;
  marginKrw?: number | null;
  spendKrw?: number | null;
};

export type PeriodMetricResult = {
  spendUsd: number;
  spendKrw: number;
  purchaseCount: number;
  impressions: number;
  linkClicks: number;
  clicksAll: number;
  landingPageViews: number;
  revenueKrw: number;
  marginKrw: number;
  cpaUsd: number | null;
  cpaKrw: number | null;
  ctrLinkPct: number | null;
  ctrAllPct: number | null;
  cpcLinkUsd: number | null;
  cpcAllUsd: number | null;
  roas: number | null;
  dataDays: number;
};

export class PeriodMetricCalculator {
  calculate(rows: PeriodMetricRow[]): PeriodMetricResult {
    const totals = rows.reduce(
      (acc, row) => {
        acc.spendUsd += row.spendUsd;
        acc.spendKrw += row.spendKrw ?? 0;
        acc.purchaseCount += row.resultCount;
        acc.impressions += row.impressions;
        acc.linkClicks += row.linkClicks;
        acc.clicksAll += row.clicksAll;
        acc.landingPageViews += row.landingPageViews;
        acc.revenueKrw += row.revenueKrw ?? 0;
        acc.marginKrw += row.marginKrw ?? 0;
        acc.days.add(row.metricDate);
        return acc;
      },
      {
        spendUsd: 0,
        spendKrw: 0,
        purchaseCount: 0,
        impressions: 0,
        linkClicks: 0,
        clicksAll: 0,
        landingPageViews: 0,
        revenueKrw: 0,
        marginKrw: 0,
        days: new Set<string>()
      }
    );

    return {
      spendUsd: totals.spendUsd,
      spendKrw: totals.spendKrw,
      purchaseCount: totals.purchaseCount,
      impressions: totals.impressions,
      linkClicks: totals.linkClicks,
      clicksAll: totals.clicksAll,
      landingPageViews: totals.landingPageViews,
      revenueKrw: totals.revenueKrw,
      marginKrw: totals.marginKrw,
      cpaUsd: safeDivide(totals.spendUsd, totals.purchaseCount),
      cpaKrw: safeDivide(totals.spendKrw, totals.purchaseCount),
      ctrLinkPct: safeDivide(totals.linkClicks * 100, totals.impressions),
      ctrAllPct: safeDivide(totals.clicksAll * 100, totals.impressions),
      cpcLinkUsd: safeDivide(totals.spendUsd, totals.linkClicks),
      cpcAllUsd: safeDivide(totals.spendUsd, totals.clicksAll),
      roas: safeDivide(totals.revenueKrw, totals.spendKrw),
      dataDays: totals.days.size
    };
  }
}
