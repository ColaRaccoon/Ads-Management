import { expect, test } from "@playwright/test";
import { appendCleanupEntry, createScenarioEvidence, verifyApprovedE2eReceipt } from "../src/evidence";
import { createSyntheticBusinessFixture } from "../src/fixtures/synthetic-business";
import { apiPath, loadE2eTargetContract, newApiContext, readProtectedJson, readProtectedText } from "../src/target-contract";

const target = loadE2eTargetContract();
const runId = required("E2E_RUN_ID", /^[0-9a-f-]{36}$/);
const storageRunId = `${runId[0] === "f" ? "e" : "f"}${runId.slice(1)}`;
const cleanupFile = required("E2E_CLEANUP_MANIFEST_FILE");

test.describe.serial("actual private Storage lifecycle and browser denial", () => {
  test("denies direct anon and authenticated browser roles from the known sentinel", async ({ playwright }) => {
    const publishable = protectedValue("E2E_SUPABASE_PUBLISHABLE_KEY_FILE");
    const authenticated = protectedValue("E2E_SUPABASE_AUTHENTICATED_TOKEN_FILE");
    const url = `${target.supabaseOrigin}/storage/v1/object/${encodeURIComponent(target.storageBucket)}/${target.readinessKey.split("/").map(encodeURIComponent).join("/")}`;
    const anonymous = await playwright.request.newContext({ extraHTTPHeaders: { apikey: publishable } });
    const user = await playwright.request.newContext({ extraHTTPHeaders: { apikey: publishable, authorization: `Bearer ${authenticated}` } });
    try {
      for (const context of [anonymous, user]) {
        const response = await context.get(url);
        expect(response.status()).toBe(400);
        await response.body();
      }
    } finally { await anonymous.dispose(); await user.dispose(); }
  });

  test("uploads, tombstones and restores a synthetic object through app routes", async ({ playwright }) => {
    const fixture = await createSyntheticBusinessFixture(storageRunId);
    const context = await newApiContext(playwright, target, "ADMIN");
    try {
      const uploaded = await context.post(apiPath(target, "/api/uploads/meta-adset-csv"), {
        multipart: { file: { name: fixture.files.meta.name, mimeType: fixture.files.meta.mimeType, buffer: fixture.files.meta.bytes }, conflictPolicy: "SKIP" }
      });
      expect(uploaded.status()).toBe(201);
      const uploadId = idOf(await uploaded.json());
      append("UPLOAD_BATCH", uploadId);
      const deleted = await context.delete(apiPath(target, `/api/uploads/${uploadId}`));
      expect(deleted.status()).toBe(200);
      const tombstoneId = idOf(await deleted.json(), "tombstoneId");
      append("TOMBSTONE", tombstoneId);
      const restored = await context.post(apiPath(target, `/api/uploads/storage-tombstones/${tombstoneId}/restore`), { data: {} });
      expect(restored.status()).toBe(201);
      expect((await restored.json() as { state?: string }).state).toBe("RESTORED");
      expect(createScenarioEvidence({
        target, scenario: "storage.lifecycle", result: "PASS", assertionCount: 6,
        counts: { uploads: 1, tombstones: 1 }, codes: ["APP_UPLOAD", "TOMBSTONE_RETAIN", "RESTORE"]
      }).result).toBe("PASS");
    } finally { await context.dispose(); }
  });

  test("correlates provider observer hashes and the approved fault compensation receipt", () => {
    const lifecycle = approvedPayload("storage.lifecycle", "E2E_STORAGE_LIFECYCLE_RECEIPT_FILE", "E2E_STORAGE_LIFECYCLE_RECEIPT_SHA256") as {
      uploadHashVerified?: boolean; trashHashVerified?: boolean;
      restoreHashVerified?: boolean; finalState?: string; orphanObjects?: number;
    };
    exactPayload(lifecycle, ["uploadHashVerified", "trashHashVerified", "restoreHashVerified", "finalState", "orphanObjects"]);
    expect(lifecycle).toMatchObject({
      uploadHashVerified: true,
      trashHashVerified: true,
      restoreHashVerified: true,
      finalState: "RESTORED",
      orphanObjects: 0
    });
    const fault = approvedPayload("storage.fault", "E2E_STORAGE_FAULT_RECEIPT_FILE", "E2E_STORAGE_FAULT_RECEIPT_SHA256") as {
      faultScope?: string; databaseReserved?: boolean;
      storageAttempted?: boolean; databaseFinalized?: boolean; pendingRows?: number; orphanObjects?: number;
      faultMechanismRemoved?: boolean;
    };
    exactPayload(fault, [
      "faultScope", "databaseReserved", "storageAttempted", "databaseFinalized", "pendingRows", "orphanObjects", "faultMechanismRemoved"
    ]);
    expect(fault).toMatchObject({
      faultScope: "SYNTHETIC_STAGING_ONLY",
      databaseReserved: true,
      storageAttempted: true,
      databaseFinalized: false,
      pendingRows: 0,
      orphanObjects: 0,
      faultMechanismRemoved: true
    });
  });
});

function append(kind: "UPLOAD_BATCH" | "TOMBSTONE", opaqueId: string) {
  appendCleanupEntry(cleanupFile, {
    version: "e2e-cleanup/v1", runId, environmentId: target.environmentId,
    projectRef: target.projectRef, releaseGitSha: target.releaseGitSha
  }, { kind, opaqueId, cleanupOwner: "SUPABASE_MAINTENANCE" });
}

function idOf(value: unknown, field = "batchId") {
  const record = value as Record<string, unknown>;
  const id = record[field] ?? record.id;
  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  return id as string;
}

function protectedValue(environmentName: string) {
  const file = required(environmentName);
  const value = readProtectedText(file, 32 * 1024).trim();
  if (!value || value.length > 16_384) throw new Error("E2E_PROTECTED_VALUE_INVALID");
  return value;
}

function approvedPayload(kind: string, fileVariable: string, digestVariable: string) {
  return verifyApprovedE2eReceipt({
    value: readProtectedJson(required(fileVariable)), target, kind,
    approvedReceiptSha256: required(digestVariable), publicKeyFile: required("E2E_RECEIPT_PUBLIC_KEY_FILE")
  }).payload;
}

function exactPayload(value: object, keys: string[]) {
  expect(Object.keys(value).sort()).toEqual([...keys].sort());
}

function required(name: string, pattern?: RegExp) {
  const value = process.env[name]?.trim();
  if (!value || (pattern && !pattern.test(value))) throw new Error(`${name}_REQUIRED`);
  return value;
}
