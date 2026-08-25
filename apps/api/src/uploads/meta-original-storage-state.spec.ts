import { UploadStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  acquireMetaUploadMutationFence,
  isRetryableMetaOriginalStoragePending,
  metaOriginalFileHashSha256,
  pendingMetaOriginalStorageSchema,
  storedMetaOriginalStorageSchema
} from "./meta-original-storage-state";

describe("Meta original storage marker", () => {
  const domain = "META_AD_DAILY" as const;
  const expiredPending = pendingMetaOriginalStorageSchema(
    {}, domain, new Date(0), "00000000-0000-4000-8000-000000000003"
  );
  const freshPending = pendingMetaOriginalStorageSchema(
    {}, domain, new Date(), "00000000-0000-4000-8000-000000000004"
  );
  const expiredStored = storedMetaOriginalStorageSchema(expiredPending, domain);

  it("retries a storage failure immediately and a crashed VALIDATING lease only after expiry", () => {
    expect(isRetryableMetaOriginalStoragePending(freshPending, domain, UploadStatus.FAILED)).toBe(true);
    expect(isRetryableMetaOriginalStoragePending(freshPending, domain, UploadStatus.VALIDATING)).toBe(false);
    expect(isRetryableMetaOriginalStoragePending(expiredPending, domain, UploadStatus.VALIDATING)).toBe(true);
    expect(isRetryableMetaOriginalStoragePending(expiredStored, domain, UploadStatus.VALIDATING)).toBe(true);
  });

  it("does not reinterpret a STORED domain-validation failure as storage-pending", () => {
    expect(isRetryableMetaOriginalStoragePending(expiredStored, domain, UploadStatus.FAILED)).toBe(false);
  });

  it("uses the original byte hash for duplicate-policy batches and falls back only for legacy schemas", () => {
    const originalHash = "a".repeat(64);
    const uniquenessHash = "b".repeat(64);

    expect(metaOriginalFileHashSha256({ originalFileHashSha256: originalHash }, uniquenessHash)).toBe(originalHash);
    expect(metaOriginalFileHashSha256({}, uniquenessHash)).toBe(uniquenessHash);
    expect(() => metaOriginalFileHashSha256({ originalFileHashSha256: "invalid" }, uniquenessHash)).toThrow(
      "integrity check"
    );
  });

  it("acquires a transaction-scoped advisory fence without a database lock timeout", async () => {
    const executeRawUnsafe = vi.fn(async () => 0);
    const queryRaw = vi.fn(async (_query: unknown) => []);

    await acquireMetaUploadMutationFence({
      $executeRawUnsafe: executeRawUnsafe,
      $queryRaw: queryRaw
    } as never, "batch-1");

    expect(executeRawUnsafe.mock.calls).toEqual([
      ["SET LOCAL lock_timeout = 0"],
      ["SET LOCAL statement_timeout = 0"]
    ]);
    expect(queryRaw).toHaveBeenCalledOnce();
    expect(queryRaw.mock.calls[0]?.[0]).toMatchObject({
      strings: expect.arrayContaining([
        expect.stringContaining("pg_advisory_xact_lock")
      ]),
      values: ["meta-upload-batch:batch-1"]
    });
  });
});
