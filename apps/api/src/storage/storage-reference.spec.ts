import path from "node:path";
import { describe, expect, it } from "vitest";
import { InvalidStorageKeyError } from "./file-storage";
import {
  legacyLocalPathToKey,
  parseStorageReference,
  storageReference
} from "./storage-reference";

describe("storage references", () => {
  it("round-trips an explicit provider and opaque server key", () => {
    const value = storageReference("local", "2026/08/server-id.csv");
    expect(value).toBe("local:2026/08/server-id.csv");
    expect(parseStorageReference(value)).toEqual({ provider: "local", key: "2026/08/server-id.csv" });
  });

  it("treats old workspace paths as legacy rather than provider references", () => {
    expect(parseStorageReference("apps/api/storage/reports/2026/08/report.xlsx")).toBeNull();
  });

  it("converts only a contained legacy local path to a key", () => {
    const storageRoot = path.resolve(process.cwd(), "apps/api/storage/security-dev/reports");
    const legacy = path.join(storageRoot, "2026", "08", "report.xlsx");

    expect(legacyLocalPathToKey(legacy, storageRoot)).toBe("2026/08/report.xlsx");
    expect(() => legacyLocalPathToKey(path.resolve(storageRoot, "..", "outside.xlsx"), storageRoot))
      .toThrow(InvalidStorageKeyError);
  });
});
