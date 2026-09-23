import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { ApiError, resetApiClientForTests, uploadCsv } from "./api";
import { MetaUploadBatch, recoverMetaUpload, UPLOAD_RESULT_UNKNOWN } from "./meta-upload-recovery";

const batch = (overrides: Partial<MetaUploadBatch> = {}): MetaUploadBatch => ({
  id: "new", fileHashSha256: "hash", conflictPolicy: "SKIP", status: "IMPORTED",
  rowCount: 209, validRowCount: 209, warningCount: 0, errorCount: 0,
  columnSchema: { previewSummary: { rowCount: 209 } }, ...overrides
});
const input = (list: () => Promise<MetaUploadBatch[]>) => ({
  hash: "hash", policy: "SKIP", previousIds: new Set(["old"]), list,
  isTemporary: (error: unknown) => error instanceof ApiError && error.status === 503,
  wait: async () => {}, attempts: 3
});

afterEach(() => { resetApiClientForTests(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("Meta upload result reconciliation", () => {
  it("waits for the committed batch instead of reporting a gateway failure", async () => {
    const list = vi.fn().mockResolvedValueOnce([batch({ status: "VALIDATING" })])
      .mockResolvedValueOnce([batch()]);
    await expect(recoverMetaUpload(input(list))).resolves.toMatchObject({
      batchId: "new", status: "IMPORTED", rowCount: 209, recoveredAfterDisconnect: true
    });
    expect(list).toHaveBeenCalledTimes(2);
  });
  it("does not mistake an old or unrelated upload for this request", async () => {
    await expect(recoverMetaUpload(input(async () => [batch({ id: "old" }), batch({ fileHashSha256: "other" })])))
      .rejects.toThrow(UPLOAD_RESULT_UNKNOWN);
  });
  it("matches a new version by original content hash without accepting old versions", async () => {
    await expect(recoverMetaUpload({ ...input(async () => [batch({
      fileHashSha256: "version-hash", conflictPolicy: "NEW_VERSION",
      columnSchema: { originalFileHashSha256: "hash" }
    })]), policy: "NEW_VERSION" })).resolves.toMatchObject({ batchId: "new" });
  });
  it("keeps partial and failed results distinct from full success", async () => {
    await expect(recoverMetaUpload(input(async () => [batch({ status: "PARTIAL", errorCount: 2 })])))
      .resolves.toMatchObject({ status: "PARTIAL", errorCount: 2 });
    await expect(recoverMetaUpload(input(async () => [batch({ status: "FAILED" })])))
      .rejects.toThrow("업로드 검증 또는 저장에 실패");
  });
  it("stops on authorization failure and bounds temporary outages", async () => {
    const denied = new ApiError(403, "denied");
    await expect(recoverMetaUpload(input(async () => { throw denied; }))).rejects.toBe(denied);
    const unavailable = vi.fn(async () => { throw new ApiError(503, "busy"); });
    await expect(recoverMetaUpload(input(unavailable))).rejects.toThrow(UPLOAD_RESULT_UNKNOWN);
    expect(unavailable).toHaveBeenCalledTimes(3);
  });
  it("refuses ambiguous concurrent imports", async () => {
    await expect(recoverMetaUpload(input(async () => [batch(), batch({ id: "new-2" })])))
      .rejects.toThrow(UPLOAD_RESULT_UNKNOWN);
  });
  it("sends the file only once when a 502 response is followed by successful commit", async () => {
    const file = new File(["csv-data"], "ads.csv", { type: "text/csv" });
    const hash = createHash("sha256").update("csv-data").digest("hex");
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(new Response("gateway failed", { status: 502 }))
      .mockResolvedValueOnce(Response.json([batch({ fileHashSha256: hash })]));
    vi.stubGlobal("fetch", fetch);
    const recovering = vi.fn();
    await expect(uploadCsv(file, "SKIP", recovering)).resolves.toMatchObject({ status: "IMPORTED" });
    expect(recovering).toHaveBeenCalledOnce();
    expect(fetch.mock.calls.filter(([, options]) => options.method === "POST")).toHaveLength(1);
  });
});
