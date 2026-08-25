import { describe, expect, it } from "vitest";
import { loadHttpSecurityConfig, validateRuntimeEnvironment } from "./http-security.config";

const base = {
  APP_ENV: "development",
  DATABASE_URL: "postgresql://app:password@127.0.0.1:55432/dev?schema=dev",
  PORT: "4200",
  STORAGE_PROVIDER: "local",
  UPLOAD_STORAGE_DIR: "./storage/security-dev/uploads",
  REPORT_STORAGE_DIR: "./storage/security-dev/reports",
  SUPABASE_URL: "https://ehnfrrmbkvlsbpvqcvkr.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test-key",
  SUPABASE_SECRET_KEY: "sb_secret_test-key",
  SUPABASE_JWT_ISSUER: "https://ehnfrrmbkvlsbpvqcvkr.supabase.co/auth/v1",
  SUPABASE_JWT_AUDIENCE: "authenticated",
  AUTH_COOKIE_SECURE: "false",
  AUTH_SESSION_HANDLE_SECRET: "4f68a2417e7c4fb7bf0663649c671b91406f6d7986061527f5e84a7894b6e45f",
  AUTH_CSRF_SECRET: "7c778290a780dd14e507ef0282c50aa5f6ee4d955e13ab76d19714226520ca44",
  APP_ALLOWED_ORIGINS: "http://localhost:3200",
  INTERNAL_PROBE_TOKEN: "aa35e635992217a3295b8690b6c4f01eeb3e6e309ebf9a9e7eb86c42e0f2cf9d"
};

describe("runtime environment validation", () => {
  it("normalizes bounded defaults without returning secret values in failures", () => {
    expect(validateRuntimeEnvironment(base)).toMatchObject({
      PORT: "4200",
      TRUST_PROXY_HOPS: "0",
      JSON_BODY_LIMIT_BYTES: "262144",
      URLENCODED_BODY_LIMIT_BYTES: "65536"
    });
    expect(loadHttpSecurityConfig({ ...base, TRUST_PROXY_HOPS: "3" })).toMatchObject({
      trustProxyHops: 3,
      production: false
    });
  });

  it("rejects unbounded proxy trust, unsafe storage roots, and secret reuse", () => {
    expect(() => validateRuntimeEnvironment({ ...base, TRUST_PROXY_HOPS: "99" }))
      .toThrow("TRUST_PROXY_HOPS must be between 0 and 3");
    expect(() => validateRuntimeEnvironment({ ...base, UPLOAD_STORAGE_DIR: process.cwd() }))
      .toThrow("UPLOAD_STORAGE_DIR must be a scoped directory");
    expect(() => validateRuntimeEnvironment({
      ...base,
      INTERNAL_PROBE_TOKEN: base.AUTH_CSRF_SECRET
    })).toThrow("independently generated secret");
  });

  it("allows only a fully configured Supabase private-storage adapter", () => {
    expect(() => validateRuntimeEnvironment({ ...base, STORAGE_PROVIDER: "supabase" }))
      .toThrow("SUPABASE_STORAGE_BUCKET is required");
    expect(validateRuntimeEnvironment({
      ...base,
      STORAGE_PROVIDER: "supabase",
      SUPABASE_STORAGE_BUCKET: "security-step7-dev-private",
      SUPABASE_STORAGE_RETENTION_DAYS: "30",
      SUPABASE_STORAGE_TIMEOUT_MS: "15000",
      SUPABASE_STORAGE_MAX_OBJECT_BYTES: "52428800"
    })).toMatchObject({
      STORAGE_PROVIDER: "supabase",
      SUPABASE_STORAGE_RETENTION_DAYS: "30"
    });
    expect(() => validateRuntimeEnvironment({
      ...base,
      STORAGE_PROVIDER: "supabase",
      SUPABASE_STORAGE_BUCKET: "../outside"
    })).toThrow("valid private bucket id");
    expect(() => validateRuntimeEnvironment({ ...base, STORAGE_PROVIDER: "s3" }))
      .toThrow("STORAGE_PROVIDER must be local or supabase");
  });

  it("STEP7-EVAL-001 fails startup for invalid or upward upload-limit overrides", () => {
    expect(() => validateRuntimeEnvironment({ ...base, UPLOAD_META_MAX_FILE_BYTES: "invalid-secret-like-value" }))
      .toThrow("UPLOAD_META_MAX_FILE_BYTES must be an integer");
    expect(() => validateRuntimeEnvironment({ ...base, UPLOAD_MAX_XLSX_ENTRIES: "2049" }))
      .toThrow("UPLOAD_MAX_XLSX_ENTRIES must be between 8 and 2048");
    expect(() => validateRuntimeEnvironment({ ...base, UPLOAD_COUPANG_BUNDLE_MAX_TOTAL_BYTES: "999999999" }))
      .toThrow("UPLOAD_COUPANG_BUNDLE_MAX_TOTAL_BYTES must be between");
    expect(() => validateRuntimeEnvironment({ ...base, UPLOAD_MAX_TEXT_ROWS: "50000" }))
      .not.toThrow();
  });

  it("fails production startup for insecure cookies, origins, or database TLS", () => {
    expect(() => validateRuntimeEnvironment({ ...base, APP_ENV: "production" }))
      .toThrow("AUTH_COOKIE_SECURE must be true");
    const production = {
      ...base,
      APP_ENV: "production",
      AUTH_COOKIE_SECURE: "true",
      APP_ALLOWED_ORIGINS: "https://app.example.com"
    };
    expect(() => validateRuntimeEnvironment(production))
      .toThrow("DATABASE_URL must require TLS");
    expect(validateRuntimeEnvironment({
      ...production,
      DATABASE_URL: `${base.DATABASE_URL}&sslmode=verify-full`
    })).toMatchObject({ APP_ENV: "production" });
  });
});
