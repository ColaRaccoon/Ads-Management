import { createHash, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresSecurityRateLimiter } from "./postgres-security-rate-limiter";

const integrationDescribe = integrationEnabled() ? describe : describe.skip;

integrationDescribe("distributed PostgreSQL rate limiter", () => {
  let prisma: PrismaClient;
  const key = `step6-concurrency:${randomUUID()}`;
  const keyHash = createHash("sha256").update(key).digest("hex");

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    try {
      await prisma.securityRateLimitBucket.deleteMany({ where: { keyHash } });
    } finally {
      await prisma.$disconnect();
    }
  });

  it("shares one atomic counter across independently constructed API stores", async () => {
    const firstInstance = new PostgresSecurityRateLimiter(prisma as never);
    const secondInstance = new PostgresSecurityRateLimiter(prisma as never);
    const decisions = await Promise.all(Array.from({ length: 25 }, (_, index) =>
      (index % 2 === 0 ? firstInstance : secondInstance).consume(key, 10, 300_000)
    ));
    expect(decisions.filter(({ allowed }) => allowed)).toHaveLength(10);
    expect(decisions.filter(({ allowed }) => !allowed)).toHaveLength(15);
    const persisted = await prisma.securityRateLimitBucket.findMany({ where: { keyHash } });
    expect(persisted).toHaveLength(1);
    expect(persisted[0].count).toBe(25);
  });
});

function integrationEnabled() {
  if (process.env.RUN_RATE_LIMIT_DB_INTEGRATION !== "true") return false;
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is required for rate-limit integration tests.");
  const target = new URL(raw);
  if (
    target.hostname !== "127.0.0.1" ||
    target.port !== "55432" ||
    target.pathname !== "/meta_ads_security_dev" ||
    target.searchParams.get("schema") !== "meta_ads_security_dev"
  ) {
    throw new Error("Rate-limit integration tests require the isolated local security dev database.");
  }
  return true;
}
