import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { databaseUrlWithConnectionLimit } from "../common/prisma.service";
import { PrismaIdlePool, resolvePrismaIdleDisconnectMs } from "../common/prisma-idle";

const disabledUrl = "postgresql://unified_disabled@127.0.0.1:1/unified_disabled?schema=meta_ads";
const invalid = (): never => { throw new Error("UNIFIED_RUNTIME_DATABASE_URL_INVALID"); };
function connection(value: string | undefined): URL {
  if (!value) return invalid();
  let url: URL;
  try { url = new URL(value); } catch { return invalid(); }
  const targetOverrides = ["options", "host", "port", "user", "password", "database", "dbname", "search_path"];
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.username ||
      !url.pathname || url.pathname === "/" || url.hash || targetOverrides.some(key => url.searchParams.has(key))) return invalid();
  try { decodeURIComponent(url.username); decodeURIComponent(url.pathname); } catch { return invalid(); }
  return url;
}

/** An enabled module never falls back to the existing source/credential-capable app login. */
export function unifiedRuntimeDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.UNIFIED_PERFORMANCE_ENABLED !== "true") return undefined;
  if (!env.UNIFIED_RUNTIME_DATABASE_URL) throw new Error("UNIFIED_RUNTIME_DATABASE_URL_REQUIRED");
  const runtime = connection(env.UNIFIED_RUNTIME_DATABASE_URL), legacy = connection(env.DATABASE_URL);
  const username = (url: URL) => decodeURIComponent(url.username);
  if (username(runtime) === username(legacy)) throw new Error("UNIFIED_RUNTIME_REQUIRES_DISTINCT_ROLE");
  if (["postgres", "supabase_admin", "service_role", "authenticator"].includes(username(runtime).split(".")[0]))
    throw new Error("UNIFIED_RUNTIME_REQUIRES_RESTRICTED_ROLE");
  if (runtime.hostname !== legacy.hostname || (runtime.port || "5432") !== (legacy.port || "5432") ||
      decodeURIComponent(runtime.pathname) !== decodeURIComponent(legacy.pathname) ||
      runtime.searchParams.getAll("schema").length !== 1 || legacy.searchParams.getAll("schema").length !== 1 ||
      runtime.searchParams.get("schema") !== "meta_ads" || legacy.searchParams.get("schema") !== "meta_ads")
    throw new Error("UNIFIED_RUNTIME_TARGET_MISMATCH");
  // Supabase pooler endpoints are shared across projects; database name/host alone is insufficient.
  if (runtime.hostname.endsWith(".pooler.supabase.com") &&
      (username(runtime).split(".").length !== 2 || username(legacy).split(".").length !== 2 ||
       username(runtime).split(".")[1] !== username(legacy).split(".")[1]))
    throw new Error("UNIFIED_RUNTIME_TARGET_MISMATCH");
  return databaseUrlWithConnectionLimit(env.UNIFIED_RUNTIME_DATABASE_URL, env.PRISMA_CONNECTION_LIMIT);
}

@Injectable()
export class UnifiedRuntimePrisma extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly enabled: boolean;
  private readonly idlePool?: PrismaIdlePool;

  constructor() {
    const url = unifiedRuntimeDatabaseUrl();
    super({ datasourceUrl: url ?? disabledUrl });
    this.enabled = url !== undefined;
    const idleMs = this.enabled ? resolvePrismaIdleDisconnectMs(process.env.PRISMA_IDLE_DISCONNECT_MS) : 0;
    const logger = new Logger(UnifiedRuntimePrisma.name);
    const pool = idleMs > 0 ? new PrismaIdlePool(idleMs, () => super.$disconnect(), () => {
      logger.warn("Unified idle database pool close failed; retrying after the next idle window.");
    }) : undefined;
    this.idlePool = pool;
    const active = () => {
      if (!this.enabled || process.env.UNIFIED_PERFORMANCE_ENABLED !== "true") throw new Error("UNIFIED_RUNTIME_DISABLED");
    };
    this.$use((params, next) => {
      active();
      return pool ? pool.run(() => next(params)) : next(params);
    });
    // Lease the whole interactive transaction, including gaps between queries.
    const transaction = this.$transaction.bind(this);
    this.$transaction = ((...args: unknown[]) => {
      active();
      const run = () => Reflect.apply(transaction, this, args);
      return pool ? pool.run(run) : run();
    }) as typeof this.$transaction;
  }

  async onModuleInit() {
    if (!this.enabled) return;
    const connect = async () => {
      await this.$connect();
      const roles = await this.$queryRaw<Array<{ rolsuper: boolean; rolbypassrls: boolean; rolcreatedb: boolean; rolcreaterole: boolean; owns: bigint }>>`
        SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,
          (SELECT count(*) FROM pg_tables WHERE tableowner=current_user) owns
        FROM pg_roles WHERE rolname=current_user`;
      if (roles.length !== 1 || Object.values(roles[0]).some(Boolean))
        throw new Error("UNIFIED_RUNTIME_REQUIRES_RESTRICTED_ROLE");
    };
    try { if (this.idlePool) await this.idlePool.run(connect); else await connect(); }
    catch {
      if (this.idlePool) await this.idlePool.shutdown().catch(() => undefined);
      else await this.$disconnect().catch(() => undefined);
      // Prisma/provider errors can contain connection details. Expose a stable safe code only.
      throw new Error("UNIFIED_RUNTIME_STARTUP_REJECTED");
    }
  }

  async onModuleDestroy() {
    if (!this.enabled) return;
    if (this.idlePool) await this.idlePool.shutdown();
    else await this.$disconnect();
  }
}
