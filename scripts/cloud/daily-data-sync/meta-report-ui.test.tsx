import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { META_ADS_COLUMNS } from "../../../apps/web/src/features/meta-ads/columns";
import { DailyReportSummary } from "../../../apps/web/src/features/meta-daily-report/components/daily-report-summary";
import { ProductReportBox } from "../../../apps/web/src/features/meta-daily-report/components/product-report-box";
import { formatCpa, renderColumnValue } from "../../../apps/web/src/features/meta-daily-report/daily-report-value";
import { aggregateProductRows, buildPreviousIndexes } from "../../../apps/web/src/features/meta-daily-report/report-model";
import { META_DAILY_COLUMNS } from "../../../apps/web/src/lib/meta-daily-columns";
import { sortMetaCreativeRows } from "../../../apps/web/src/lib/meta-ads-sort";
import { buildMetaAdsXlsxInput } from "../../../apps/web/src/lib/meta-ads-xlsx";
import { buildMetaDailyXlsxInput } from "../../../apps/web/src/lib/meta-daily-xlsx";
import type { MetaCreativePerformanceRow } from "../../../apps/web/src/types/meta";

// tsx's standalone JSX host; Next supplies the automatic JSX runtime in production.
Object.assign(globalThis, { React });
const row: MetaCreativePerformanceRow = {
  creativeKey: "sample:001", displayName: "샘플상품_소재001", productName: "샘플상품", productId: "sample",
  materialNo: "소재001", deliveryStatus: "active", dataDays: 55,
  totals: { spendUsd: 100, spendKrw: 130000, purchaseCount: 10, cpaUsd: 10, cpaKrw: 13000,
    ctrLinkPct: 1.23, cpmUsd: 5, reach: 1000, marginKrw: 40000, revenueKrw: 200000, roas: 200000 / 130000,
    providerPurchaseValueUsd: 250, providerPurchaseRoas: 2.5, providerPurchaseContext: "MCP_PROVIDER_DEFAULT_UNVERIFIED",
    hasApiMetrics: true, attributionContexts: ['provider-default'], metricUnavailableReasons: { videoPlay3sCount: "UNSUPPORTED_FIELD" },
    videoPlay3sCount: null, videoPlay25Count: 250, videoPlay50Count: 200, videoPlay75Count: 150, videoPlay100Count: 100,
    videoPlay3sRatePct: null, videoPlay25RatePct: 25, videoPlay50RatePct: 20, videoPlay75RatePct: 15, videoPlay100RatePct: 10 }
};
const totals = aggregateProductRows([row]);
const group = { productName: row.productName!, productId: row.productId, rows: [row], totals, salesRow: null, salesOnly: false };
const report = { reportDate: "2026-10-25", productCount: 1, totals, groups: [group], visibleColumns: META_DAILY_COLUMNS.map(c => c.key) };
const markup = (element: React.ReactNode) => renderToStaticMarkup(<>{element}</>);

test("CPA stays KRW including missing FX, Meta ROAS has one consistent definition in both views", () => {
  assert.equal(formatCpa(row.totals), "13,000원");
  assert.equal(formatCpa({ cpaKrw: null, cpaUsd: 10 }), "-");
  assert.equal(markup(META_ADS_COLUMNS.find(c => c.key === "cpa")!.render(row)), "13,000원");
  assert.match(markup(renderColumnValue({ key: "roas", label: "Meta ROAS" }, row, null)), /250%/);
  assert.match(markup(META_ADS_COLUMNS.find(c => c.key === "providerPurchase")!.render(row)), /250/);
  const legacy = { ...row, totals: { ...row.totals, providerPurchaseRoas: undefined } };
  assert.doesNotMatch(markup(renderColumnValue({ key: "roas", label: "Meta ROAS" }, legacy, null)), /153/);
  const summary = markup(<DailyReportSummary productCount={1} totals={totals} />);
  assert.match(summary, /250%/); assert.doesNotMatch(summary, /기본 기여 조건 미검증|2.5000배|전체 ROAS/);
});

