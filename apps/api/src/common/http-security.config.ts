import { createHash, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import path from "node:path";
import { loadAuthConfig } from "../auth/auth.config";
import { resolveUploadStructureLimits } from "../file-security/upload-preflight";
import { validateSupabaseDatabaseTarget } from "./supabase-database-target";
import {
  resolveCoupangBundleMaxTotalBytes,
  resolveProfileMaxFileBytes,
  UPLOAD_PROFILES
} from "../file-security/upload-profiles";

export { HTTP_SECURITY_CONFIG } from "./http-security.token";

export type DeploymentMode = "legacy" | "local_lan" | "cloud_container";

export type HttpSecurityConfig = {
  production: boolean;
  trustProxyHops: number;
  internalProbeToken: string;
  readinessTimeoutMs: number;
  databaseReadinessTimeoutMs: number;
  jsonBodyLimitBytes: number;
  urlencodedBodyLimitBytes: number;
  deploymentEnvironmentId: string;
  runtimeConfigFingerprint: string;
  storageCredentialExpiresAtMs: number | null;
  storageReadinessKey: string | null;
  deploymentMode: DeploymentMode;
  localEdgeProxyPublicKey: string | null;
  releaseId: string;
  heavyOperationConcurrency: number;
  heavyOperationRetryAfterSeconds: number;
  reportMaxSourceRows: number;
};

export function loadHttpSecurityConfig(
  env: NodeJS.ProcessEnv = process.env
): HttpSecurityConfig {
  const appEnvironment = normalizedEnvironment(env.APP_ENV?.trim() || env.NODE_ENV);
  const production = appEnvironment === "production";
  const deploymentMode = parseDeploymentMode(env.DEPLOYMENT_MODE);
  if (production && deploymentMode === "legacy") {
    throw new Error("Production DEPLOYMENT_MODE must be explicitly local_lan or cloud_container.");
  }
  if (deploymentMode === "cloud_container" && !production) {
    throw new Error("cloud_container requires APP_ENV=production and NODE_ENV=production.");
  }
  const readinessTimeoutMs = boundedInteger(
    env.READINESS_TIMEOUT_MS,
    "READINESS_TIMEOUT_MS",
    250,
    5_000,
    1_500
  );
  const databaseReadinessTimeoutMs = boundedInteger(
    env.DATABASE_READINESS_TIMEOUT_MS,
    "DATABASE_READINESS_TIMEOUT_MS",
    100,
    4_000,
    1_000
  );
  if (databaseReadinessTimeoutMs >= readinessTimeoutMs) {
    throw new Error("DATABASE_READINESS_TIMEOUT_MS must be lower than READINESS_TIMEOUT_MS.");
  }
  const trustProxyHops = boundedInteger(env.TRUST_PROXY_HOPS, "TRUST_PROXY_HOPS", 0, 3, 0);
  if (deploymentMode === "local_lan" && trustProxyHops !== 0) {
    throw new Error("local_lan requires TRUST_PROXY_HOPS=0 and authenticated edge client metadata.");
  }
  if (deploymentMode === "cloud_container" && trustProxyHops === 0) {
    throw new Error("cloud_container requires a bounded non-zero TRUST_PROXY_HOPS value.");
  }
  return {
    production,
    trustProxyHops,
    internalProbeToken: strongSecret(env.INTERNAL_PROBE_TOKEN, "INTERNAL_PROBE_TOKEN"),
    readinessTimeoutMs,
    databaseReadinessTimeoutMs,
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
    ),
    deploymentEnvironmentId: deploymentIdentifier(
      env.DEPLOYMENT_ENVIRONMENT_ID,
      "DEPLOYMENT_ENVIRONMENT_ID",
      production,
      appEnvironment
    ),
    runtimeConfigFingerprint: runtimeConfigFingerprint(env, production),
    storageCredentialExpiresAtMs: storageCredentialExpiry(env, production),
    storageReadinessKey: storageReadinessKey(env, production),
    deploymentMode,
    localEdgeProxyPublicKey: deploymentMode === "local_lan"
      ? localEdgePublicKey(env.LOCAL_EDGE_PUBLIC_KEY_PATH)
      : null,
    releaseId: cloudReleaseId(env.RELEASE_GIT_SHA, deploymentMode),
    heavyOperationConcurrency: boundedInteger(
      env.HEAVY_OPERATION_CONCURRENCY,
      "HEAVY_OPERATION_CONCURRENCY",
      1,
      2,
      deploymentMode === "cloud_container" ? 1 : 2
    ),
    heavyOperationRetryAfterSeconds: boundedInteger(
      env.HEAVY_OPERATION_RETRY_AFTER_SECONDS,
      "HEAVY_OPERATION_RETRY_AFTER_SECONDS",
      1,
      60,
      5
    ),
    reportMaxSourceRows: boundedInteger(
      env.REPORT_MAX_SOURCE_ROWS,
      "REPORT_MAX_SOURCE_ROWS",
      1_000,
      25_000,
      25_000
    )
  };
}

