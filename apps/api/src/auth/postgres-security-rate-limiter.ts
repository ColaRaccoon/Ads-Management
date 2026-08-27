import { createHash } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../common/prisma.service";
import type { RateLimitDecision, SecurityRateLimiter } from "./request-security.service";

type RateLimitRow = {
  count: number;
  retryAfterSeconds: number;
};

/**
 * A fixed-window limiter whose counter increment and decision are one PostgreSQL
 * statement. Database time defines the window, so API instance clock skew cannot
 * split a bucket. Raw IP/account/path material is never persisted.
 */
@Injectable()
export class PostgresSecurityRateLimiter implements SecurityRateLimiter {
  private readonly logger = new Logger(PostgresSecurityRateLimiter.name);
  private requestsSinceCleanup = 0;

  constructor(private readonly prisma: PrismaService) {}

  async consume(key: string, limit: number, windowMs: number): Promise<RateLimitDecision> {
    assertPolicy(limit, windowMs);
    const keyHash = createHash("sha256").update(key, "utf8").digest("hex");
    const rows = await this.prisma.$queryRaw<RateLimitRow[]>(Prisma.sql`
      WITH bucket_clock AS (
        SELECT
          clock_timestamp() AS now,
          date_bin(
            (${windowMs}::text || ' milliseconds')::interval,
            clock_timestamp(),
            TIMESTAMPTZ '1970-01-01 00:00:00+00'
          ) AS window_start
      )
      INSERT INTO "security_rate_limit_buckets" (
        "key_hash", "window_start", "window_ms", "count", "expires_at", "updated_at"
      )
      SELECT
        ${keyHash},
        bucket_clock.window_start,
        ${windowMs},
        1,
        bucket_clock.window_start + (${windowMs}::text || ' milliseconds')::interval,
        bucket_clock.now
      FROM bucket_clock
      ON CONFLICT ("key_hash", "window_start", "window_ms") DO UPDATE
      SET
        "count" = LEAST("security_rate_limit_buckets"."count" + 1, 2147483647),
        "updated_at" = clock_timestamp()
      RETURNING
        "count",
        GREATEST(
          1,
          CEIL(EXTRACT(EPOCH FROM ("expires_at" - clock_timestamp())))::integer
        ) AS "retryAfterSeconds"
    `);
    const row = rows[0];
    if (!row) throw new Error("The distributed rate limit store returned no decision.");

    this.requestsSinceCleanup += 1;
    if (this.requestsSinceCleanup >= 256) {
      this.requestsSinceCleanup = 0;
      await this.removeExpiredBuckets();
    }

    return {
      allowed: row.count <= limit,
      limit,
      remaining: Math.max(0, limit - row.count),
      retryAfterSeconds: row.retryAfterSeconds
    };
  }

  private async removeExpiredBuckets() {
    try {
      await this.prisma.$executeRaw(Prisma.sql`
        DELETE FROM "security_rate_limit_buckets" WHERE "expires_at" < clock_timestamp()
      `);
    } catch {
      this.logger.warn("Expired distributed rate-limit buckets could not be removed.");
    }
  }
}

function assertPolicy(limit: number, windowMs: number) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000_000) {
    throw new Error("Rate-limit policy limit is out of range.");
  }
  if (!Number.isInteger(windowMs) || windowMs < 1_000 || windowMs > 86_400_000) {
    throw new Error("Rate-limit policy window is out of range.");
  }
}
