import { describe, expect, it } from "vitest";
import { loadAuthConfig } from "./auth.config";

const base = {
  APP_ENV: "development",
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "publishable",
  SUPABASE_SECRET_KEY: "secret-key",
  SUPABASE_JWT_ISSUER: "https://project.supabase.co/auth/v1",
  SUPABASE_JWT_AUDIENCE: "authenticated",
  AUTH_COOKIE_SECURE: "false",
  AUTH_SESSION_HANDLE_SECRET: "4f68a2417e7c4fb7bf0663649c671b91406f6d7986061527f5e84a7894b6e45f",
  AUTH_CSRF_SECRET: "7c778290a780dd14e507ef0282c50aa5f6ee4d955e13ab76d19714226520ca44",
  APP_ALLOWED_ORIGINS: "http://localhost:3200"
};

describe("auth config", () => {
  it("uses exact origins and rejects wildcard entries", () => {
    expect(loadAuthConfig(base).allowedOrigins.has("http://localhost:3200")).toBe(true);
    expect(() => loadAuthConfig({ ...base, APP_ALLOWED_ORIGINS: "http://*.example.com" }))
      .toThrow("wildcards");
  });

  it("requires Secure cookies and non-local origins in production", () => {
    expect(() => loadAuthConfig({ ...base, APP_ENV: "production" })).toThrow(
      "AUTH_COOKIE_SECURE must be true"
    );
    expect(() => loadAuthConfig({
      ...base,
      APP_ENV: "production",
      AUTH_COOKIE_SECURE: "true"
    })).toThrow("cannot contain localhost");
    expect(() => loadAuthConfig({
      ...base,
      APP_ENV: "production",
      AUTH_COOKIE_SECURE: "true",
      APP_ALLOWED_ORIGINS: "http://app.example.com"
    })).toThrow("must use HTTPS");
  });

  it("rejects environment disagreement and secret reuse", () => {
    expect(() => loadAuthConfig({ ...base, NODE_ENV: "production" })).toThrow("must not disagree");
    expect(() => loadAuthConfig({ ...base, AUTH_SESSION_HANDLE_SECRET: "a".repeat(64) }))
      .toThrow("high-entropy");
    expect(() => loadAuthConfig({ ...base, AUTH_CSRF_SECRET: base.AUTH_SESSION_HANDLE_SECRET }))
      .toThrow("must be different");
    expect(() => loadAuthConfig({
      ...base,
      SUPABASE_SECRET_KEY: base.AUTH_SESSION_HANDLE_SECRET
    })).toThrow("must not reuse Supabase provider keys");
  });
});
