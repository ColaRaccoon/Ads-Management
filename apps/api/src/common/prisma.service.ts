import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { PrismaIdlePool, resolvePrismaIdleDisconnectMs } from "./prisma-idle";

export const DEFAULT_PRISMA_CONNECTION_LIMIT = 1;

export function databaseUrlWithConnectionLimit(
  databaseUrl: string | undefined,
  configuredLimit: string | undefined = process.env.PRISMA_CONNECTION_LIMIT
) {
  if (!databaseUrl) return undefined;

  const connectionLimit = configuredLimit?.trim()
    ? parseConnectionLimit(configuredLimit)
    : DEFAULT_PRISMA_CONNECTION_LIMIT;
  const url = new URL(databaseUrl);
  url.searchParams.set("connection_limit", String(connectionLimit));
  // Prisma 6 does not implement libpq's verify-full mode. Translate the
  // validated deployment setting so neither TLS nor certificate checks fall back.
  if (url.searchParams.get("sslmode") === "verify-full") {
    url.searchParams.set("sslmode", "require");
    url.searchParams.set("sslaccept", "strict");
    const rootCertificate = url.searchParams.get("sslrootcert");
    if (rootCertificate) {
      url.searchParams.set("sslcert", rootCertificate);
      url.searchParams.delete("sslrootcert");
    }
  }
  return url.toString();
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly idlePool?: PrismaIdlePool;

  constructor() {
    const datasourceUrl = databaseUrlWithConnectionLimit(process.env.DATABASE_URL);
    super(datasourceUrl ? { datasourceUrl } : {});
    const idleMs = resolvePrismaIdleDisconnectMs(process.env.PRISMA_IDLE_DISCONNECT_MS);
    if (idleMs > 0) {
      const logger = new Logger(PrismaService.name);
      const pool = new PrismaIdlePool(idleMs, () => super.$disconnect(), () => {
        logger.warn("Idle database pool close failed; retrying after the next idle window.");
      });
      this.idlePool = pool;
      this.$use((params, next) => pool.run(() => next(params)));
      // Middleware leases alone do not cover gaps inside an interactive
      // transaction. Keep its entire lifetime (and array transactions) leased.
      const transaction = this.$transaction.bind(this);
      this.$transaction = ((...args: unknown[]) => pool.run(() =>
        Reflect.apply(transaction, this, args)
      )) as typeof this.$transaction;
    }
  }

  async onModuleInit() {
    if (this.idlePool) await this.idlePool.run(() => this.$connect());
    else await this.$connect();
  }

  async onModuleDestroy() {
    if (this.idlePool) await this.idlePool.shutdown();
    else await this.$disconnect();
  }
}

function parseConnectionLimit(value: string) {
  const normalized = value.trim();
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw new Error("PRISMA_CONNECTION_LIMIT must be a positive integer.");
  }
  return Number(normalized);
}
