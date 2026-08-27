import { describe, expect, it } from "vitest";
import { StorageProviderUnavailableError } from "./file-storage";
import { temporaryStorageBudget } from "./temporary-storage-budget";

describe("shared temporary storage budget", () => {
  it("fails closed instead of queuing a third spool and releases leases idempotently", () => {
    const first = temporaryStorageBudget.acquire(40, 100);
    const second = temporaryStorageBudget.acquire(40, 100);
    expect(() => temporaryStorageBudget.acquire(1, 100))
      .toThrow(StorageProviderUnavailableError);
    first.release();
    first.release();
    const replacement = temporaryStorageBudget.acquire(60, 100);
    expect(() => temporaryStorageBudget.acquire(1, 100))
      .toThrow(StorageProviderUnavailableError);
    second.release();
    replacement.release();
  });

  it("rejects a reservation that exceeds the byte budget", () => {
    expect(() => temporaryStorageBudget.acquire(101, 100))
      .toThrow(StorageProviderUnavailableError);
  });
});
