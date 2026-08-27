import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateLocalApiConfigText } from "./api-config.mjs";

const root = mkdtempSync(path.join(tmpdir(), "meta-ads-api-config-"));
const caPath = path.join(root, "keys", "supabase-db-ca.crt");
const caBytes = Buffer.from("synthetic-test-ca", "utf8");
mkdirSync(path.dirname(caPath), { recursive: true });
writeFileSync(caPath, caBytes);
test.after(() => rmSync(root, { recursive: true, force: true }));
const runtime = {
  internalPorts: { web: 3200, api: 4200 }, data: { root },
  database: { provider: "supabase_postgres", projectRef: "abcdefghijklmnopqrst", connectionMode: "session_pooler", host: "aws-0-ap-northeast-2.pooler.supabase.com", port: 5432, name: "postgres", runtimeUser: "meta_runtime", schema: "public", caCertificatePath: caPath, caCertificateSha256: createHash("sha256").update(caBytes).digest("hex") },
  lan: { enabled: false, hostname: null },
  hostSecurity: { edgeSigningPublicKeyPath: path.join(root, "keys", "edge-public.pem") }
};
const secret = (prefix) => `${prefix}6a9d3f4187c2e9051ab6d7f830c4e92a5b8d1f6073c9e41a6b2d8f5071c3e94`;
const valid = () => [
  "APP_ENV=production", "DEPLOYMENT_MODE=local_lan", "AUTH_PROVIDER=local", "STORAGE_PROVIDER=local",
  "SUPABASE_DATABASE_PROJECT_REF=abcdefghijklmnopqrst", "SUPABASE_DATABASE_CONNECTION_MODE=session_pooler",
  "SUPABASE_DATABASE_HOST=aws-0-ap-northeast-2.pooler.supabase.com", "SUPABASE_DATABASE_RUNTIME_USER=meta_runtime", `SUPABASE_DATABASE_CA_CERT_PATH=${caPath}`,
  "AUTH_COOKIE_SECURE=true", "TRUST_PROXY_HOPS=0", "PORT=4200",
  `APP_DATA_ROOT=${root}`, `UPLOAD_STORAGE_DIR=${path.join(root,"storage","uploads")}`,
  `REPORT_STORAGE_DIR=${path.join(root,"storage","reports")}`,
  `LOCAL_EDGE_PUBLIC_KEY_PATH=${path.join(root,"keys","edge-public.pem")}`,
  `DATABASE_URL=postgresql://meta_runtime.abcdefghijklmnopqrst:synthetic-password@aws-0-ap-northeast-2.pooler.supabase.com:5432/postgres?schema=public&sslmode=verify-full&sslrootcert=${encodeURIComponent(caPath)}`,
  "APP_ALLOWED_ORIGINS=https://127.0.0.1:3200", "AUTH_COOKIE_NAMESPACE=local-prod",
  `AUTH_SESSION_HANDLE_SECRET=${secret("A")}`, `AUTH_AUTHORIZATION_VERSION_SECRET=${secret("B")}`,
  `AUTH_CSRF_SECRET=${secret("C")}`, `AUTH_LOCAL_SESSION_TOKEN_SECRET=${secret("D")}`,
  `AUTH_LOCAL_SETUP_TOKEN_SECRET=${secret("E")}`, `AUTH_LOCAL_RATE_LIMIT_SECRET=${secret("F")}`,
  `INTERNAL_PROBE_TOKEN=${secret("G")}`
].join("\n");

test("binds external API configuration to the portable runtime config without returning secrets", () => {
  const result = validateLocalApiConfigText(valid(), runtime);
  assert.equal(result.publicConfig.dataRoot, root);
  assert.match(result.publicFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(result).includes("synthetic-password"), false);
});

test("rejects path drift, unapproved database routing, cloud Auth/Storage configuration and secret reuse", () => {
  assert.throws(() => validateLocalApiConfigText(valid().replace(`APP_DATA_ROOT=${root}`, `APP_DATA_ROOT=${path.resolve(root,"other")}`), runtime), /APP_DATA_ROOT_MISMATCH/);
  assert.throws(() => validateLocalApiConfigText(valid().replace("aws-0-ap-northeast-2.pooler.supabase.com:5432", "evil.invalid:5432"), runtime), /DATABASE_TARGET_MISMATCH/);
  assert.throws(() => validateLocalApiConfigText(valid().replace("sslmode=verify-full", "sslmode=require"), runtime), /DATABASE_TLS_REQUIRED/);
  assert.throws(() => validateLocalApiConfigText(`${valid()}\nSUPABASE_URL=https://example.invalid`, runtime), /CLOUD_CONFIGURATION_FORBIDDEN/);
  const reused = valid().replace(`AUTH_CSRF_SECRET=${secret("C")}`, `AUTH_CSRF_SECRET=${secret("A")}`);
  assert.throws(() => validateLocalApiConfigText(reused, runtime), /SECRET_REUSE_REJECTED/);
  assert.throws(() => validateLocalApiConfigText(valid().replace("synthetic-password", secret("A")), runtime), /SECRET_REUSE_REJECTED/);
});
