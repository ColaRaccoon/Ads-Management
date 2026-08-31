import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { reportWorkbookCompatibility } from "./report-workbook-compatibility";

const runId = "11111111-1111-4111-8111-111111111111";

describe("report workbook compatibility proof", () => {
  it("hashes canonical business cells while normalizing the synthetic run id", async () => {
    const first = await reportWorkbookCompatibility(await workbook(runId), expected(runId));
    const secondRun = "22222222-2222-4222-8222-222222222222";
    const second = await reportWorkbookCompatibility(await workbook(secondRun), expected(secondRun));
    expect(first.digest).toBe(second.digest);
    expect(first.canonicalBytes).toBeGreaterThan(100);
  });

  it("keeps symmetric UUID relationship graphs stable without using raw UUID order", async () => {
    const parallel = await reportWorkbookCompatibility(
      await workbook(runId, { symmetricCross: false }), expected(runId)
    );
    const crossed = await reportWorkbookCompatibility(
      await workbook(runId, { symmetricCross: true }), expected(runId)
    );
    expect(parallel.digest).toBe(crossed.digest);
  });

  it("rejects a report whose KPI cell, relationship, or required business sheet regresses", async () => {
    const changed = await workbook(runId, { spendKrw: 1 });
    const baseline = await reportWorkbookCompatibility(await workbook(runId), expected(runId));
    const changedProof = await reportWorkbookCompatibility(changed, expected(runId));
    expect(changedProof.digest).not.toBe(baseline.digest);

    const changedRule = await reportWorkbookCompatibility(
      await workbook(runId, { targetCpaKrw: 99_999 }),
      expected(runId)
    );
    expect(changedRule.digest).not.toBe(baseline.digest);

    const changedRelationship = await reportWorkbookCompatibility(
      await workbook(runId, { breakDecisionLink: true }),
      expected(runId)
    );
    expect(changedRelationship.digest).not.toBe(baseline.digest);

    const missing = new ExcelJS.Workbook();
    missing.addWorksheet("Summary");
    await expect(reportWorkbookCompatibility(Buffer.from(await missing.xlsx.writeBuffer()), expected(runId)))
      .rejects.toThrow("REPORT_COMPATIBILITY_SHEETS_INVALID");
  });
});

function expected(id: string) {
  return { from: "2026-08-25", to: "2026-08-25", reportType: "PERIOD_XLSX", runId: id };
}

async function workbook(
  id: string,
  overrides: {
    spendKrw?: number;
    targetCpaKrw?: number;
    breakDecisionLink?: boolean;
    symmetricCross?: boolean;
  } = {}
) {
  const value = new ExcelJS.Workbook();
  const volatileId = id.startsWith("11111111")
    ? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    : "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const volatileDecisionRunId = id.startsWith("11111111")
    ? "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
    : "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const summary = value.addWorksheet("Summary");
  const summaryRows = [
    ["Period", "2026-08-25 ~ 2026-08-25"], ["Report Type", "PERIOD_XLSX"], ["Spend USD", 20],
    ["Spend KRW", overrides.spendKrw ?? 27_000], ["Purchases", 2], ["CPA KRW", 13_500],
    ["Revenue KRW", 138_000], ["Margin KRW", 61_000], ["Unmatched", 0],
    ["Missing Cost Rules", 0], ["Missing CPA Rules", 0]
  ];
  summaryRows.forEach((row) => summary.addRow(row));
  table(value.addWorksheet("Product Performance"), {
    "product.id": volatileId, "product.code": `MUT-${id}`, "product.name": "Compatibility product", "product.displayName": "Compatibility product",
    "totals.spendUsd": 20, "totals.spendKrw": 27_000, "totals.purchaseCount": 2, "totals.cpaKrw": 13_500,
    "totals.revenueKrw": 138_000, "totals.marginKrw": 61_000, targetCpaKrw: overrides.targetCpaKrw ?? 15_000,
    breakEvenCpaKrw: 20_000, watchCpaKrw: 18_000, stopCpaKrw: 25_000, ruleStatus: "WATCH",
    createdAt: id.startsWith("11111111") ? "2026-08-31" : "2026-09-01"
  });
  table(value.addWorksheet("Adset Performance"), {
    adsetName: `Compatibility ${id}`, stage: "TEST", "product.displayName": "Compatibility product",
    "totals.spendUsd": 20, "totals.spendKrw": 27_000, "totals.purchaseCount": 2, "totals.cpaKrw": 13_500,
    "totals.revenueKrw": 138_000, "totals.marginKrw": 61_000
  });
  const decisionRows = overrides.symmetricCross === undefined ? [{
    id: volatileId, decisionRunId: volatileDecisionRunId, scopeType: "ADSET", decision: "KEEP", severity: "INFO",
    reason: `Compatibility ${id}`, recommendedAction: "Observe",
    createdAt: id.startsWith("11111111") ? "2026-08-31" : "2026-09-01"
  }] : ["10000000-0000-4000-8000-000000000001", "f0000000-0000-4000-8000-000000000002"].map(
    (decisionId) => ({
      id: decisionId, scopeType: "ADSET", decision: "KEEP", severity: "INFO",
      reason: "Symmetric decision", recommendedAction: "Observe"
    })
  );
  tableRows(value.addWorksheet("Decisions"), decisionRows);
  value.addWorksheet("Unmatched").addRow(["No data"]);
  const changeRows = overrides.symmetricCross === undefined ? [{
    id: volatileDecisionRunId, actionDate: "2026-08-25", actionType: "KEEP", entityType: "META_ADSET",
    reason: "Compatibility change", relatedDecisionId: overrides.breakDecisionLink
      ? "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
      : volatileId
  }] : ["20000000-0000-4000-8000-000000000003", "e0000000-0000-4000-8000-000000000004"].map(
    (changeId, index) => ({
      id: changeId, actionDate: "2026-08-25", actionType: "KEEP", entityType: "META_ADSET",
      reason: "Symmetric change", relatedDecisionId: decisionRows[overrides.symmetricCross ? 1 - index : index].id
    })
  );
  tableRows(value.addWorksheet("Change Logs"), changeRows);
  return Buffer.from(await value.xlsx.writeBuffer());
}

function table(sheet: ExcelJS.Worksheet, row: Record<string, string | number>) {
  tableRows(sheet, [row]);
}

function tableRows(sheet: ExcelJS.Worksheet, rows: Array<Record<string, string | number>>) {
  const columns = Object.keys(rows[0]);
  sheet.addRow(columns);
  for (const row of rows) sheet.addRow(columns.map((column) => row[column]));
}
