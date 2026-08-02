import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";

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
  return url.toString();
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    const datasourceUrl = databaseUrlWithConnectionLimit(process.env.DATABASE_URL);
    super(datasourceUrl ? { datasourceUrl } : {});
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}

function parseConnectionLimit(value: string) {
  const normalized = value.trim();
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw new Error("PRISMA_CONNECTION_LIMIT must be a positive integer.");
  }
  return Number(normalized);
}
