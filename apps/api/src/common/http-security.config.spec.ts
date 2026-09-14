import { describe, expect, it } from "vitest";
import { loadHttpSecurityConfig, validateRuntimeEnvironment } from "./http-security.config";

const base = {
  APP_ENV: "development",
  DATABASE_URL: "postgresql://app:password@db.abcdefghijklmnopqrst.supabase.co:5432/dev?schema=dev",
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
  AUTH_AUTHORIZATION_VERSION_SECRET: "8b3ca7f1a62e49cd9058d27e183bfa645e71c328f4a09d6be2c7351f680ad942",
  AUTH_CSRF_SECRET: "7c778290a780dd14e507ef0282c50aa5f6ee4d955e13ab76d19714226520ca44",
  APP_ALLOWED_ORIGINS: "http://localhost:3200",
  INTERNAL_PROBE_TOKEN: "aa35e635992217a3295b8690b6c4f01eeb3e6e309ebf9a9e7eb86c42e0f2cf9d"
};

const production = {
  ...base,
  APP_ENV: "production",
  DEPLOYMENT_MODE: "cloud_container",
  AUTH_PROVIDER: "supabase",
  AUTH_COOKIE_SECURE: "true",
  AUTH_COOKIE_NAMESPACE: "staging",
  APP_ALLOWED_ORIGINS: "https://app.example.com",
  AUTH_INVITE_REDIRECT_ORIGIN: "https://app.example.com",
  DATABASE_URL: "postgresql://app:password@db.ehnfrrmbkvlsbpvqcvkr.supabase.co:5432/postgres?schema=public&sslmode=verify-full&connection_limit=2",
  SUPABASE_DATABASE_PROJECT_REF: "ehnfrrmbkvlsbpvqcvkr",
  SUPABASE_DATABASE_CONNECTION_MODE: "direct",
  SUPABASE_DATABASE_HOST: "db.ehnfrrmbkvlsbpvqcvkr.supabase.co",
  SUPABASE_DATABASE_RUNTIME_USER: "app",
  SUPABASE_DATABASE_NAME: "postgres",
  SUPABASE_DATABASE_SCHEMA: "public",
  TRUST_PROXY_HOPS: "1",
  PRISMA_CONNECTION_LIMIT: "2",
  HEAVY_OPERATION_CONCURRENCY: "1",
  RELEASE_GIT_SHA: "25748e71a95a09990968e0f198c5fd877897dc88",
  UPLOAD_STORAGE_DIR: "",
  REPORT_STORAGE_DIR: "",
  STORAGE_PROVIDER: "supabase",
  SUPABASE_STORAGE_BUCKET: "security-step8-staging-private",
  SUPABASE_STORAGE_ACCESS_MODE: "rls",
  SUPABASE_STORAGE_ACCESS_TOKEN: syntheticStorageJwt(7 * 24 * 60 * 60),
  SUPABASE_STORAGE_TOKEN_SUBJECT: "synthetic-storage-staging",
  SUPABASE_STORAGE_READINESS_KEY: "health/readiness-sentinel",
  DEPLOYMENT_ENVIRONMENT_ID: "staging",
  RUNTIME_API_TARGET_ID: "staging-api",
  RUNTIME_DATABASE_ID: "staging-db",
  RUNTIME_STORAGE_ID: "staging-storage"
};

