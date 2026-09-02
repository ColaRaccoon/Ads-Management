import { expect, test } from "@playwright/test";
import { appendCleanupEntry, createScenarioEvidence, verifyApprovedE2eReceipt } from "../src/evidence";
import { apiPath, loadE2eTargetContract, newApiContext, readProtectedBytes, readProtectedJson } from "../src/target-contract";

const target = loadE2eTargetContract();
const runId = required("E2E_RUN_ID");
const cleanupFile = required("E2E_CLEANUP_MANIFEST_FILE");

test.describe.serial("actual full-app maximum resource and concurrency contract", () => {
  test("sends approved maximum upload and bundle fixtures through app routes", async ({ playwright }) => {
    const context = await newApiContext(playwright, target, "ADMIN");
    try {
      const meta = file("E2E_MAX_META_FILE", "max-meta.csv", "text/csv", 8 * 1024 * 1024);
      const response = await context.post(apiPath(target, "/api/uploads/meta-adset-csv"), {
        multipart: { file: meta, conflictPolicy: "SKIP" }, timeout: 300_000
      });
      expect(response.status()).toBe(201);
      record("UPLOAD_BATCH", ids(await response.json())[0]);

      const bundle = await context.post(apiPath(target, "/api/coupang/uploads/bundle"), {
        multipart: {
          sales: file("E2E_MAX_BUNDLE_SALES_FILE", "max-sales.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", 24 * 1024 * 1024),
          ads: file("E2E_MAX_BUNDLE_ADS_FILE", "max-ads.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", 24 * 1024 * 1024),
          margin: file("E2E_MAX_BUNDLE_MARGIN_FILE", "max-margin.csv", "text/csv", 8 * 1024 * 1024),
          conflictPolicy: "SKIP"
        },
        timeout: 300_000
      });
      expect(bundle.status()).toBe(201);
      for (const id of ids(await bundle.json())) record("COUPANG_BATCH", id);
    } finally { await context.dispose(); }
  });

  test("observes one admitted and one fail-fast heavy request", async ({ playwright }) => {
    const context = await newApiContext(playwright, target, "USER");
    const date = required("E2E_RESOURCE_REPORT_DATE");
    try {
      const body = { reportType: "PERIOD_XLSX", from: date, to: date, parameters: { resourceContractVersion: 1 } };
      const responses = await Promise.all([
        context.post(apiPath(target, "/api/reports/export"), { data: body, timeout: 300_000 }),
        context.post(apiPath(target, "/api/reports/export"), { data: body, timeout: 300_000 })
      ]);
      const statuses = responses.map((response) => response.status()).sort((left, right) => left - right);
      for (const response of responses.filter((candidate) => candidate.status() === 201)) {
        const reportIds = ids(await response.json());
        if (reportIds.length !== 1) throw new Error("E2E_RESOURCE_REPORT_ID_INVALID");
        record("REPORT_EXPORT", reportIds[0]);
      }
      expect(statuses).toContain(201);
      expect(statuses).toContain(503);
      const busy = responses.find((response) => response.status() === 503)!;
      expect(busy.headers()["retry-after"]).toBeTruthy();
      expect((await busy.json() as { code?: string }).code).toBe("HEAVY_OPERATION_BUSY");
    } finally { await context.dispose(); }
  });

  test("correlates A-owned cgroup evidence to the exact release and 1GiB limit", () => {
    const evidence = verifyApprovedE2eReceipt<{
      cgroupLimitBytes?: number; peakBytes?: number;
      oomDelta?: number; oomKillDelta?: number; actualRouteScenarios?: number;
    }>({
      value: readProtectedJson(required("E2E_RESOURCE_EVIDENCE_FILE")), target, kind: "resource.cgroup",
      approvedReceiptSha256: required("E2E_RESOURCE_RECEIPT_SHA256"),
      publicKeyFile: required("E2E_RECEIPT_PUBLIC_KEY_FILE")
    }).payload;
    expect(Object.keys(evidence).sort()).toEqual([
      "actualRouteScenarios", "cgroupLimitBytes", "oomDelta", "oomKillDelta", "peakBytes"
    ]);
    expect(evidence.cgroupLimitBytes).toBe(1024 * 1024 * 1024);
    expect(evidence.peakBytes).toBeLessThanOrEqual(850 * 1024 * 1024);
    expect(evidence.oomDelta).toBe(0);
    expect(evidence.oomKillDelta).toBe(0);
    expect(evidence.actualRouteScenarios).toBeGreaterThanOrEqual(4);
    expect(createScenarioEvidence({
      target, scenario: "resource.actual-app", result: "PASS", assertionCount: 7,
      counts: { peak_bytes: evidence.peakBytes!, scenarios: evidence.actualRouteScenarios! },
      codes: ["CGROUP_1GIB", "NO_OOM", "ACTUAL_ROUTES"]
    }).result).toBe("PASS");
  });
});

function file(environmentName: string, name: string, mimeType: string, maximum: number) {
  const filePath = required(environmentName);
  return { name, mimeType, buffer: readProtectedBytes(filePath, maximum) };
}

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

function ids(value: unknown): string[] {
  const found = new Set<string>();
  const visit = (entry: unknown, key = "") => {
    if (Array.isArray(entry)) { entry.forEach((item) => visit(item, key)); return; }
    if (entry && typeof entry === "object") {
      Object.entries(entry as Record<string, unknown>).forEach(([childKey, item]) => visit(item, childKey));
      return;
    }
    if ((key === "id" || key === "batchId") && typeof entry === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(entry)) found.add(entry);
  };
  visit(value);
  if (found.size < 1) throw new Error("E2E_RESOURCE_BATCH_ID_INVALID");
  return [...found].sort();
}

function record(kind: "UPLOAD_BATCH" | "COUPANG_BATCH" | "REPORT_EXPORT", opaqueId: string) {
  appendCleanupEntry(cleanupFile, {
    version: "e2e-cleanup/v1", runId, environmentId: target.environmentId,
    projectRef: target.projectRef, releaseGitSha: target.releaseGitSha
  }, { kind, opaqueId, cleanupOwner: "SUPABASE_MAINTENANCE" });
}
