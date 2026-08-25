import { ConfigService } from "@nestjs/config";
import path from "node:path";
import { FileStorage } from "./file-storage";
import { LocalFileStorage } from "./local-file-storage";
import { SupabaseFileStorage } from "./supabase-file-storage";

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
  if (provider === "supabase") {
    const configuredProvider = (config.get<string>("STORAGE_PROVIDER") ?? "local").trim().toLowerCase();
    if (configuredProvider !== "supabase") {
      throw new Error("The stored object provider is not configured for access.");
    }
    return new SupabaseFileStorage({
      supabaseUrl: required(config, "SUPABASE_URL"),
      secretKey: required(config, "SUPABASE_SECRET_KEY"),
      bucket: required(config, "SUPABASE_STORAGE_BUCKET"),
      domain,
      timeoutMs: numeric(config, "SUPABASE_STORAGE_TIMEOUT_MS", 15_000),
      maxObjectBytes: numeric(config, "SUPABASE_STORAGE_MAX_OBJECT_BYTES", 52_428_800)
    });
  }
  if (provider !== "local") {
    throw new Error("The configured storage provider does not have an approved adapter.");
  }
  const key = domain === "uploads" ? "UPLOAD_STORAGE_DIR" : "REPORT_STORAGE_DIR";
  const fallback = domain === "uploads" ? "./storage/uploads" : "./storage/reports";
  return new LocalFileStorage(path.resolve(process.cwd(), config.get<string>(key) ?? fallback));
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