test("CPA and Meta ROAS sorting uses the displayed measures, with unknown values last", () => {
  const other = { ...row, creativeKey: 'other', totals: { ...row.totals, cpaUsd: 1, cpaKrw: 20000, providerPurchaseValueUsd: 1000, providerPurchaseRoas: 1 } };
  assert.equal(sortMetaCreativeRows([row, other], 'cpa', 'asc')[0].creativeKey, row.creativeKey);
  assert.equal(sortMetaCreativeRows([row, other], 'providerPurchase', 'asc')[0].creativeKey, 'other');
  const missing = { ...row, creativeKey: 'missing', totals: { ...row.totals, cpaKrw: null } };
  assert.equal(sortMetaCreativeRows([missing, row], 'cpa', 'desc')[1].creativeKey, 'missing');
});

test("Excel matches screen currency and provider ROAS for detail, product and summary", () => {
  const ads = buildMetaAdsXlsxInput([row]);
  const headers = ads.rows[0] as { value: unknown }[], values = ads.rows[1] as { value: unknown; style: string }[];
  const cpa = headers.findIndex(c => c.value === 'CPA (원)'), roas = headers.findIndex(c => c.value === 'Meta ROAS');
  assert.deepEqual(values[cpa], { value: 13000, style: 'Krw' });
  assert.deepEqual(values[roas], { value: 2.5, style: 'Percent' });
  const daily = buildMetaDailyXlsxInput(report);
  const summary = daily.rows[2] as { value: unknown; style: string }[];
  assert.equal(summary[3].value, 13000); assert.equal(summary[3].style, 'TotalKrw'); assert.equal(summary[4].value, 2.5);
  const json = JSON.stringify(daily.rows);
  assert.match(json, /Meta ROAS/); assert.doesNotMatch(json, /153\.846/);
  assert.equal(aggregateProductRows([row, { ...row, totals: { ...row.totals, providerPurchaseContext: null } }]).providerPurchaseRoas, null);
});

const preview = <QueryClientProvider client={new QueryClient()}>
  <main style={{ padding: 24 }}>
    <p className="muted">화면 검증용 예시 데이터 · 운영 데이터가 아닙니다</p>
    <h1>Daily Report</h1>
    <DailyReportSummary productCount={1} totals={totals} />
    <ProductReportBox columns={[...META_DAILY_COLUMNS]} group={group} previousIndexes={buildPreviousIndexes([row])}
      reportDate="2026-10-25" salesIsError={false} salesIsLoading={false} />
    <h1 style={{ marginTop: 32 }}>Meta Ads</h1>
    <p className="muted">CPA는 원화 · Meta ROAS는 구매전환금액 기준</p>
    <div className="table-wrap"><table><thead><tr>{META_ADS_COLUMNS.map(c => <th key={c.key}>{c.header}</th>)}</tr></thead>
      <tbody><tr>{META_ADS_COLUMNS.map(c => <td key={c.key}>{c.render(row)}</td>)}</tr></tbody></table></div>
  </main>
</QueryClientProvider>;

test("collection explanations are collapsed by default without hiding metric cells", () => {
  const html = markup(preview);
  assert.match(html, /<details class="meta-report-details muted">/);
  assert.doesNotMatch(html, /<details[^>]* open/);
  assert.match(html, /13,000원/); assert.match(html, /250%/); assert.match(html, /55/);
  if (process.env.META_REPORT_PREVIEW_PATH) {
    const path = process.env.META_REPORT_PREVIEW_PATH;
    mkdirSync(dirname(path), { recursive: true });
    const css = readFileSync('apps/web/src/app/globals.css', 'utf8');
    writeFileSync(path, `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Meta Report Preview</title><style>${css}</style><body>${html}</body></html>`);
  }
});
