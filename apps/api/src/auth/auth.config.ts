export const AUTH_CONFIG = Symbol("AUTH_CONFIG");

export type AuthConfig = {
  provider: "supabase" | "local";
  supabaseUrl: string;
  supabasePublishableKey: string;
  supabaseSecretKey: string;
  jwtIssuer: string;
  jwtAudience: string;
  cookieSecure: boolean;
  cookieNamespace: string;
  sessionHandleSecret: string;
  sessionHandlePreviousSecret?: string;
  authorizationVersionSecret: string;
  csrfSecret: string;
  csrfPreviousSecret?: string;
  csrfTtlMs: number;
  allowedOrigins: ReadonlySet<string>;
  inviteRedirectOrigin: string;
  production: boolean;
  localSessionTokenSecret?: string;
  localSetupTokenSecret?: string;
  localRateLimitSecret?: string;
  localSessionIdleTtlMs: number;
  localSessionAbsoluteTtlMs: number;
  localSessionRotationTtlMs: number;
  localSetupTokenTtlMs: number;
  localScryptConcurrency: number;
  localScryptQueueLimit: number;
};

export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const appEnvironment = optionalEnvironment(env.APP_ENV, "APP_ENV");
  const nodeEnvironment = optionalEnvironment(env.NODE_ENV, "NODE_ENV");
  if (appEnvironment && nodeEnvironment && appEnvironment !== nodeEnvironment) {
    throw new Error("APP_ENV and NODE_ENV must not disagree.");
  }
  const production = (appEnvironment ?? nodeEnvironment) === "production";
  const provider = parseProvider(env.AUTH_PROVIDER);
  const supabaseUrl = provider === "supabase" ? required(env, "SUPABASE_URL") : "";
  const jwtIssuer = provider === "supabase" ? required(env, "SUPABASE_JWT_ISSUER") : "";
  const cookieSecure = parseBoolean(required(env, "AUTH_COOKIE_SECURE"), "AUTH_COOKIE_SECURE");
  const sessionHandleSecret = strongSecret(env, "AUTH_SESSION_HANDLE_SECRET");
  const sessionHandlePreviousSecret = optionalStrongSecret(
    env,
    "AUTH_SESSION_HANDLE_PREVIOUS_SECRET"
  );
  const authorizationVersionSecret = strongSecret(env, "AUTH_AUTHORIZATION_VERSION_SECRET");
  const csrfSecret = strongSecret(env, "AUTH_CSRF_SECRET");
  const csrfPreviousSecret = optionalStrongSecret(env, "AUTH_CSRF_PREVIOUS_SECRET");
  const csrfTtlMs = parseInteger(
    env.AUTH_CSRF_TTL_SECONDS,
    "AUTH_CSRF_TTL_SECONDS",
    300,
    86_400,
    28_800
  ) * 1000;
  const supabasePublishableKey = provider === "supabase" ? required(env, "SUPABASE_PUBLISHABLE_KEY") : "";
  const supabaseSecretKey = provider === "supabase" ? required(env, "SUPABASE_SECRET_KEY") : "";
  const localSessionTokenSecret = provider === "local"
    ? strongSecret(env, "AUTH_LOCAL_SESSION_TOKEN_SECRET")
    : undefined;
  const localSetupTokenSecret = provider === "local"
    ? strongSecret(env, "AUTH_LOCAL_SETUP_TOKEN_SECRET")
    : undefined;
  const localRateLimitSecret = provider === "local"
    ? strongSecret(env, "AUTH_LOCAL_RATE_LIMIT_SECRET")
    : undefined;

  if (production && !cookieSecure) {
    throw new Error("AUTH_COOKIE_SECURE must be true in production.");
  }
  if (sessionHandleSecret === csrfSecret) {
    throw new Error("AUTH_SESSION_HANDLE_SECRET and AUTH_CSRF_SECRET must be different.");
  }
  if (
    sessionHandleSecret === supabasePublishableKey ||
    sessionHandleSecret === supabaseSecretKey ||
    authorizationVersionSecret === supabasePublishableKey ||
    authorizationVersionSecret === supabaseSecretKey ||
    csrfSecret === supabasePublishableKey ||
    csrfSecret === supabaseSecretKey
  ) {
    throw new Error("Application auth secrets must not reuse Supabase provider keys.");
  }
  const allowedOrigins = parseAllowedOrigins(
    required(env, "APP_ALLOWED_ORIGINS"),
    production,
    provider === "local"
  );
  const cookieNamespace = parseCookieNamespace(env.AUTH_COOKIE_NAMESPACE, production);
  const deploymentMode = env.DEPLOYMENT_MODE?.trim().toLowerCase();
  const localLanDeployment = deploymentMode === "local_lan";
  if (localLanDeployment && provider !== "local") {
    throw new Error("local_lan deployments require AUTH_PROVIDER=local.");
  }
  if (deploymentMode === "cloud_container" && provider !== "supabase") {
    throw new Error("cloud_container deployments require AUTH_PROVIDER=supabase.");
  }
  const inviteRedirectOrigin = parseInviteRedirectOrigin(
    env.AUTH_INVITE_REDIRECT_ORIGIN,
    allowedOrigins,
    provider,
    deploymentMode === "cloud_container"
  );

  const independentlyManagedSecrets = [
    sessionHandleSecret,
    sessionHandlePreviousSecret,
    authorizationVersionSecret,
    csrfSecret,
    csrfPreviousSecret,
    supabasePublishableKey,
    supabaseSecretKey,
    localSessionTokenSecret,
    localSetupTokenSecret,
    localRateLimitSecret
  ].filter((value): value is string => Boolean(value));
  if (new Set(independentlyManagedSecrets).size !== independentlyManagedSecrets.length) {
    throw new Error("Current, previous, CSRF, session, and Supabase secrets must all be different.");
  }

  const parsedSupabaseUrl = provider === "supabase" ? new URL(supabaseUrl) : undefined;
  const parsedIssuer = provider === "supabase" ? new URL(jwtIssuer) : undefined;
  if (parsedSupabaseUrl && parsedIssuer) {
    if (parsedSupabaseUrl.protocol !== "https:" || parsedIssuer.protocol !== "https:") {
      throw new Error("Supabase URL and JWT issuer must use HTTPS.");
    }
    if (parsedIssuer.origin !== parsedSupabaseUrl.origin || parsedIssuer.pathname !== "/auth/v1") {
      throw new Error("SUPABASE_JWT_ISSUER must be the configured project's /auth/v1 issuer.");
    }
  }
  const localSessionIdleTtlMs = parseInteger(
    env.AUTH_LOCAL_SESSION_IDLE_MINUTES,
    "AUTH_LOCAL_SESSION_IDLE_MINUTES",
    5,
    1440,
    30
  ) * 60_000;
  const localSessionAbsoluteTtlMs = parseInteger(
    env.AUTH_LOCAL_SESSION_ABSOLUTE_HOURS,
    "AUTH_LOCAL_SESSION_ABSOLUTE_HOURS",
    1,
    720,
    12
  ) * 3_600_000;
  if (localSessionIdleTtlMs > localSessionAbsoluteTtlMs) {
    throw new Error("AUTH_LOCAL_SESSION_IDLE_MINUTES must not exceed the absolute session lifetime.");
  }
  const localSessionRotationTtlMs = parseInteger(
    env.AUTH_LOCAL_SESSION_ROTATION_MINUTES,
    "AUTH_LOCAL_SESSION_ROTATION_MINUTES",
    5,
    1440,
    15
  ) * 60_000;
  if (localSessionRotationTtlMs > localSessionAbsoluteTtlMs) {
    throw new Error("AUTH_LOCAL_SESSION_ROTATION_MINUTES must not exceed the absolute session lifetime.");
  }

  return {
    provider,
    supabaseUrl: parsedSupabaseUrl?.origin ?? "",
    supabasePublishableKey,
    supabaseSecretKey,
    jwtIssuer: parsedIssuer?.toString().replace(/\/$/, "") ?? "",
    jwtAudience: provider === "supabase" ? required(env, "SUPABASE_JWT_AUDIENCE") : "",
    cookieSecure,
    cookieNamespace,
    sessionHandleSecret,
    sessionHandlePreviousSecret,
    authorizationVersionSecret,
    csrfSecret,
    csrfPreviousSecret,
    csrfTtlMs,
    allowedOrigins,
    inviteRedirectOrigin,
    production,
    localSessionTokenSecret,
    localSetupTokenSecret,
    localRateLimitSecret,
    localSessionIdleTtlMs,
    localSessionAbsoluteTtlMs,
    localSessionRotationTtlMs,
    localSetupTokenTtlMs: parseInteger(env.AUTH_LOCAL_SETUP_TOKEN_HOURS, "AUTH_LOCAL_SETUP_TOKEN_HOURS", 1, 168, 24) * 3_600_000,
    localScryptConcurrency: parseInteger(env.AUTH_LOCAL_SCRYPT_CONCURRENCY, "AUTH_LOCAL_SCRYPT_CONCURRENCY", 1, 8, 2),
    localScryptQueueLimit: parseInteger(env.AUTH_LOCAL_SCRYPT_QUEUE_LIMIT, "AUTH_LOCAL_SCRYPT_QUEUE_LIMIT", 0, 64, 8)
  };
}

