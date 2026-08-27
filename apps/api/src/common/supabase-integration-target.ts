import path from "node:path";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { assertSupabaseDatabaseBoundaryEvidenceV6 } from "./supabase-database-boundary-evidence";

export function supabaseIntegrationEnabled(flagName: string, databaseUrlName: "DATABASE_URL" | "TEST_DATABASE_URL") {
  if (!new Set(["true", "1"]).has(process.env[flagName] ?? "")) return false;
  const raw = process.env[databaseUrlName];
  if (!raw) throw new Error(`${databaseUrlName} is required for the guarded Supabase integration target.`);
  const target = new URL(raw);
  const projectRef = required("SUPABASE_TEST_PROJECT_REF", /^[a-z]{20}$/);
  const source = verifiedSourceIdentity();
  const mode = required("SUPABASE_TEST_CONNECTION_MODE", /^(?:direct|session_pooler)$/);
  const host = required("SUPABASE_TEST_DATABASE_HOST", /^(?:db\.[a-z]{20}\.supabase\.co|[a-z0-9-]+\.pooler\.supabase\.com)$/);
  const database = required("SUPABASE_TEST_DATABASE_NAME", /^[a-z][a-z0-9_]{0,62}$/);
  const schema = required("SUPABASE_TEST_DATABASE_SCHEMA", /^test_[a-z0-9_]{3,58}$/);
  const role = required("SUPABASE_TEST_DATABASE_USER", /^[a-z][a-z0-9_]{0,62}$/);
  if ((projectRef === source.projectRef && database === source.database) ||
      (projectRef !== source.projectRef && host === source.host) ||
      process.env.CONFIRM_SUPABASE_TEST_PROJECT_REF !== projectRef || process.env.SUPABASE_TEST_MUTATION_APPROVED !== "true") {
    throw new Error("An explicitly confirmed isolated Supabase database distinct from the source database is required.");
  }
  const expectedHost = mode === "direct" ? `db.${projectRef}.supabase.co` : host;
  const expectedUser = mode === "direct" ? role : `${role}.${projectRef}`;
  if (host !== expectedHost || target.protocol !== "postgresql:" || target.hostname !== host || target.port !== "5432" ||
      target.pathname !== `/${database}` || decodeURIComponent(target.username) !== expectedUser || !target.password ||
      target.searchParams.get("schema") !== schema || target.searchParams.get("sslmode") !== "verify-full") {
    throw new Error("The guarded integration DATABASE_URL does not match the exact isolated Supabase target.");
  }
  const rootCertificate = target.searchParams.get("sslrootcert");
  if (!rootCertificate || !path.isAbsolute(rootCertificate)) throw new Error("The guarded Supabase integration target requires an absolute verify-full CA path.");
  return true;
}

function verifiedSourceIdentity() {
  const runtimePath = verifiedJsonPath("SUPABASE_SOURCE_RUNTIME_CONFIG_PATH", "SUPABASE_SOURCE_RUNTIME_CONFIG_SHA256", 1024 * 1024);
  const boundaryPath = verifiedJsonPath("SUPABASE_SOURCE_BOUNDARY_EVIDENCE_PATH", "SUPABASE_SOURCE_BOUNDARY_EVIDENCE_SHA256", 256 * 1024);
  const runtime = JSON.parse(readFileSync(runtimePath, "utf8")) as Record<string, unknown>;
  const database = runtime.database as Record<string, unknown> | undefined;
  const boundary = JSON.parse(readFileSync(boundaryPath, "utf8")) as Record<string, unknown>;
  const projectRef = String(database?.projectRef ?? "");
  const host = String(database?.host ?? "");
  const name = String(database?.name ?? "");
  const schema = String(database?.schema ?? "");
  const connectionMode = String(database?.connectionMode ?? "");
  const runtimeUser = String(database?.runtimeUser ?? "");
  const migrationUser = String(database?.migrationUser ?? "");
  const backupUser = String(database?.backupUser ?? "");
  const restoreUser = String(database?.restoreUser ?? "");
  const caCertificateSha256 = String(database?.caCertificateSha256 ?? "");
  if (runtime.deploymentMode !== "local_lan" || database?.provider !== "supabase_postgres" ||
      !/^[a-z]{20}$/.test(projectRef) || (connectionMode !== "direct" && connectionMode !== "session_pooler") ||
      ![runtimeUser,migrationUser,backupUser,restoreUser].every((value)=>/^[a-z][a-z0-9_]{0,62}$/.test(value)) ||
      !/^[0-9a-f]{64}$/.test(caCertificateSha256)) {
    throw new Error("The source Supabase identity evidence is invalid.");
  }
  try {
    assertSupabaseDatabaseBoundaryEvidenceV6(boundary, {
      projectRef, connectionMode, host, databaseName: name, databaseSchema: schema, runtimeUser,
      migrationUser, backupUser, restoreUser, caCertificateSha256
    });
  } catch {
    throw new Error("The source Supabase identity evidence is invalid.");
  }
  return { projectRef, host, database: name, schema };
}

function verifiedJsonPath(pathName: string, hashName: string, maximumBytes: number) {
  const value = required(pathName, /.+/);
  const expected = required(hashName, /^[0-9a-f]{64}$/);
  if (!path.isAbsolute(value)) throw new Error(`${pathName} must be absolute.`);
  const full = path.resolve(value);
  assertNoSymlinkComponents(full);
  const stat = lstatSync(full);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > maximumBytes) throw new Error(`${pathName} is invalid.`);
  const actual = createHash("sha256").update(readFileSync(full)).digest("hex");
  if (actual !== expected) throw new Error(`${hashName} does not match.`);
  return full;
}

function assertNoSymlinkComponents(target: string) {
  const parsed = path.parse(target);
  let current = parsed.root;
  for (const segment of target.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (lstatSync(current).isSymbolicLink()) throw new Error("Supabase integration evidence must not use symlinks.");
  }
}

function required(name: string, pattern: RegExp) {
  const value = process.env[name]?.trim() ?? "";
  if (!pattern.test(value)) throw new Error(`${name} is invalid.`);
  return value;
}
