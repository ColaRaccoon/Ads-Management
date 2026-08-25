import ExcelJS from "exceljs";
import { describe, expect, it, vi } from "vitest";
import { addObjectRows, addRows, ReportsService } from "./reports.service";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const SPOOFED_ACTOR_ID = "22222222-2222-4222-8222-222222222222";

describe("ReportsService actor attribution", () => {
  it("uses the authenticated actor when creating an export record", async () => {
    const create = vi.fn(async (_args: { data: Record<string, unknown> }) => {
      throw new Error("stop after attribution write");
    });
    const service = new ReportsService(
      { reportExport: { create } } as never,
      {} as never,
      { get: (key: string) => key === "STORAGE_PROVIDER" ? "local" : "./storage/security-dev/reports" } as never
    );

    await expect(
      service.export(
        {
          reportType: "DAILY_HTML",
          from: "2026-08-24",
          to: "2026-08-24",
          parameters: { createdBy: SPOOFED_ACTOR_ID }
        },
        ACTOR_ID
      )
    ).rejects.toThrow("stop after attribution write");

    expect(create.mock.calls[0][0].data.createdBy).toBe(ACTOR_ID);
  });
});

describe("STEP7-EVAL-011 server workbook cell safety", () => {
  it("escapes all formula prefixes in array and object rows while preserving numeric cells", () => {
    const workbook = new ExcelJS.Workbook();
    const arraySheet = workbook.addWorksheet("arrays");
    addRows(arraySheet, [["=SUM(A1:A2)", "+cmd", "-1+2", "@external", "  =hidden", 42]]);
    expect(arraySheet.getRow(1).values).toEqual([
      undefined,
      "'=SUM(A1:A2)",
      "'+cmd",
      "'-1+2",
      "'@external",
      "'  =hidden",
      42
    ]);

    const objectSheet = workbook.addWorksheet("objects");
    addObjectRows(objectSheet, [{ formula: "=1+1", numeric: 7, ordinary: "report" }]);
    expect(objectSheet.getRow(2).getCell(1).value).toBe("'=1+1");
    expect(objectSheet.getRow(2).getCell(2).value).toBe(7);
    expect(objectSheet.getRow(2).getCell(3).value).toBe("report");
  });
});

describe("STEP7 report HTML safety", () => {
  it("escapes product display names in the narrative as well as table cells", async () => {
    const externalName = '<img src=x onerror="synthetic-marker">';
    const service = new ReportsService(
      { decisionLog: { findMany: vi.fn(async () => []) } } as never,
      {
        dashboardSummary: vi.fn(async () => ({
          totals: { spendUsd: 0, spendKrw: 0, purchaseCount: 0, cpaKrw: 0, revenueKrw: 0, marginKrw: 0 },
          health: { unmatchedCount: 0, missingCostRuleCount: 0, missingCpaRuleCount: 0 }
        })),
        productMetrics: vi.fn(async () => [
          { product: { displayName: externalName }, totals: { marginKrw: 1 } }
        ]),
        adsetMetrics: vi.fn(async () => []),
        unmatchedMetrics: vi.fn(async () => [])
      } as never,
      {} as never
    );

    const html = await (service as unknown as {
      renderHtml(from: string, to: string): Promise<string>;
    }).renderHtml("2026-08-01", "2026-08-01");

    expect(html).not.toContain(externalName);
    expect(html).toContain("&lt;img src=x onerror=&quot;synthetic-marker&quot;&gt;");
  });
});
