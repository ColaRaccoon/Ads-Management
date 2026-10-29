import type { PublishedReportFact } from "./report-contract";
import { datesIn, type ReportQuery } from "./report-query";
import type { SourceCoverage } from "./types";
import { ExactDecimal as D } from "./domain/decimal";
import { summarizeReport } from "./domain/report-calculation";
import type { RelationshipDay } from "./domain/relationship-calculation";
import { MEDIUM_PLATFORM, type parseRelationshipQuery } from "./relationship-query";

/** Only complete, selected daily measures enter statistical pairs. Confidence remains metadata. */
export function relationshipDays(scope: { facts: PublishedReportFact[]; coverage: SourceCoverage[] }, query: ReportQuery,
  settings: ReturnType<typeof parseRelationshipQuery>, lookbackFrom: string): RelationshipDay[] {
  const factsByDay = new Map<string, PublishedReportFact[]>(), coverageByDay = new Map<string, SourceCoverage[]>();
  for (const fact of scope.facts) {
    if (!factsByDay.has(fact.date)) factsByDay.set(fact.date, []);
    factsByDay.get(fact.date)!.push(fact);
  }
  for (const row of scope.coverage) {
    if (!coverageByDay.has(row.date)) coverageByDay.set(row.date, []);
    coverageByDay.get(row.date)!.push(row);
  }
  return datesIn(lookbackFrom, query.to).map(date => {
    const facts = factsByDay.get(date) ?? [], coverage = coverageByDay.get(date) ?? [];
    const outcome = summarizeReport(facts.filter(f => f.component === "SALE"), coverage.filter(c => c.component === "SALE" || c.component === "DIRECT_COST"), query);
    const media = settings.availableMedia.map(medium => {
      const platform = MEDIUM_PLATFORM[medium];
      return { medium, applicable: coverage.some(c => c.platform === platform && c.component === "AD_SPEND" && c.participation === "INCLUDED"),
        result: summarizeReport(facts.filter(f => f.component === "AD_SPEND" && f.platform === platform),
        coverage.filter(c => c.component === "AD_SPEND" && c.platform === platform), { platforms: [platform], productName: query.productName }) };
    }).filter(row => row.applicable);
    const total = (values: Array<string | null>, empty: string | null) => !values.length ? empty : values.some(v => v === null) ? null :
      values.reduce((sum, value) => sum.plus(value!), new D(0)).toFixed(6);
    return { date, adSpend: total(media.filter(m => settings.analysisMedia.includes(m.medium)).map(m => m.result.completeTotals.adSpend), null),
      otherAdSpend: total(media.filter(m => !settings.analysisMedia.includes(m.medium)).map(m => m.result.completeTotals.adSpend), "0.000000"),
      revenue: outcome.completeTotals.revenue, profitBeforeAds: outcome.completeTotals.profitBeforeAds,
      isEstimate: outcome.isEstimate || media.some(m => m.result.isEstimate),
      issues: [...new Set([...outcome.issues, ...media.flatMap(m => m.result.issues)])].sort() };
  });
}
