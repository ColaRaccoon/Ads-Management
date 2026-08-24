export const AUTH_CONFIG = Symbol("AUTH_CONFIG");

export type AuthConfig = {
  supabaseUrl: string;
  supabasePublishableKey: string;
  supabaseSecretKey: string;
  jwtIssuer: string;
  jwtAudience: string;
  cookieSecure: boolean;
  sessionHandleSecret: string;
  csrfSecret: string;
  allowedOrigins: ReadonlySet<string>;
  production: boolean;
};

export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const appEnvironment = optionalEnvironment(env.APP_ENV, "APP_ENV");
  const nodeEnvironment = optionalEnvironment(env.NODE_ENV, "NODE_ENV");
  if (appEnvironment && nodeEnvironment && appEnvironment !== nodeEnvironment) {
    throw new Error("APP_ENV and NODE_ENV must not disagree.");
  }
  const production = (appEnvironment ?? nodeEnvironment) === "production";
  const supabaseUrl = required(env, "SUPABASE_URL");
  const jwtIssuer = required(env, "SUPABASE_JWT_ISSUER");
  const cookieSecure = parseBoolean(required(env, "AUTH_COOKIE_SECURE"), "AUTH_COOKIE_SECURE");
  const sessionHandleSecret = strongSecret(env, "AUTH_SESSION_HANDLE_SECRET");
  const csrfSecret = strongSecret(env, "AUTH_CSRF_SECRET");
  const supabasePublishableKey = required(env, "SUPABASE_PUBLISHABLE_KEY");
  const supabaseSecretKey = required(env, "SUPABASE_SECRET_KEY");

  if (production && !cookieSecure) {
    throw new Error("AUTH_COOKIE_SECURE must be true in production.");
  }
  if (sessionHandleSecret === csrfSecret) {
    throw new Error("AUTH_SESSION_HANDLE_SECRET and AUTH_CSRF_SECRET must be different.");
  }
  if (
    sessionHandleSecret === supabasePublishableKey ||
    sessionHandleSecret === supabaseSecretKey ||
    csrfSecret === supabasePublishableKey ||
    csrfSecret === supabaseSecretKey
  ) {
    throw new Error("Application auth secrets must not reuse Supabase provider keys.");
  }
  const allowedOrigins = parseAllowedOrigins(required(env, "APP_ALLOWED_ORIGINS"), production);

  const parsedSupabaseUrl = new URL(supabaseUrl);
  const parsedIssuer = new URL(jwtIssuer);
  if (parsedSupabaseUrl.protocol !== "https:" || parsedIssuer.protocol !== "https:") {
    throw new Error("Supabase URL and JWT issuer must use HTTPS.");
  }
  if (parsedIssuer.origin !== parsedSupabaseUrl.origin || parsedIssuer.pathname !== "/auth/v1") {
    throw new Error("SUPABASE_JWT_ISSUER must be the configured project's /auth/v1 issuer.");
  }

  return {
    supabaseUrl: parsedSupabaseUrl.origin,
    supabasePublishableKey,
    supabaseSecretKey,
    jwtIssuer: parsedIssuer.toString().replace(/\/$/, ""),
    jwtAudience: required(env, "SUPABASE_JWT_AUDIENCE"),
    cookieSecure,
    sessionHandleSecret,
    csrfSecret,
    allowedOrigins,
    production
  };
}

export function parseAllowedOrigins(value: string, production: boolean) {
  const origins = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (origins.length === 0) throw new Error("APP_ALLOWED_ORIGINS must not be empty.");

  const parsed = origins.map((origin) => {
    if (origin.includes("*")) throw new Error("APP_ALLOWED_ORIGINS does not allow wildcards.");
    const url = new URL(origin);
    if (url.origin !== origin || url.username || url.password) {
      throw new Error("APP_ALLOWED_ORIGINS entries must be exact origins.");
    }
    if (
      production &&
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

function parseBoolean(value: string, key: string) {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${key} must be true or false.`);
}

function optionalEnvironment(value: string | undefined, key: string) {
  const normalized = value?.trim().replace(/^['"]|['"]$/g, "");
  if (!normalized) return undefined;
  if (normalized !== "development" && normalized !== "test" && normalized !== "production") {
    throw new Error(`${key} must be development, test, or production.`);
  }
  return normalized;
}