function localEdgePublicKey(value: string | undefined) {
  if (!value?.trim() || !path.isAbsolute(value.trim())) {
    throw new Error("LOCAL_EDGE_PUBLIC_KEY_PATH must be an absolute path.");
  }
  let bytes: Buffer;
  try { bytes = readFileSync(path.resolve(value.trim())); }
  catch { throw new Error("LOCAL_EDGE_PUBLIC_KEY_PATH is not readable."); }
  if (bytes.length < 32 || bytes.length > 16_384) throw new Error("LOCAL_EDGE_PUBLIC_KEY_PATH is invalid.");
  try {
    const key = createPublicKey(bytes);
    if (key.asymmetricKeyType !== "ed25519") throw new Error();
    return key.export({ type: "spki", format: "pem" }).toString();
  } catch { throw new Error("LOCAL_EDGE_PUBLIC_KEY_PATH must contain an Ed25519 public key."); }
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
  const deploymentMode = parseDeploymentMode(env.DEPLOYMENT_MODE);
  const localNative = deploymentMode === "local_lan";
  const cloudContainer = deploymentMode === "cloud_container";
  if (localNative) {
    for (const key of [
      "SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SECRET_KEY",
      "SUPABASE_JWT_ISSUER", "SUPABASE_STORAGE_ACCESS_TOKEN"
    ]) {
      if (env[key]?.trim()) throw new Error("local_lan rejects Supabase Auth and Storage configuration.");
    }
  }
  if (cloudContainer) {
    for (const [key, value] of Object.entries(env)) {
      const forbidden = key.startsWith("AUTH_LOCAL_") || key.startsWith("LOCAL_EDGE_") ||
        key === "LOCAL_RELEASE_ID" || key === "CONFIG_PATH" ||
        key === "SUPABASE_DATABASE_CA_CERT_PATH" || key === "APP_DATA_ROOT" ||
        key === "UPLOAD_STORAGE_DIR" || key === "REPORT_STORAGE_DIR";
      if (forbidden && value?.trim()) {
        throw new Error(`cloud_container rejects local-only configuration key ${key}.`);
      }
    }
    if (env.AUTH_PROVIDER?.trim().toLowerCase() !== "supabase") {
      throw new Error("cloud_container requires explicit AUTH_PROVIDER=supabase.");
    }
    if (env.STORAGE_PROVIDER?.trim().toLowerCase() !== "supabase") {
      throw new Error("cloud_container requires explicit STORAGE_PROVIDER=supabase.");
    }
    if (!env.PRISMA_CONNECTION_LIMIT?.trim()) {
      throw new Error("cloud_container requires explicit PRISMA_CONNECTION_LIMIT.");
    }
  }
  const auth = loadAuthConfig(env);
  const http = loadHttpSecurityConfig(env);

  const port = boundedInteger(env.PORT, "PORT", 1, 65_535, 4_000);
  const database = requiredUrl(env.DATABASE_URL, "DATABASE_URL");
  if (database.protocol !== "postgresql:" && database.protocol !== "postgres:") {
    throw new Error("DATABASE_URL must use PostgreSQL.");
  }
  const sslModes = database.searchParams.getAll("sslmode");
  if (auth.production && (sslModes.length !== 1 || sslModes[0] !== "verify-full")) {
    throw new Error("Production DATABASE_URL must use sslmode=verify-full.");
  }
  if (localNative && auth.provider !== "local") throw new Error("local_lan requires local native Auth.");
  if (cloudContainer && auth.provider !== "supabase") throw new Error("cloud_container requires Supabase Auth.");
  if (localNative) assertSupabaseDatabase(database, env);
  if (cloudContainer) assertCloudSupabaseDatabase(database, env, auth.supabaseUrl);

  if (auth.provider === "supabase" && auth.supabasePublishableKey === auth.supabaseSecretKey) {
    throw new Error("Supabase publishable and secret keys must be different.");
  }
  if (auth.provider === "supabase" && (auth.supabasePublishableKey.startsWith("sb_secret_") ||
      auth.supabaseSecretKey.startsWith("sb_publishable_"))) {
    throw new Error("Supabase publishable and secret key variables are reversed.");
  }
  if (auth.sessionHandleSecret === http.internalProbeToken ||
      auth.csrfSecret === http.internalProbeToken ||
      auth.supabasePublishableKey === http.internalProbeToken ||
      auth.supabaseSecretKey === http.internalProbeToken ||
      auth.authorizationVersionSecret === http.internalProbeToken ||
      auth.localSessionTokenSecret === http.internalProbeToken ||
      auth.localSetupTokenSecret === http.internalProbeToken ||
      auth.localRateLimitSecret === http.internalProbeToken) {
    throw new Error("INTERNAL_PROBE_TOKEN must be an independently generated secret.");
  }

  const storageProvider = (env.STORAGE_PROVIDER?.trim() || "local").toLowerCase();
  if (storageProvider !== "local" && storageProvider !== "supabase") {
    throw new Error("STORAGE_PROVIDER must be local or supabase.");
  }
  if (auth.production && !localNative && storageProvider !== "supabase") {
    throw new Error("Production STORAGE_PROVIDER must be the approved durable supabase adapter.");
  }
  if (localNative && storageProvider !== "local") {
    throw new Error("local_lan requires STORAGE_PROVIDER=local.");
  }
  if (cloudContainer && storageProvider !== "supabase") {
    throw new Error("cloud_container requires STORAGE_PROVIDER=supabase.");
  }
  const dataRoot = env.APP_DATA_ROOT?.trim() || (localNative
    ? defaultApplicationDataRoot(env)
    : path.resolve(process.cwd(), "storage"));
  const uploadStorageDir = env.UPLOAD_STORAGE_DIR?.trim() || path.join(dataRoot, "storage", "uploads");
  const reportStorageDir = env.REPORT_STORAGE_DIR?.trim() || path.join(dataRoot, "storage", "reports");
  if (storageProvider === "local") {
    if (localNative) {
      assertExternalLocalPath(dataRoot, "APP_DATA_ROOT");
      assertExternalLocalPath(uploadStorageDir, "UPLOAD_STORAGE_DIR", dataRoot);
      assertExternalLocalPath(reportStorageDir, "REPORT_STORAGE_DIR", dataRoot);
    } else {
      assertScopedLocalPath(env.UPLOAD_STORAGE_DIR, "UPLOAD_STORAGE_DIR");
      assertScopedLocalPath(env.REPORT_STORAGE_DIR, "REPORT_STORAGE_DIR");
    }
  }
  const storageRetentionDays = boundedInteger(
    env.SUPABASE_STORAGE_RETENTION_DAYS,
    "SUPABASE_STORAGE_RETENTION_DAYS",
    1,
    365,
    30
  );
  const storageTimeoutMs = boundedInteger(
    env.SUPABASE_STORAGE_TIMEOUT_MS,
    "SUPABASE_STORAGE_TIMEOUT_MS",
    250,
    60_000,
    15_000
  );
  const storageMaxObjectBytes = boundedInteger(
    env.SUPABASE_STORAGE_MAX_OBJECT_BYTES,
    "SUPABASE_STORAGE_MAX_OBJECT_BYTES",
    1_048_576,
    268_435_456,
    52_428_800
  );
  const temporaryStorageBudgetBytes = boundedInteger(
    env.TEMP_STORAGE_BUDGET_BYTES,
    "TEMP_STORAGE_BUDGET_BYTES",
    1_048_576,
    104_857_600,
    104_857_600
  );
  const reportDownloadMaxLifetimeMs = boundedInteger(
    env.REPORT_DOWNLOAD_MAX_LIFETIME_MS,
    "REPORT_DOWNLOAD_MAX_LIFETIME_MS",
    1_000,
    300_000,
    300_000
  );
  if (auth.production && storageMaxObjectBytes * 2 > temporaryStorageBudgetBytes) {
    throw new Error("Production TEMP_STORAGE_BUDGET_BYTES must reserve two maximum Storage objects.");
  }
  if (storageProvider === "supabase") {
    const bucket = env.SUPABASE_STORAGE_BUCKET?.trim();
    if (!bucket || !/^[a-z0-9][a-z0-9._-]{0,62}$/i.test(bucket)) {
      throw new Error("SUPABASE_STORAGE_BUCKET is required and must be a valid private bucket id.");
    }
    const accessMode = env.SUPABASE_STORAGE_ACCESS_MODE?.trim().toLowerCase() || "admin";
    if (accessMode !== "admin" && accessMode !== "rls") {
      throw new Error("SUPABASE_STORAGE_ACCESS_MODE must be admin or rls.");
    }
    if (auth.production && accessMode !== "rls") {
      throw new Error("Production SUPABASE_STORAGE_ACCESS_MODE must be rls.");
    }
    const accessToken = env.SUPABASE_STORAGE_ACCESS_TOKEN?.trim();
    if (accessToken && [
      auth.supabaseSecretKey,
      auth.supabasePublishableKey,
      auth.sessionHandleSecret,
      auth.sessionHandlePreviousSecret,
      auth.authorizationVersionSecret,
      auth.csrfSecret,
      auth.csrfPreviousSecret
    ].includes(accessToken)) {
      throw new Error("SUPABASE_STORAGE_ACCESS_TOKEN must be independently managed.");
    }
    if (auth.production && (!accessToken || !looksLikeJwt(accessToken))) {
      throw new Error("Production SUPABASE_STORAGE_ACCESS_TOKEN must be a scoped JWT.");
    }
    storageCredentialExpiry(env, auth.production);
    storageReadinessKey(env, auth.production);
  }
  for (const profile of Object.values(UPLOAD_PROFILES)) {
    resolveProfileMaxFileBytes(profile, env);
  }
  resolveCoupangBundleMaxTotalBytes(env);
  resolveUploadStructureLimits(env);
  const prismaConnectionLimit = boundedInteger(
    env.PRISMA_CONNECTION_LIMIT,
    "PRISMA_CONNECTION_LIMIT",
    1,
    cloudContainer ? 3 : 20,
    1
  );
  const heavyOperationConcurrency = boundedInteger(
    env.HEAVY_OPERATION_CONCURRENCY,
    "HEAVY_OPERATION_CONCURRENCY",
    1,
    2,
    cloudContainer ? 1 : 2
  );
  if (cloudContainer && heavyOperationConcurrency !== 1) {
    throw new Error("cloud_container requires HEAVY_OPERATION_CONCURRENCY=1 for the 1GB release.");
  }
  const heavyOperationRetryAfterSeconds = boundedInteger(
    env.HEAVY_OPERATION_RETRY_AFTER_SECONDS,
    "HEAVY_OPERATION_RETRY_AFTER_SECONDS",
    1,
    60,
    5
  );
  const reportMaxSourceRows = boundedInteger(
    env.REPORT_MAX_SOURCE_ROWS,
    "REPORT_MAX_SOURCE_ROWS",
    1_000,
    25_000,
    25_000
  );
  const releaseId = cloudReleaseId(env.RELEASE_GIT_SHA, deploymentMode);

  const deploymentEnvironmentId = deploymentIdentifier(
    env.DEPLOYMENT_ENVIRONMENT_ID,
    "DEPLOYMENT_ENVIRONMENT_ID",
    auth.production,
    env.APP_ENV ?? env.NODE_ENV ?? "development"
  );
  const apiTargetId = deploymentIdentifier(
    env.RUNTIME_API_TARGET_ID,
    "RUNTIME_API_TARGET_ID",
    auth.production,
    "local-api"
  );
  const databaseId = deploymentIdentifier(
    env.RUNTIME_DATABASE_ID,
    "RUNTIME_DATABASE_ID",
    auth.production,
    "loopback-db"
  );
  const storageId = deploymentIdentifier(
    env.RUNTIME_STORAGE_ID,
    "RUNTIME_STORAGE_ID",
    auth.production,
    `${storageProvider}-storage`
  );
  const fingerprint = runtimeConfigFingerprint(env, auth.production);

  const normalized: Record<string, unknown> = {
    ...input,
    PORT: String(port),
    DEPLOYMENT_MODE: http.deploymentMode,
    APP_DATA_ROOT: dataRoot,
    UPLOAD_STORAGE_DIR: uploadStorageDir,
    REPORT_STORAGE_DIR: reportStorageDir,
    STORAGE_PROVIDER: storageProvider,
    PRISMA_CONNECTION_LIMIT: String(prismaConnectionLimit),
    SUPABASE_STORAGE_RETENTION_DAYS: String(storageRetentionDays),
    SUPABASE_STORAGE_TIMEOUT_MS: String(storageTimeoutMs),
    SUPABASE_STORAGE_MAX_OBJECT_BYTES: String(storageMaxObjectBytes),
    TEMP_STORAGE_BUDGET_BYTES: String(temporaryStorageBudgetBytes),
    REPORT_DOWNLOAD_MAX_LIFETIME_MS: String(reportDownloadMaxLifetimeMs),
    TRUST_PROXY_HOPS: String(http.trustProxyHops),
    READINESS_TIMEOUT_MS: String(http.readinessTimeoutMs),
    DATABASE_READINESS_TIMEOUT_MS: String(http.databaseReadinessTimeoutMs),
    JSON_BODY_LIMIT_BYTES: String(http.jsonBodyLimitBytes),
    URLENCODED_BODY_LIMIT_BYTES: String(http.urlencodedBodyLimitBytes),
    HEAVY_OPERATION_CONCURRENCY: String(heavyOperationConcurrency),
    HEAVY_OPERATION_RETRY_AFTER_SECONDS: String(heavyOperationRetryAfterSeconds),
    REPORT_MAX_SOURCE_ROWS: String(reportMaxSourceRows),
    RELEASE_GIT_SHA: releaseId,
    DEPLOYMENT_ENVIRONMENT_ID: deploymentEnvironmentId,
    RUNTIME_API_TARGET_ID: apiTargetId,
    RUNTIME_DATABASE_ID: databaseId,
    RUNTIME_STORAGE_ID: storageId,
    RUNTIME_CONFIG_FINGERPRINT: fingerprint
  };
  if (cloudContainer) {
    delete normalized.APP_DATA_ROOT;
    delete normalized.UPLOAD_STORAGE_DIR;
    delete normalized.REPORT_STORAGE_DIR;
  }
  return normalized;
}

