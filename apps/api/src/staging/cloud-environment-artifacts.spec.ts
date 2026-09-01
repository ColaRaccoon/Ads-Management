import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseEnv } from "node:util";
import { describe, expect, it } from "vitest";
import { validateRuntimeEnvironment } from "../common/http-security.config";

const root = path.basename(process.cwd()).toLowerCase() === "api"
  ? path.resolve(process.cwd(), "../..")
  : process.cwd();

describe("cloud environment artifact", () => {
  it("contains every startup binding and validates after approved values are injected", async () => {
    const example = parseEnv(await readFile(path.join(root, "deploy/cloud/.env.example"), "utf8"));
    const projectRef = "abc123def456ghi789jk";
    const issuer = `https://${projectRef}.supabase.co/auth/v1`;
    const environment = {
      ...example,
      PORT: "8000",
      RELEASE_GIT_SHA: "25748e71a95a09990968e0f198c5fd877897dc88",
      DATABASE_URL: `postgresql://meta_runtime:synthetic@db.${projectRef}.supabase.co:5432/postgres?schema=public&sslmode=verify-full&connection_limit=2`,
      SUPABASE_DATABASE_PROJECT_REF: projectRef,
      SUPABASE_DATABASE_CONNECTION_MODE: "direct",
      SUPABASE_DATABASE_HOST: `db.${projectRef}.supabase.co`,
      SUPABASE_DATABASE_RUNTIME_USER: "meta_runtime",
      SUPABASE_DATABASE_NAME: "postgres",
      SUPABASE_DATABASE_SCHEMA: "public",
      SUPABASE_URL: `https://${projectRef}.supabase.co`,
      SUPABASE_PUBLISHABLE_KEY: "sb_publishable_synthetic",
      SUPABASE_SECRET_KEY: "sb_secret_synthetic",
      SUPABASE_JWT_ISSUER: issuer,
      SUPABASE_STORAGE_BUCKET: "synthetic-private",
      SUPABASE_STORAGE_ACCESS_TOKEN: storageJwt(issuer),
      SUPABASE_STORAGE_TOKEN_SUBJECT: "synthetic-storage",
      AUTH_COOKIE_NAMESPACE: "cloud-test",
      APP_ALLOWED_ORIGINS: "https://app.example.com",
      AUTH_INVITE_REDIRECT_ORIGIN: "https://app.example.com",
      AUTH_SESSION_HANDLE_SECRET: "4f68a2417e7c4fb7bf0663649c671b91406f6d7986061527f5e84a7894b6e45f",
      AUTH_AUTHORIZATION_VERSION_SECRET: "8b3ca7f1a62e49cd9058d27e183bfa645e71c328f4a09d6be2c7351f680ad942",
      AUTH_CSRF_SECRET: "7c778290a780dd14e507ef0282c50aa5f6ee4d955e13ab76d19714226520ca44",
      INTERNAL_PROBE_TOKEN: "aa35e635992217a3295b8690b6c4f01eeb3e6e309ebf9a9e7eb86c42e0f2cf9d",
      RUNTIME_DATABASE_ID: "synthetic-db",
      RUNTIME_STORAGE_ID: "synthetic-storage"
    };

    expect(validateRuntimeEnvironment(environment)).toMatchObject({
      DEPLOYMENT_MODE: "cloud_container",
      AUTH_PROVIDER: "supabase",
      STORAGE_PROVIDER: "supabase",
      PRISMA_CONNECTION_LIMIT: "2",
      RELEASE_GIT_SHA: environment.RELEASE_GIT_SHA
    });
  });
});

function storageJwt(issuer: string) {
  const encode = (value: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
    iss: issuer,
    aud: "authenticated",
    sub: "synthetic-storage",
    role: "storage_app",
    exp: Math.floor(Date.now() / 1_000) + 7 * 24 * 60 * 60
  })}.synthetic-signature`;
}
