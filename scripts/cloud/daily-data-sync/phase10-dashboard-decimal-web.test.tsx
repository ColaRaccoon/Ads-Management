import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { dashboardMoney, addDashboardMoney, collapseStageRows, dashboardChartRows, dashboardChartTooltip } from "../../../apps/web/src/lib/dashboard-money";
import { KpiCard } from "../../../apps/web/src/components/kpi-card";
import { TrendChart, ProductBarChart, StageBarChart } from "../../../apps/web/src/components/Charts";

// tsx's cross-workspace loader uses classic JSX for imported application files.
(globalThis as any).React = React;

test("dashboard money renders fractional and large canonical strings exactly with missing values distinct", () => {
  assert.equal(dashboardMoney("4968.99", "USD"), "$4,968.99");
  assert.equal(dashboardMoney("9007199254740993.0101"), "9,007,199,254,740,993.0101원");
  assert.equal(dashboardMoney("-0.0001"), "-0.0001원"); assert.equal(dashboardMoney("0"), "0원");
  assert.equal(dashboardMoney(null), "-"); assert.equal(dashboardMoney(undefined), "-");
  assert.equal(dashboardMoney("NaN"), "-");
});
test("stage money sums decimal coefficients before any chart Number projection", () => {
  assert.equal(addDashboardMoney("0.1", "0.2"), "0.3");
  assert.equal(addDashboardMoney("9007199254740993.01", "-0.009"), "9007199254740993.001");
  assert.equal(addDashboardMoney("-0.01", "0.01"), "0"); assert.equal(addDashboardMoney("10.00", "0"), "10");
  assert.equal(addDashboardMoney("1", null), null); assert.throws(() => addDashboardMoney("Infinity", "0"));
  const rows = collapseStageRows(Array.from({ length: 200 }, (_, i) => ({ group: "SC", spendKrw: i === 199 ? "25.83" : "24.84", purchaseCount: 1 })));
  assert.equal(rows[0].spendKrw, "4968.99"); assert.equal(rows[0].purchaseCount, 200);
});
test("stage missing FX and mixed attribution retain null money/count instead of zero", () => {
  const rows = collapseStageRows([{ group: "SC", spendKrw: "1", purchaseCount: 1, hasApiMetrics: true, attributionContexts: ["one"] }, { group: "SC", spendKrw: null, purchaseCount: 2, attributionContexts: ["two"] }]);
  assert.equal(rows[0].spendKrw, null); assert.equal(rows[0].purchaseCount, null);
});
test("chart geometry projects finite safe magnitudes only and tooltip displays original decimal text", () => {
  const input = [{ date: "2026-10-14", spendKrw: "4968.99", cpaKrw: null, marginKrw: "9007199254740993.01", purchaseCount: 200 }];
  const [row] = dashboardChartRows(input);
  assert.equal(row.spendKrw, 4968.99); assert.equal(row.cpaKrw, null); assert.equal(row.marginKrw, null); assert.equal(row.purchaseCount, 200);
  assert.deepEqual(row.dashboardMoneyOriginal, { spendKrw: "4968.99", cpaKrw: null, marginKrw: "9007199254740993.01" });
  assert.equal(dashboardChartTooltip(row.spendKrw, "광고비", { dataKey: "spendKrw", payload: row }), "4,968.99");
  assert.equal(dashboardChartTooltip(null, "마진", { dataKey: "marginKrw", payload: row }), "9,007,199,254,740,993.01");
  assert.equal(dashboardChartTooltip(null, "CPA", { dataKey: "cpaKrw", payload: row }), "-");
  assert.deepEqual(input[0].spendKrw, "4968.99"); assert.equal(JSON.parse(JSON.stringify(row)).dashboardMoneyOriginal.spendKrw, "4968.99");
});
test("affected KPI and three Recharts consumers render serializable string-money props locally", () => {
  const data = [{ date: "2026-10-14", name: "Synthetic", group: "SC", spendKrw: "4968.99", marginKrw: "-0.01", cpaKrw: null, purchaseCount: 200 }];
  assert(renderToStaticMarkup(<KpiCard label="총 광고비" value={dashboardMoney("9007199254740993.01")} />).includes("9,007,199,254,740,993.01원"));
  for (const Chart of [TrendChart, ProductBarChart, StageBarChart]) assert(renderToStaticMarkup(<Chart data={data} />).includes("chart-box"));
});