function parseInviteRedirectOrigin(
  value: string | undefined,
  allowedOrigins: ReadonlySet<string>,
  provider: "supabase" | "local",
  requiredForCloud: boolean
) {
  if (provider === "local") return "";
  const candidate = value?.trim() || (requiredForCloud ? "" : [...allowedOrigins][0]);
  if (!candidate) throw new Error("AUTH_INVITE_REDIRECT_ORIGIN is required in cloud_container.");
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("AUTH_INVITE_REDIRECT_ORIGIN must be an exact allowed origin.");
  }
  if (parsed.origin !== candidate || !allowedOrigins.has(candidate)) {
    throw new Error("AUTH_INVITE_REDIRECT_ORIGIN must be an exact allowed origin.");
  }
  return parsed.origin;
}

export function parseAllowedOrigins(value: string, production: boolean, allowLocalProduction = false) {
  const origins = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (origins.length === 0) throw new Error("APP_ALLOWED_ORIGINS must not be empty.");

  const parsed = origins.map((origin) => {
    if (origin.includes("*")) throw new Error("APP_ALLOWED_ORIGINS does not allow wildcards.");
    const url = new URL(origin);
    if (url.origin !== origin || url.username || url.password) {
      throw new Error("APP_ALLOWED_ORIGINS entries must be exact origins.");
    }
    if (
      production && !allowLocalProduction &&
      (url.hostname === "localhost" ||
        url.hostname === "127.0.0.1" ||
        url.hostname === "[::1]" ||
        url.hostname === "::1" ||
        url.hostname.endsWith(".localhost"))
    ) {
      throw new Error("Production APP_ALLOWED_ORIGINS cannot contain localhost.");
    }
    if (production && url.protocol !== "https:") {
      throw new Error("Production APP_ALLOWED_ORIGINS entries must use HTTPS.");
    }
    return origin;
  });
  return new Set(parsed);
}