function runtimeConfigFingerprint(env: NodeJS.ProcessEnv, production: boolean) {
  const auth = loadAuthConfig(env);
  const deploymentEnvironmentId = deploymentIdentifier(
    env.DEPLOYMENT_ENVIRONMENT_ID,
    "DEPLOYMENT_ENVIRONMENT_ID",
    production,
    env.APP_ENV ?? env.NODE_ENV ?? "development"
  );
  const apiTargetId = deploymentIdentifier(
    env.RUNTIME_API_TARGET_ID,
    "RUNTIME_API_TARGET_ID",
    production,
    "local-api"
  );
  const databaseId = deploymentIdentifier(
    env.RUNTIME_DATABASE_ID,
    "RUNTIME_DATABASE_ID",
    production,
    "loopback-db"
  );
  const storageProvider = (env.STORAGE_PROVIDER?.trim() || "local").toLowerCase();
  const storageId = deploymentIdentifier(
    env.RUNTIME_STORAGE_ID,
    "RUNTIME_STORAGE_ID",
    production,
    `${storageProvider}-storage`
  );
  return createHash("sha256").update(JSON.stringify({
    deploymentEnvironmentId,
    originHosts: [...auth.allowedOrigins].map((origin) => new URL(origin).host).sort(),
    cookieMode: auth.cookieSecure ? "secure" : "development",
    cookieNamespace: auth.cookieNamespace,
    inviteRedirectHost: auth.inviteRedirectOrigin
      ? new URL(auth.inviteRedirectOrigin).host
      : "local",
    apiTargetId,
    authProvider: auth.provider,
    authProjectRef: auth.provider === "supabase"
      ? new URL(auth.supabaseUrl).hostname.split(".")[0]
      : "local",
    databaseId,
    databaseProjectRef: env.SUPABASE_DATABASE_PROJECT_REF?.trim().toLowerCase() || "unbound",
    databaseConnectionMode: env.SUPABASE_DATABASE_CONNECTION_MODE?.trim().toLowerCase() || "unbound",
    databaseHost: env.SUPABASE_DATABASE_HOST?.trim().toLowerCase() || "unbound",
    databaseName: env.SUPABASE_DATABASE_NAME?.trim().toLowerCase() || "unbound",
    databaseSchema: env.SUPABASE_DATABASE_SCHEMA?.trim().toLowerCase() || "unbound",
    databaseRuntimeUser: env.SUPABASE_DATABASE_RUNTIME_USER?.trim() || "unbound",
    storageId,
    storageProvider,
    storageBucket: env.SUPABASE_STORAGE_BUCKET?.trim().toLowerCase() || "local",
    storageAccessMode: env.SUPABASE_STORAGE_ACCESS_MODE?.trim().toLowerCase() || "local",
    storageReadinessKey: env.SUPABASE_STORAGE_READINESS_KEY?.trim() || "none",
    deploymentMode: parseDeploymentMode(env.DEPLOYMENT_MODE),
    releaseId: cloudReleaseId(env.RELEASE_GIT_SHA, parseDeploymentMode(env.DEPLOYMENT_MODE)),
    prismaConnectionLimit: env.PRISMA_CONNECTION_LIMIT?.trim() || "1",
    heavyOperationConcurrency: env.HEAVY_OPERATION_CONCURRENCY?.trim() || "1",
    reportMaxSourceRows: env.REPORT_MAX_SOURCE_ROWS?.trim() || "25000"
  })).digest("hex");
}