describe("runtime environment validation", () => {
  it("normalizes bounded defaults without returning secret values in failures", () => {
    expect(validateRuntimeEnvironment(base)).toMatchObject({
      PORT: "4200",
      TRUST_PROXY_HOPS: "0",
      DATABASE_READINESS_TIMEOUT_MS: "1000",
      JSON_BODY_LIMIT_BYTES: "262144",
      URLENCODED_BODY_LIMIT_BYTES: "65536"
    });
    expect(loadHttpSecurityConfig({ ...base, TRUST_PROXY_HOPS: "3" })).toMatchObject({
      trustProxyHops: 3,
      production: false
    });
  });

  it("requires the database-side readiness deadline below the overall deadline", () => {
    expect(() => validateRuntimeEnvironment({
      ...base,
      READINESS_TIMEOUT_MS: "1000",
      DATABASE_READINESS_TIMEOUT_MS: "1000"
    })).toThrow("must be lower than READINESS_TIMEOUT_MS");
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
      SUPABASE_STORAGE_ACCESS_MODE: "admin",
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
    expect(() => validateRuntimeEnvironment({
      ...production,
      AUTH_COOKIE_SECURE: "false"
    })).toThrow("AUTH_COOKIE_SECURE must be true");
    expect(() => validateRuntimeEnvironment({
      ...production,
      DATABASE_URL: `${base.DATABASE_URL}&sslmode=require`
    })).toThrow("sslmode=verify-full");
    expect(() => validateRuntimeEnvironment({
      ...production,
      DATABASE_URL: `${base.DATABASE_URL}&sslmode=verify-full&sslmode=disable`
    })).toThrow("sslmode=verify-full");
    expect(validateRuntimeEnvironment(production)).toMatchObject({
      APP_ENV: "production",
      DEPLOYMENT_MODE: "cloud_container",
      PRISMA_CONNECTION_LIMIT: "2",
      HEAVY_OPERATION_CONCURRENCY: "1",
      RELEASE_GIT_SHA: "25748e71a95a09990968e0f198c5fd877897dc88",
      DEPLOYMENT_ENVIRONMENT_ID: "staging",
      RUNTIME_CONFIG_FINGERPRINT: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
    expect(() => validateRuntimeEnvironment({
      ...production,
      DEPLOYMENT_MODE: "legacy"
    })).toThrow("Production DEPLOYMENT_MODE must be explicitly");
    expect(() => validateRuntimeEnvironment({
      ...production,
      RELEASE_GIT_SHA: "25748e7"
    })).toThrow("must be a full 40-character SHA-1 or 64-character SHA-256");
  });

  it("accepts three cloud connections when the URL matches and uploads remain serialized", () => {
    expect(validateRuntimeEnvironment({
      ...production,
      PRISMA_CONNECTION_LIMIT: "3",
      DATABASE_URL: production.DATABASE_URL.replace("connection_limit=2", "connection_limit=3")
    })).toMatchObject({
      PRISMA_CONNECTION_LIMIT: "3",
      HEAVY_OPERATION_CONCURRENCY: "1"
    });
  });

  it("resolves an empty APP_ENV consistently from NODE_ENV", () => {
    expect(loadHttpSecurityConfig({ ...production, APP_ENV: "", NODE_ENV: "production" }))
      .toMatchObject({ production: true });
    expect(validateRuntimeEnvironment({ ...production, APP_ENV: "", NODE_ENV: "production" }))
      .toMatchObject({ APP_ENV: "" });
  });

  it("rejects Supabase Auth and Storage settings in local_lan mode", () => {
    const local = {
      ...base,
      DEPLOYMENT_MODE: "local_lan",
      AUTH_PROVIDER: "local",
      SUPABASE_URL: "https://unused.example.invalid"
    };
    expect(() => validateRuntimeEnvironment(local))
      .toThrow("local_lan rejects Supabase Auth and Storage configuration");
  });

  it("fails closed when cloud_container selects local providers or local paths", () => {
    expect(() => validateRuntimeEnvironment({
      ...production,
      AUTH_PROVIDER: "local"
    })).toThrow("requires explicit AUTH_PROVIDER=supabase");
    expect(() => validateRuntimeEnvironment({
      ...production,
      STORAGE_PROVIDER: "local"
    })).toThrow("requires explicit STORAGE_PROVIDER=supabase");
    expect(() => validateRuntimeEnvironment({
      ...production,
      APP_DATA_ROOT: "D:\\MetaAdsData"
    })).toThrow("rejects local-only configuration key APP_DATA_ROOT");
    expect(() => validateRuntimeEnvironment({
      ...production,
      PRISMA_CONNECTION_LIMIT: ""
    })).toThrow("requires explicit PRISMA_CONNECTION_LIMIT");
    expect(() => validateRuntimeEnvironment({
      ...production,
      HEAVY_OPERATION_CONCURRENCY: "2"
    })).toThrow("requires HEAVY_OPERATION_CONCURRENCY=1");
    expect(() => validateRuntimeEnvironment({
      ...production,
      SUPABASE_DATABASE_PROJECT_REF: "abcdefghijklmnopqrst"
    })).toThrow("project ref");
    expect(() => validateRuntimeEnvironment({
      ...production,
      SUPABASE_DATABASE_CA_CERT_PATH: "C:\\private-ca.pem"
    })).toThrow("rejects local-only configuration key SUPABASE_DATABASE_CA_CERT_PATH");
    expect(() => validateRuntimeEnvironment({
      ...production,
      AUTH_LOCAL_SESSION_IDLE_MINUTES: "30"
    })).toThrow("rejects local-only configuration key AUTH_LOCAL_SESSION_IDLE_MINUTES");
    expect(() => validateRuntimeEnvironment({
      ...production,
      LOCAL_RELEASE_ID: "historical-local-release"
    })).toThrow("rejects local-only configuration key LOCAL_RELEASE_ID");
    expect(() => validateRuntimeEnvironment({
      ...production,
      DATABASE_URL: production.DATABASE_URL.replace("connection_limit=2", "connection_limit=3")
    })).toThrow("connection_limit must equal PRISMA_CONNECTION_LIMIT");
    expect(() => validateRuntimeEnvironment({
      ...production,
      DATABASE_URL: `${production.DATABASE_URL}&sslrootcert=%2Fprivate%2Fca.pem`
    })).toThrow("query parameter is not allowed");
    expect(() => validateRuntimeEnvironment({
      ...production,
      SUPABASE_DATABASE_SCHEMA: "drifted"
    })).toThrow("exact configured database and schema");
  });

  it("accepts the exact persistent Supabase session pooler target and rejects cross-project Auth", () => {
    expect(validateRuntimeEnvironment({
      ...production,
      DATABASE_URL: "postgresql://app.ehnfrrmbkvlsbpvqcvkr:password@aws-0-ap-northeast-2.pooler.supabase.com:5432/postgres?schema=public&sslmode=verify-full&connection_limit=2",
      SUPABASE_DATABASE_CONNECTION_MODE: "session_pooler",
      SUPABASE_DATABASE_HOST: "aws-0-ap-northeast-2.pooler.supabase.com"
    })).toMatchObject({ DEPLOYMENT_MODE: "cloud_container" });

    const otherIssuer = "https://abcdefghijklmnopqrst.supabase.co/auth/v1";
    expect(() => validateRuntimeEnvironment({
      ...production,
      SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
      SUPABASE_JWT_ISSUER: otherIssuer,
      SUPABASE_STORAGE_ACCESS_TOKEN: syntheticStorageJwt(7 * 24 * 60 * 60, { iss: otherIssuer })
    })).toThrow("database, Auth, and Storage must use the same Supabase project ref");
  });

  it("fails production startup without durable scoped Storage and explicit deployment identity", () => {
    expect(() => validateRuntimeEnvironment({ ...production, STORAGE_PROVIDER: "local" }))
      .toThrow("cloud_container requires explicit STORAGE_PROVIDER=supabase");
    expect(() => validateRuntimeEnvironment({
      ...production,
      SUPABASE_STORAGE_ACCESS_MODE: "admin"
    })).toThrow("must be rls");
    expect(() => validateRuntimeEnvironment({
      ...production,
      SUPABASE_SECRET_KEY: production.SUPABASE_STORAGE_ACCESS_TOKEN
    })).toThrow("independently managed");
    const { DEPLOYMENT_ENVIRONMENT_ID: _removed, ...missingIdentity } = production;
    expect(() => validateRuntimeEnvironment(missingIdentity))
      .toThrow("DEPLOYMENT_ENVIRONMENT_ID is required in production");
    expect(() => validateRuntimeEnvironment({
      ...production,
      SUPABASE_STORAGE_ACCESS_TOKEN: syntheticStorageJwt(60 * 60)
    })).toThrow("deployment overlap window");
    expect(() => validateRuntimeEnvironment({
      ...production,
      SUPABASE_STORAGE_ACCESS_TOKEN: syntheticStorageJwt(10 * 365 * 24 * 60 * 60)
    })).toThrow("maximum credential lifetime");
    expect(() => validateRuntimeEnvironment({
      ...production,
      SUPABASE_STORAGE_ACCESS_TOKEN: syntheticStorageJwt(7 * 24 * 60 * 60, {
        role: "service_role"
      })
    })).toThrow("least-privilege storage_app role");
    expect(() => validateRuntimeEnvironment({
      ...production,
      SUPABASE_STORAGE_MAX_OBJECT_BYTES: "52428801"
    })).toThrow("reserve two maximum Storage objects");
  });
});

function syntheticStorageJwt(
  ttlSeconds: number,
  overrides: Partial<Record<"iss" | "aud" | "sub" | "role", string>> = {}
) {
  const encoded = (value: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  return `${encoded({ alg: "HS256", typ: "JWT" })}.${encoded({
    iss: base.SUPABASE_JWT_ISSUER,
    aud: base.SUPABASE_JWT_AUDIENCE,
    sub: "synthetic-storage-staging",
    role: "storage_app",
    exp: Math.floor(Date.now() / 1_000) + ttlSeconds,
    ...overrides
  })}.synthetic-signature`;
}
