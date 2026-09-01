import { ConfigService } from "@nestjs/config";
import path from "node:path";
import { FileStorage } from "./file-storage";
import { LocalFileStorage } from "./local-file-storage";
import { SupabaseFileStorage } from "./supabase-file-storage";
import { defaultApplicationDataRoot } from "../common/http-security.config";

export type StorageDomain = "uploads" | "reports";

export function configuredFileStorage(config: ConfigService, domain: StorageDomain): FileStorage {
  const provider = (config.get<string>("STORAGE_PROVIDER") ?? "local").trim().toLowerCase();
  return configuredFileStorageForProvider(config, domain, provider);
}

export function configuredFileStorageForProvider(
  config: ConfigService,
  domain: StorageDomain,
  provider: string
): FileStorage {
  const configuredProvider = (config.get<string>("STORAGE_PROVIDER") ?? "local").trim().toLowerCase();
  if (provider !== configuredProvider) {
    throw new Error("The stored object provider is not configured for access.");
  }
  if (provider === "supabase") {
    const accessMode = (config.get<string>("SUPABASE_STORAGE_ACCESS_MODE") ?? "admin")
      .trim()
      .toLowerCase();
    if (accessMode !== "admin" && accessMode !== "rls") {
      throw new Error("SUPABASE_STORAGE_ACCESS_MODE must be admin or rls.");
    }
    return new SupabaseFileStorage({
      supabaseUrl: required(config, "SUPABASE_URL"),
      apiKey: required(config, "SUPABASE_PUBLISHABLE_KEY"),
      accessToken: accessMode === "rls"
        ? required(config, "SUPABASE_STORAGE_ACCESS_TOKEN")
        : required(config, "SUPABASE_SECRET_KEY"),
      bucket: required(config, "SUPABASE_STORAGE_BUCKET"),
      domain,
      timeoutMs: numeric(config, "SUPABASE_STORAGE_TIMEOUT_MS", 15_000),
      maxObjectBytes: numeric(config, "SUPABASE_STORAGE_MAX_OBJECT_BYTES", 52_428_800),
      temporaryStorageBudgetBytes: numeric(
        config,
        "TEMP_STORAGE_BUDGET_BYTES",
        104_857_600
      )
    });
  }
  if (provider !== "local") {
    throw new Error("The configured storage provider does not have an approved adapter.");
  }
  const key = domain === "uploads" ? "UPLOAD_STORAGE_DIR" : "REPORT_STORAGE_DIR";
  const dataRoot = config.get<string>("APP_DATA_ROOT")?.trim() || defaultApplicationDataRoot();
  const fallback = path.join(dataRoot, "storage", domain);
  return new LocalFileStorage(path.resolve(config.get<string>(key) ?? fallback));
}

function required(config: ConfigService, key: string) {
  const value = config.get<string>(key)?.trim();
  if (!value) throw new Error(`${key} is required for Supabase Storage.`);
  return value;
}

function numeric(config: ConfigService, key: string, fallback: number) {
  const value = config.get<string>(key)?.trim();
  return value ? Number(value) : fallback;
}