function deploymentIdentifier(
  value: string | undefined,
  key: string,
  requiredInProduction: boolean,
  fallback: string
) {
  const identifier = value?.trim().toLowerCase() || (requiredInProduction ? "" : fallback);
  if (!identifier) throw new Error(`${key} is required in production.`);
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(identifier)) {
    throw new Error(`${key} must be a safe non-secret deployment identifier.`);
  }
  return identifier;
}

function looksLikeJwt(value: string) {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);
}

function storageCredentialExpiry(env: NodeJS.ProcessEnv, production: boolean) {
  const provider = (env.STORAGE_PROVIDER?.trim() || "local").toLowerCase();
  const mode = (env.SUPABASE_STORAGE_ACCESS_MODE?.trim() || "admin").toLowerCase();
  if (provider !== "supabase" || mode !== "rls") return null;
  const token = env.SUPABASE_STORAGE_ACCESS_TOKEN?.trim();
  if (!token || !looksLikeJwt(token)) {
    if (production) throw new Error("Production SUPABASE_STORAGE_ACCESS_TOKEN must be a scoped JWT.");
    return null;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
  } catch {
    throw new Error("SUPABASE_STORAGE_ACCESS_TOKEN must contain a valid JWT payload.");
  }
  const expiresAtSeconds = payload && typeof payload === "object"
    ? (payload as { exp?: unknown }).exp
    : undefined;
  if (!Number.isSafeInteger(expiresAtSeconds) || (expiresAtSeconds as number) <= 0) {
    throw new Error("SUPABASE_STORAGE_ACCESS_TOKEN must contain a finite exp claim.");
  }
  const minimumTtlSeconds = boundedInteger(
    env.SUPABASE_STORAGE_MIN_TOKEN_TTL_SECONDS,
    "SUPABASE_STORAGE_MIN_TOKEN_TTL_SECONDS",
    3_600,
    2_592_000,
    86_400
  );
  const maximumTtlSeconds = boundedInteger(
    env.SUPABASE_STORAGE_MAX_TOKEN_TTL_SECONDS,
    "SUPABASE_STORAGE_MAX_TOKEN_TTL_SECONDS",
    86_400,
    2_592_000,
    604_800
  );
  const expiresAtMs = (expiresAtSeconds as number) * 1_000;
  if (production && expiresAtMs - Date.now() < minimumTtlSeconds * 1_000) {
    throw new Error("SUPABASE_STORAGE_ACCESS_TOKEN expires before the required deployment overlap window.");
  }
  if (production && expiresAtMs - Date.now() > maximumTtlSeconds * 1_000) {
    throw new Error("SUPABASE_STORAGE_ACCESS_TOKEN exceeds the maximum credential lifetime.");
  }
  if (production) validateStorageJwtClaims(env, payload);
  return expiresAtMs;
}

