import { StorageProviderUnavailableError } from "./file-storage";

export const DEFAULT_TEMP_STORAGE_BUDGET_BYTES = 104_857_600;

class TemporaryStorageBudget {
  private reservedBytes = 0;
  private activeLeases = 0;

  acquire(bytes: number, budgetBytes = DEFAULT_TEMP_STORAGE_BUDGET_BYTES) {
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      !Number.isSafeInteger(budgetBytes) ||
      budgetBytes < 1 ||
      bytes > budgetBytes ||
      this.reservedBytes + bytes > budgetBytes ||
      this.activeLeases >= 2
    ) {
      throw new StorageProviderUnavailableError();
    }
    this.reservedBytes += bytes;
    this.activeLeases += 1;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.reservedBytes -= bytes;
        this.activeLeases -= 1;
      }
    };
  }
}

export const temporaryStorageBudget = new TemporaryStorageBudget();
