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
  AUTH_AUTHORIZATION_VERSION_SECRET: "8b3ca7f1a62e49cd9058d27e183bfa645e71c328f4a09d6be2c7351f680ad942",
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
      AUTH_COOKIE_NAMESPACE: "staging",
      APP_ALLOWED_ORIGINS: "http://app.example.com"
    })).toThrow("must use HTTPS");
  });

  it("requires isolated production cookie names and validates rotation secrets", () => {
    const production = {
      ...base,
      APP_ENV: "production",
      AUTH_COOKIE_SECURE: "true",
      APP_ALLOWED_ORIGINS: "https://app.example.com"
    };
    expect(() => loadAuthConfig(production)).toThrow("AUTH_COOKIE_NAMESPACE is required");
    expect(loadAuthConfig({ ...production, AUTH_COOKIE_NAMESPACE: "staging" }).cookieNamespace)
      .toBe("staging");
    expect(loadAuthConfig({
      ...base,
      AUTH_SESSION_HANDLE_PREVIOUS_SECRET:
        "9f4ed0f2db7d4cf297b49e031a8252505302a130311512c12510eb622c0c45a1",
      AUTH_CSRF_PREVIOUS_SECRET:
        "da2ea2a82eaf41aeab96115243784e2c23c11df80f9fbf95d4131e6e8f8c2a0e"
    })).toMatchObject({
      sessionHandlePreviousSecret: expect.any(String),
      csrfPreviousSecret: expect.any(String)
    });
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

  it("loads local native Auth without any Supabase endpoint or key", () => {
    const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY,
      SUPABASE_JWT_ISSUER, SUPABASE_JWT_AUDIENCE, ...common } = base;
    const local = loadAuthConfig({
      ...common,
      AUTH_PROVIDER: "local",
      APP_ENV: "production",
      AUTH_COOKIE_SECURE: "true",
      AUTH_COOKIE_NAMESPACE: "local-prod",
      APP_ALLOWED_ORIGINS: "https://127.0.0.1:3200",
      AUTH_LOCAL_SESSION_TOKEN_SECRET: "b6a9d3f4187c2e9051ab6d7f830c4e92a5b8d1f6073c9e41a6b2d8f5071c3e94",
      AUTH_LOCAL_SETUP_TOKEN_SECRET: "c7b0e4a5298d3f0162bc7e8a941d5f03b6c9e2a7184d0f52b7c3e9a6182d4f05",
      AUTH_LOCAL_RATE_LIMIT_SECRET: "d8c1f5b6309e4a1273cd8f9b052e6a14c7d0f3b8295e1a63c8d4f0b7293e5a16"
    });
    expect(local).toMatchObject({ provider: "local", supabaseUrl: "", jwtIssuer: "" });
    expect(local.allowedOrigins.has("https://127.0.0.1:3200")).toBe(true);
  });

  it("rejects local session rotation beyond the absolute lifetime", () => {
    const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY,
      SUPABASE_JWT_ISSUER, SUPABASE_JWT_AUDIENCE, ...common } = base;
    expect(() => loadAuthConfig({
      ...common, AUTH_PROVIDER: "local", APP_ENV: "production", AUTH_COOKIE_SECURE: "true",
      AUTH_COOKIE_NAMESPACE: "local-prod", APP_ALLOWED_ORIGINS: "https://127.0.0.1:3200",
      AUTH_LOCAL_SESSION_TOKEN_SECRET: "b6a9d3f4187c2e9051ab6d7f830c4e92a5b8d1f6073c9e41a6b2d8f5071c3e94",
      AUTH_LOCAL_SETUP_TOKEN_SECRET: "c7b0e4a5298d3f0162bc7e8a941d5f03b6c9e2a7184d0f52b7c3e9a6182d4f05",
      AUTH_LOCAL_RATE_LIMIT_SECRET: "d8c1f5b6309e4a1273cd8f9b052e6a14c7d0f3b8295e1a63c8d4f0b7293e5a16",
      AUTH_LOCAL_SESSION_ABSOLUTE_HOURS: "1", AUTH_LOCAL_SESSION_ROTATION_MINUTES: "120"
    })).toThrow("must not exceed the absolute session lifetime");
  });
});