function parseProvider(value: string | undefined): "supabase" | "local" {
  const normalized = value?.trim().toLowerCase() || "supabase";
  if (normalized === "supabase" || normalized === "local") return normalized;
  throw new Error("AUTH_PROVIDER must be supabase or local.");
}

function required(env: NodeJS.ProcessEnv, key: string) {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required.`);
  return value;
}

function strongSecret(env: NodeJS.ProcessEnv, key: string) {
  const value = required(env, key);
  if (Buffer.byteLength(value, "utf8") < 32) {
    throw new Error(`${key} must contain at least 32 bytes.`);
  }
  const counts = new Map<string, number>();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  const estimatedEntropyBits = [...counts.values()].reduce((total, count) => {
    const probability = count / value.length;
    return total - count * Math.log2(probability);
  }, 0);
  if (
    counts.size < 12 ||
    estimatedEntropyBits < 160 ||
    /^(.{1,16})\1+$/.test(value)
  ) {
    throw new Error(`${key} must be a high-entropy independently generated secret.`);
  }
  return value;
}

function optionalStrongSecret(env: NodeJS.ProcessEnv, key: string) {
  if (!env[key]?.trim()) return undefined;
  return strongSecret(env, key);
}

function parseCookieNamespace(value: string | undefined, production: boolean) {
  const namespace = value?.trim().toLowerCase() ?? "";
  if (!namespace) {
    if (production) throw new Error("AUTH_COOKIE_NAMESPACE is required in production.");
    return "";
  }
  if (!/^[a-z0-9](?:[a-z0-9-]{0,18}[a-z0-9])?$/.test(namespace)) {
    throw new Error("AUTH_COOKIE_NAMESPACE must be a 1-20 character lowercase deployment id.");
  }
  return namespace;
}

function parseBoolean(value: string, key: string) {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${key} must be true or false.`);
}

function parseInteger(
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

function optionalEnvironment(value: string | undefined, key: string) {
  const normalized = value?.trim().replace(/^['"]|['"]$/g, "");
  if (!normalized) return undefined;
  if (normalized !== "development" && normalized !== "test" && normalized !== "production") {
    throw new Error(`${key} must be development, test, or production.`);
  }
  return normalized;
}
