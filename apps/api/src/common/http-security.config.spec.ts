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
