import { expect, test } from "@playwright/test";
import { reportWorkbookCompatibility } from "../../api/src/staging/report-workbook-compatibility";
import {
  appendCleanupEntry,
  canonicalDigest,
  createScenarioEvidence
} from "../src/evidence";
import { createSyntheticBusinessFixture } from "../src/fixtures/synthetic-business";
import { apiPath, loadE2eTargetContract, newApiContext } from "../src/target-contract";

const target = loadE2eTargetContract();
const runId = requiredRunId();
const cleanupFile = requiredEnvironment("E2E_CLEANUP_MANIFEST_FILE");
const cleanupBase = {
  version: "e2e-cleanup/v1" as const,
  runId,
  environmentId: target.environmentId,
  projectRef: target.projectRef,
  releaseGitSha: target.releaseGitSha
};

test.describe.serial("actual Meta/Cafe24/Coupang KPI and report contract", () => {
  test("imports deterministic synthetic files through the full app routes", async ({ playwright }) => {
    const fixture = await createSyntheticBusinessFixture(runId);
    const context = await newApiContext(playwright, target, "ADMIN");
    try {
      const meta = await context.post(apiPath(target, "/api/uploads/meta-adset-csv"), {
        multipart: { file: { name: fixture.files.meta.name, mimeType: fixture.files.meta.mimeType, buffer: fixture.files.meta.bytes }, conflictPolicy: "SKIP" }
      });
      expect(meta.status()).toBe(201);
      record(await opaqueId(meta), "UPLOAD_BATCH");

      const cafe24 = await context.post(apiPath(target, "/api/sales/cafe24/uploads"), {
        multipart: { file: { name: fixture.files.cafe24.name, mimeType: fixture.files.cafe24.mimeType, buffer: fixture.files.cafe24.bytes }, conflictPolicy: "SKIP" }
      });
      expect(cafe24.status()).toBe(201);
      record(await opaqueId(cafe24), "CAFE24_BATCH");

      const coupang = await context.post(apiPath(target, "/api/coupang/uploads/sales"), {
        multipart: {
          file: { name: fixture.files.coupang.name, mimeType: fixture.files.coupang.mimeType, buffer: fixture.files.coupang.bytes },
          conflictPolicy: "SKIP", reportDate: fixture.date
        }
      });
      expect(coupang.status()).toBe(201);
      record(await opaqueId(coupang), "COUPANG_BATCH");
    } finally { await context.dispose(); }
  });

  test("matches the approved stable KPI digest", async ({ playwright }) => {
    const fixture = await createSyntheticBusinessFixture(runId);
    const context = await newApiContext(playwright, target, "USER");
    try {
      const paths = [
        `/api/dashboard/summary?from=${fixture.date}&to=${fixture.date}`,
        `/api/sales/product-performance?from=${fixture.date}&to=${fixture.date}`,
        `/api/coupang/dashboard?from=${fixture.date}&to=${fixture.date}`,
        `/api/coupang/product-profit?from=${fixture.date}&to=${fixture.date}`,
        `/api/coupang/ads-analysis?from=${fixture.date}&to=${fixture.date}`,
        `/api/coupang/daily-report?date=${fixture.date}`
      ];
      const values: unknown[] = [];
      for (const path of paths) {
        const response = await context.get(apiPath(target, path));
        expect(response.status()).toBe(200);
        values.push(stableProjection(await response.json(), runId));
      }
      const digest = canonicalDigest(values);
      expect(digest).toBe(target.expected.businessDigestSha256);
      expect(createScenarioEvidence({
        target, scenario: "business.kpi", result: "PASS", assertionCount: paths.length,
        counts: { endpoints: paths.length }, digests: { business: digest }
      }).result).toBe("PASS");
    } finally { await context.dispose(); }
  });

  test("exports, downloads, hashes and canonicalizes the actual workbook", async ({ playwright }) => {
    const fixture = await createSyntheticBusinessFixture(runId);
    const context = await newApiContext(playwright, target, "USER");
    try {
      const exported = await context.post(apiPath(target, "/api/reports/export"), {
        data: { reportType: "PERIOD_XLSX", from: fixture.date, to: fixture.date, parameters: { e2eContractVersion: 1 } }
      });
      expect(exported.status()).toBe(201);
      const reportId = await opaqueId(exported);
      record(reportId, "REPORT_EXPORT");
      const downloaded = await context.get(apiPath(target, `/api/reports/${reportId}/download`));
      expect(downloaded.status()).toBe(200);
      expect(downloaded.headers()["x-content-type-options"]).toBe("nosniff");
      const bytes = Buffer.from(await downloaded.body());
      const proof = await reportWorkbookCompatibility(bytes, {
        from: fixture.date, to: fixture.date, reportType: "PERIOD_XLSX", runId
      });
      expect(proof.digest).toBe(target.expected.reportDigestSha256);
      expect(createScenarioEvidence({
        target, scenario: "business.report", result: "PASS", assertionCount: 4,
        counts: { report_bytes: bytes.length }, digests: { report: proof.digest }
      }).result).toBe("PASS");
    } finally { await context.dispose(); }
  });
});

function record(opaqueId: string, kind: "UPLOAD_BATCH" | "CAFE24_BATCH" | "COUPANG_BATCH" | "REPORT_EXPORT") {
  appendCleanupEntry(cleanupFile, cleanupBase, { kind, opaqueId, cleanupOwner: "SUPABASE_MAINTENANCE" });
}

async function opaqueId(response: { json(): Promise<unknown> }) {
  const body = await response.json() as { id?: unknown; batchId?: unknown };
  const value = body.id ?? body.batchId;
  expect(value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  return value as string;
}

function stableProjection(value: unknown, run: string): unknown {
  if (Array.isArray(value)) return value.map((entry) => stableProjection(entry, run));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !/(?:^id$|Id$|At$)/.test(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableProjection(entry, run)]));
  }
  return typeof value === "string" ? value.split(run).join("<RUN_ID>") : value;
}

function requiredRunId() {
  const value = process.env.E2E_RUN_ID?.trim() ?? "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new Error("E2E_RUN_ID_INVALID");
  return value;
}

function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}
