import { homedir } from "node:os";
import path from "node:path";
import { loadAuthConfig } from "../auth/auth.config";

export const HTTP_SECURITY_CONFIG = Symbol("HTTP_SECURITY_CONFIG");

export type HttpSecurityConfig = {
  production: boolean;
  trustProxyHops: number;
  internalProbeToken: string;
  readinessTimeoutMs: number;
  jsonBodyLimitBytes: number;
  urlencodedBodyLimitBytes: number;
};

export function loadHttpSecurityConfig(
  env: NodeJS.ProcessEnv = process.env
): HttpSecurityConfig {
  const appEnvironment = normalizedEnvironment(env.APP_ENV ?? env.NODE_ENV);
  return {
    production: appEnvironment === "production",
    trustProxyHops: boundedInteger(env.TRUST_PROXY_HOPS, "TRUST_PROXY_HOPS", 0, 3, 0),
    internalProbeToken: strongSecret(env.INTERNAL_PROBE_TOKEN, "INTERNAL_PROBE_TOKEN"),
    readinessTimeoutMs: boundedInteger(
      env.READINESS_TIMEOUT_MS,
      "READINESS_TIMEOUT_MS",
      250,
      5_000,
      1_500
    ),
    jsonBodyLimitBytes: boundedInteger(
      env.JSON_BODY_LIMIT_BYTES,
      "JSON_BODY_LIMIT_BYTES",
      16_384,
      2_097_152,
      262_144
    ),
    urlencodedBodyLimitBytes: boundedInteger(
      env.URLENCODED_BODY_LIMIT_BYTES,
      "URLENCODED_BODY_LIMIT_BYTES",
      4_096,
      262_144,
      65_536
    )
  };
}

/** ConfigModule validation entrypoint. It deliberately reports names, never values. */
export function validateRuntimeEnvironment(
  input: Record<string, unknown>
): Record<string, unknown> {
  const env = Object.fromEntries(
    Object.entries(input).map(([key, value]) => [key, value === undefined ? undefined : String(value)])
  ) as NodeJS.ProcessEnv;
  // Vitest sets NODE_ENV=test while loading the isolated development .env.
  // Both are explicitly non-production; APP_ENV remains the deployment source.
  if (env.NODE_ENV === "test" && env.APP_ENV === "development") {
    delete env.NODE_ENV;
  }
  const auth = loadAuthConfig(env);
  const http = loadHttpSecurityConfig(env);

  const port = boundedInteger(env.PORT, "PORT", 1, 65_535, 4_000);
  const database = requiredUrl(env.DATABASE_URL, "DATABASE_URL");
  if (database.protocol !== "postgresql:" && database.protocol !== "postgres:") {
    throw new Error("DATABASE_URL must use PostgreSQL.");
  }
  if (auth.production && !["require", "verify-ca", "verify-full"].includes(
    database.searchParams.get("sslmode") ?? ""
  )) {
    throw new Error("Production DATABASE_URL must require TLS certificate validation.");
  }

  if (auth.supabasePublishableKey === auth.supabaseSecretKey) {
    throw new Error("Supabase publishable and secret keys must be different.");
  }
  if (auth.supabasePublishableKey.startsWith("sb_secret_") ||
      auth.supabaseSecretKey.startsWith("sb_publishable_")) {
    throw new Error("Supabase publishable and secret key variables are reversed.");
  }
  if (auth.sessionHandleSecret === http.internalProbeToken ||
      auth.csrfSecret === http.internalProbeToken ||
      auth.supabasePublishableKey === http.internalProbeToken ||
      auth.supabaseSecretKey === http.internalProbeToken) {
    throw new Error("INTERNAL_PROBE_TOKEN must be an independently generated secret.");
  }

  const storageProvider = (env.STORAGE_PROVIDER?.trim() || "local").toLowerCase();
  if (storageProvider !== "local") {
    throw new Error("STORAGE_PROVIDER is unsupported until the storage adapter is configured.");
  }
  assertScopedLocalPath(env.UPLOAD_STORAGE_DIR, "UPLOAD_STORAGE_DIR");
  assertScopedLocalPath(env.REPORT_STORAGE_DIR, "REPORT_STORAGE_DIR");

  return {
    ...input,
    PORT: String(port),
    STORAGE_PROVIDER: storageProvider,
    TRUST_PROXY_HOPS: String(http.trustProxyHops),
    READINESS_TIMEOUT_MS: String(http.readinessTimeoutMs),
    JSON_BODY_LIMIT_BYTES: String(http.jsonBodyLimitBytes),
    URLENCODED_BODY_LIMIT_BYTES: String(http.urlencodedBodyLimitBytes)
  };
}

function normalizedEnvironment(value: string | undefined) {
  const normalized = value?.trim().replace(/^['"]|['"]$/g, "") || "development";
  if (!new Set(["development", "test", "production"]).has(normalized)) {
    throw new Error("APP_ENV must be development, test, or production.");
  }
  return normalized;
}

function requiredUrl(value: string | undefined, key: string) {
  if (!value?.trim()) throw new Error(`${key} is required.`);
  try {
    return new URL(value);
  } catch {
    throw new Error(`${key} must be a valid URL.`);
  }
}

function boundedInteger(
  value: string | undefined,
  key: string,
  minimum: number,
  maximum: number,
  fallback: number
) {
  const normalized = value?.trim() || String(fallback);
  if (!/^\d+$/.test(normalized)) throw new Error(`${key} must be an integer.`);
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${key} must be between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function strongSecret(value: string | undefined, key: string) {
  const secret = value?.trim();
  if (!secret) throw new Error(`${key} is required.`);
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error(`${key} must contain at least 32 bytes.`);
  }
  const counts = new Map<string, number>();
  for (const character of secret) counts.set(character, (counts.get(character) ?? 0) + 1);
  const entropy = [...counts.values()].reduce((total, count) => {
    const probability = count / secret.length;
    return total - count * Math.log2(probability);
  }, 0);
  if (counts.size < 12 || entropy < 160 || /^(.{1,16})\1+$/.test(secret)) {
    throw new Error(`${key} must be a high-entropy independently generated secret.`);
  }
  return secret;
}

function assertScopedLocalPath(value: string | undefined, key: string) {
  if (!value?.trim()) throw new Error(`${key} is required for local storage.`);
  const target = path.resolve(process.cwd(), value);
  const root = path.parse(target).root;
  const current = path.resolve(process.cwd());
  const userHome = path.resolve(homedir());
  const relative = path.relative(current, target);
  if (
    target === root ||
    target === current ||
    target === userHome ||
    relative === "" ||
    relative.startsWith(`..${path.sep}`) ||
    relative === ".." ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`${key} must be a scoped directory below the application workspace.`);
  }
}
