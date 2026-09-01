import { ConfigService } from "@nestjs/config";
import { describe, expect, it } from "vitest";
import { configuredFileStorageForProvider } from "./configured-file-storage";

describe("configuredFileStorageForProvider", () => {
  it("never opens historical local references while Supabase is configured", () => {
    const config = new ConfigService({ STORAGE_PROVIDER: "supabase" });
    expect(() => configuredFileStorageForProvider(config, "reports", "local"))
      .toThrow("stored object provider is not configured");
  });

  it("never opens Supabase references while local Storage is configured", () => {
    const config = new ConfigService({ STORAGE_PROVIDER: "local" });
    expect(() => configuredFileStorageForProvider(config, "uploads", "supabase"))
      .toThrow("stored object provider is not configured");
  });
});
