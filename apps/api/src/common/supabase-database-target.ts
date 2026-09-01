import path from "node:path";

export type SupabaseDatabaseTarget = {
  projectRef: string;
  connectionMode: "direct" | "session_pooler";
  host: string;
  port: "5432";
  database: string;
  schema: string;
  runtimeUser: string;
  connectionUser: string;
  caCertificatePath: string | null;
};

export type SupabaseDatabaseTlsTrust = "configured_ca" | "system";

export function validateSupabaseDatabaseTarget(
  env: NodeJS.ProcessEnv,
  value = env.DATABASE_URL,
  options: { tlsTrust?: SupabaseDatabaseTlsTrust } = {}
): SupabaseDatabaseTarget {
  if (!value) throw new Error("DATABASE_URL is required.");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("DATABASE_URL must be a valid PostgreSQL URL."); }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") throw new Error("DATABASE_URL must use PostgreSQL.");
  const projectRef = env.SUPABASE_DATABASE_PROJECT_REF?.trim() ?? "";
  const connectionMode = env.SUPABASE_DATABASE_CONNECTION_MODE?.trim().toLowerCase();
  const host = env.SUPABASE_DATABASE_HOST?.trim().toLowerCase() ?? "";
  const runtimeUser = env.SUPABASE_DATABASE_RUNTIME_USER?.trim() ?? "";
  const caCertificatePath = env.SUPABASE_DATABASE_CA_CERT_PATH?.trim() ?? "";
  const tlsTrust = options.tlsTrust ?? "configured_ca";
  if (!/^[a-z0-9]{20}$/.test(projectRef) || (connectionMode !== "direct" && connectionMode !== "session_pooler") ||
      !/^[a-z][a-z0-9_]{0,62}$/.test(runtimeUser) ||
      (tlsTrust === "configured_ca" && !path.isAbsolute(caCertificatePath))) {
    throw new Error("Exact Supabase database target configuration is required.");
  }
  if (tlsTrust === "system" && caCertificatePath) {
    throw new Error("cloud_container must use system TLS trust and rejects SUPABASE_DATABASE_CA_CERT_PATH.");
  }
  if (url.hostname !== host || url.port !== "5432") throw new Error("DATABASE_URL does not match the exact Supabase database host and port.");
  if (connectionMode === "direct" && host !== `db.${projectRef}.supabase.co`) throw new Error("Direct Supabase database host does not match the project ref.");
  if (connectionMode === "session_pooler" && !/^[a-z0-9-]+\.pooler\.supabase\.com$/.test(host)) throw new Error("Supabase session pooler host is invalid.");
  let connectionUser: string;
  try { connectionUser = decodeURIComponent(url.username); } catch { throw new Error("DATABASE_URL user is invalid."); }
  const expectedUser = connectionMode === "session_pooler" ? `${runtimeUser}.${projectRef}` : runtimeUser;
  if (connectionUser !== expectedUser || !url.password) throw new Error("DATABASE_URL runtime identity is invalid.");
  const allowed = new Set([
    "schema", "connection_limit", "pool_timeout", "connect_timeout", "sslmode",
    ...(tlsTrust === "configured_ca" ? ["sslrootcert"] : [])
  ]);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) throw new Error("DATABASE_URL query parameter is not allowed.");
  }
  if (url.searchParams.get("sslmode") !== "verify-full" ||
      (tlsTrust === "configured_ca" &&
        path.resolve(url.searchParams.get("sslrootcert") ?? "") !== path.resolve(caCertificatePath))) {
    throw new Error("DATABASE_URL requires sslmode=verify-full and the configured Supabase CA certificate.");
  }
  const database = url.pathname.slice(1);
  const schema = url.searchParams.get("schema") ?? "public";
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(database) || !/^[a-z][a-z0-9_]{0,62}$/.test(schema)) throw new Error("DATABASE_URL database or schema is invalid.");
  return {
    projectRef,
    connectionMode,
    host,
    port: "5432",
    database,
    schema,
    runtimeUser,
    connectionUser,
    caCertificatePath: tlsTrust === "configured_ca" ? path.resolve(caCertificatePath) : null
  };
}