function validateStorageJwtClaims(env: NodeJS.ProcessEnv, payload: unknown) {
  const claims = payload as { iss?: unknown; aud?: unknown; sub?: unknown; role?: unknown };
  const expectedIssuer = env.SUPABASE_JWT_ISSUER?.trim();
  const expectedAudience = env.SUPABASE_JWT_AUDIENCE?.trim();
  const expectedSubject = env.SUPABASE_STORAGE_TOKEN_SUBJECT?.trim();
  if (!expectedSubject || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(expectedSubject)) {
    throw new Error("SUPABASE_STORAGE_TOKEN_SUBJECT is required and must be a safe identifier.");
  }
  if (claims.iss !== expectedIssuer || claims.aud !== expectedAudience || claims.sub !== expectedSubject) {
    throw new Error("SUPABASE_STORAGE_ACCESS_TOKEN must be bound to the configured project and subject.");
  }
  if (claims.role !== "storage_app") {
    throw new Error("SUPABASE_STORAGE_ACCESS_TOKEN must use the least-privilege storage_app role.");
  }
}

function storageReadinessKey(env: NodeJS.ProcessEnv, production: boolean) {
  const provider = (env.STORAGE_PROVIDER?.trim() || "local").toLowerCase();
  const mode = (env.SUPABASE_STORAGE_ACCESS_MODE?.trim() || "admin").toLowerCase();
  if (provider !== "supabase" || mode !== "rls") return null;
  const key = env.SUPABASE_STORAGE_READINESS_KEY?.trim() || "";
  if (!key) {
    if (production) throw new Error("SUPABASE_STORAGE_READINESS_KEY is required in production.");
    return null;
  }
  if (
    key.length > 256 ||
    key.startsWith("/") ||
    key.endsWith("/") ||
    key.split("/").some((segment) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(segment))
  ) {
    throw new Error("SUPABASE_STORAGE_READINESS_KEY must be a safe private sentinel key.");
  }
  return key;
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

function assertSupabaseDatabase(database: URL, env: NodeJS.ProcessEnv) {
  validateSupabaseDatabaseTarget(env, database.toString());
  for (const key of ["connection_limit", "pool_timeout", "connect_timeout"]) {
    const value = database.searchParams.get(key);
    if (value && (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 120)) {
      throw new Error(`local_lan DATABASE_URL ${key} is out of range.`);
    }
  }
}

function assertCloudSupabaseDatabase(database: URL, env: NodeJS.ProcessEnv, supabaseUrl: string) {
  const target = validateSupabaseDatabaseTarget(env, database.toString(), { tlsTrust: "system" });
  const authHost = new URL(supabaseUrl).hostname.toLowerCase();
  if (authHost !== `${target.projectRef}.supabase.co`) {
    throw new Error("cloud_container database, Auth, and Storage must use the same Supabase project ref.");
  }
  const expectedDatabase = env.SUPABASE_DATABASE_NAME?.trim() || "";
  const expectedSchema = env.SUPABASE_DATABASE_SCHEMA?.trim() || "";
  if (!expectedDatabase || !expectedSchema ||
      target.database !== expectedDatabase || target.schema !== expectedSchema) {
    throw new Error("cloud_container DATABASE_URL must match the exact configured database and schema.");
  }
  for (const key of ["connection_limit", "pool_timeout", "connect_timeout"]) {
    const values = database.searchParams.getAll(key);
    if (values.length > 1 || (values[0] && (!/^\d+$/.test(values[0]) || Number(values[0]) < 1 || Number(values[0]) > 120))) {
      throw new Error(`cloud_container DATABASE_URL ${key} is out of range.`);
    }
  }
  const urlConnectionLimit = database.searchParams.get("connection_limit");
  if (urlConnectionLimit && urlConnectionLimit !== env.PRISMA_CONNECTION_LIMIT?.trim()) {
    throw new Error("DATABASE_URL connection_limit must equal PRISMA_CONNECTION_LIMIT.");
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

export function defaultApplicationDataRoot(env: NodeJS.ProcessEnv = process.env) {
  if (platform() === "win32") {
    const base = env.PROGRAMDATA?.trim() || env.LOCALAPPDATA?.trim();
    if (!base) throw new Error("PROGRAMDATA or LOCALAPPDATA is required to resolve APP_DATA_ROOT.");
    return path.resolve(base, "MetaAdsPerformance");
  }
  if (platform() === "darwin") {
    return path.resolve(homedir(), "Library", "Application Support", "MetaAdsPerformance");
  }
  return path.resolve(env.XDG_DATA_HOME?.trim() || path.join(homedir(), ".local", "share"), "meta-ads-performance");
}

function assertExternalLocalPath(value: string, key: string, expectedParent?: string) {
  if (!path.isAbsolute(value)) throw new Error(`${key} must be an absolute local path.`);
  if (value.startsWith("\\\\")) throw new Error(`${key} must not be a UNC path.`);
  const target = path.resolve(value);
  const root = path.parse(target).root;
  const workspace = path.resolve(process.cwd());
  const userHome = path.resolve(homedir());
  const relativeToWorkspace = path.relative(workspace, target);
  if (
    target === root || target === workspace || target === userHome ||
    (!relativeToWorkspace.startsWith(`..${path.sep}`) && relativeToWorkspace !== "..")
  ) throw new Error(`${key} must be scoped outside the repository and home root.`);
  if (expectedParent) {
    const relative = path.relative(path.resolve(expectedParent), target);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`${key} must be a child of APP_DATA_ROOT.`);
    }
  }
}

function parseDeploymentMode(value: string | undefined): DeploymentMode {
  const normalized = value?.trim().toLowerCase() || "legacy";
  if (normalized === "legacy" || normalized === "local_lan" || normalized === "cloud_container") return normalized;
  throw new Error("DEPLOYMENT_MODE must be legacy, local_lan, or cloud_container.");
}

function cloudReleaseId(value: string | undefined, deploymentMode: DeploymentMode) {
  if (deploymentMode !== "cloud_container") return value?.trim().toLowerCase() || "unversioned";
  const releaseId = value?.trim().toLowerCase() || "";
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(releaseId)) {
    throw new Error("RELEASE_GIT_SHA must be a full 40-character SHA-1 or 64-character SHA-256 commit id in cloud_container.");
  }
  return releaseId;
}
