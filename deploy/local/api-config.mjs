import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import path from "node:path";

const SECRET_KEYS = [
  "AUTH_SESSION_HANDLE_SECRET", "AUTH_AUTHORIZATION_VERSION_SECRET", "AUTH_CSRF_SECRET",
  "AUTH_LOCAL_SESSION_TOKEN_SECRET", "AUTH_LOCAL_SETUP_TOKEN_SECRET", "AUTH_LOCAL_RATE_LIMIT_SECRET",
  "INTERNAL_PROBE_TOKEN"
];

export function validateLocalApiConfigText(text, runtime) {
  let env;
  try { env = parseEnv(text); } catch { fail("API_CONFIG_PARSE_FAILED"); }
  for (const key of ["SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SECRET_KEY", "SUPABASE_JWT_ISSUER", "SUPABASE_STORAGE_ACCESS_TOKEN"]) {
    if (env[key]?.trim()) fail("CLOUD_CONFIGURATION_FORBIDDEN");
  }
  exact(env.APP_ENV, "production", "APP_ENV_MISMATCH");
  exact(env.DEPLOYMENT_MODE, "local_lan", "DEPLOYMENT_MODE_MISMATCH");
  exact(env.AUTH_PROVIDER, "local", "AUTH_PROVIDER_MISMATCH");
  exact(env.STORAGE_PROVIDER, "local", "STORAGE_PROVIDER_MISMATCH");
  exact(env.SUPABASE_DATABASE_PROJECT_REF, runtime.database.projectRef, "DATABASE_PROJECT_REF_MISMATCH");
  exact(env.SUPABASE_DATABASE_CONNECTION_MODE, runtime.database.connectionMode, "DATABASE_CONNECTION_MODE_MISMATCH");
  exact(env.SUPABASE_DATABASE_HOST, runtime.database.host, "DATABASE_HOST_MISMATCH");
  exact(env.SUPABASE_DATABASE_RUNTIME_USER, runtime.database.runtimeUser, "DATABASE_RUNTIME_USER_MISMATCH");
  if (path.resolve(required(env.SUPABASE_DATABASE_CA_CERT_PATH, "DATABASE_CA_PATH_REQUIRED")) !== path.resolve(runtime.database.caCertificatePath)) fail("DATABASE_CA_PATH_MISMATCH");
  exact(env.AUTH_COOKIE_SECURE, "true", "COOKIE_SECURITY_MISMATCH");
  exact(env.TRUST_PROXY_HOPS ?? "0", "0", "PROXY_TRUST_MISMATCH");
  exact(env.PORT, String(runtime.internalPorts.api), "API_PORT_MISMATCH");
  const edgePublicKeyPath = path.resolve(required(env.LOCAL_EDGE_PUBLIC_KEY_PATH, "LOCAL_EDGE_PUBLIC_KEY_PATH_REQUIRED"));
  if (edgePublicKeyPath !== path.resolve(runtime.hostSecurity.edgeSigningPublicKeyPath)) fail("EDGE_PUBLIC_KEY_PATH_MISMATCH");

  const dataRoot = path.resolve(required(env.APP_DATA_ROOT, "APP_DATA_ROOT_REQUIRED"));
  if (dataRoot !== path.resolve(runtime.data.root)) fail("APP_DATA_ROOT_MISMATCH");
  const uploadRoot = path.resolve(required(env.UPLOAD_STORAGE_DIR, "UPLOAD_STORAGE_DIR_REQUIRED"));
  const reportRoot = path.resolve(required(env.REPORT_STORAGE_DIR, "REPORT_STORAGE_DIR_REQUIRED"));
  if (uploadRoot !== path.join(dataRoot, "storage", "uploads") || reportRoot !== path.join(dataRoot, "storage", "reports")) {
    fail("STORAGE_ROOT_MISMATCH");
  }

  let database;
  try { database = new URL(required(env.DATABASE_URL, "DATABASE_URL_REQUIRED")); } catch { fail("DATABASE_URL_INVALID"); }
  const expectedDatabaseUser = runtime.database.connectionMode === "session_pooler"
    ? `${runtime.database.runtimeUser}.${runtime.database.projectRef}` : runtime.database.runtimeUser;
  let databaseUser,databasePassword;
  try { databaseUser = decodeURIComponent(database.username); databasePassword=decodeURIComponent(database.password); } catch { fail("DATABASE_TARGET_MISMATCH"); }
  if (database.protocol !== "postgresql:" || database.hostname !== runtime.database.host || Number(database.port) !== runtime.database.port ||
      databaseUser !== expectedDatabaseUser || !databasePassword || !/^[a-z][a-z0-9_]{0,62}$/.test(database.pathname.slice(1))) {
    fail("DATABASE_TARGET_MISMATCH");
  }
  const allowedQuery = new Set(["schema", "connection_limit", "pool_timeout", "connect_timeout", "sslmode", "sslrootcert"]);
  for (const key of database.searchParams.keys()) if (!allowedQuery.has(key) || database.searchParams.getAll(key).length !== 1) fail("DATABASE_QUERY_REJECTED");
  if (database.searchParams.get("sslmode") !== "verify-full") fail("DATABASE_TLS_REQUIRED");
  const sslRootCert = path.resolve(required(database.searchParams.get("sslrootcert"), "DATABASE_CA_PATH_REQUIRED"));
  if (sslRootCert !== path.resolve(runtime.database.caCertificatePath)) fail("DATABASE_CA_PATH_MISMATCH");
  let caBytes;
  try {
    const stat = lstatSync(sslRootCert);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0 || stat.size > 1024 * 1024) fail("DATABASE_CA_FILE_INVALID");
    caBytes = readFileSync(sslRootCert);
  } catch (error) {
    if (error instanceof Error && error.message === "DATABASE_CA_FILE_INVALID") throw error;
    fail("DATABASE_CA_FILE_INVALID");
  }
  if (createHash("sha256").update(caBytes).digest("hex") !== runtime.database.caCertificateSha256) fail("DATABASE_CA_HASH_MISMATCH");
  const databaseSchema = database.searchParams.get("schema") ?? "public";
  if (database.pathname.slice(1) !== runtime.database.name || databaseSchema !== runtime.database.schema) fail("DATABASE_IDENTITY_MISMATCH");

  const expectedOrigin = runtime.lan.enabled
    ? `https://${runtime.lan.hostname}`
    : `https://127.0.0.1:${runtime.internalPorts.web}`;
  exact(env.APP_ALLOWED_ORIGINS, expectedOrigin, "ALLOWED_ORIGIN_MISMATCH");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,18}[a-z0-9])?$/.test(required(env.AUTH_COOKIE_NAMESPACE, "COOKIE_NAMESPACE_REQUIRED"))) fail("COOKIE_NAMESPACE_INVALID");
  const secrets = SECRET_KEYS.map((key) => strongSecret(env[key], key));
  if (new Set([...secrets,databasePassword]).size !== secrets.length+1) fail("SECRET_REUSE_REJECTED");

  const publicConfig = {
    apiPort: Number(env.PORT), dataRoot, uploadRoot, reportRoot,
    databaseProvider: "supabase_postgres", databaseProjectRef: runtime.database.projectRef, databaseConnectionMode: runtime.database.connectionMode,
    databaseHost: database.hostname, databasePort: Number(database.port), databaseName: database.pathname.slice(1),
    databaseUser: runtime.database.runtimeUser, databaseSchema, databaseCaSha256: runtime.database.caCertificateSha256, edgePublicKeyPath, allowedOrigin: expectedOrigin,
    authProvider: "local", storageProvider: "local", cookieNamespace: env.AUTH_COOKIE_NAMESPACE
  };
  return Object.freeze({
    publicConfig: Object.freeze(publicConfig),
    publicFingerprint: createHash("sha256").update(JSON.stringify(publicConfig)).digest("hex")
  });
}

function exact(value, expected, code) { if (value?.trim() !== expected) fail(code); }
function required(value, code) { const result=value?.trim(); if(!result) fail(code); return result; }
function strongSecret(value, key) {
  const secret=required(value, `${key}_REQUIRED`);
  const counts=new Map(); for(const character of secret) counts.set(character,(counts.get(character)??0)+1);
  const entropy=[...counts.values()].reduce((total,count)=>{const p=count/secret.length;return total-count*Math.log2(p);},0);
  if(Buffer.byteLength(secret,"utf8")<32||counts.size<12||entropy<160) fail(`${key}_WEAK`);
  return secret;
}
function fail(code) { throw new Error(code); }
