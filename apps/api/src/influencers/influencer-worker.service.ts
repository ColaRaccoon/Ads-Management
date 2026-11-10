import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Prisma, PrismaClient } from "@prisma/client";
import { formatInTimeZone } from "date-fns-tz";
import { databaseUrlWithConnectionLimit } from "../common/prisma.service";
import { formatDateOnly, toDateOnly } from "../domain/date-number";
import { backfillInfluencerCollaboration, projectInfluencerDay } from "./influencer-projector";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WORKER_INTERVAL = MINUTE;
const TRANSACTION_OPTIONS = {
  isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
  maxWait: 1_000,
  timeout: 6_000
};

@Injectable()
export class InfluencerWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(InfluencerWorkerService.name);
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;
  private stopped = false;
  private lastSeed?: { today: string; at: number };
  private lastSourcePollAt = 0;

  onModuleInit() {
    if (process.env.NODE_ENV !== "test") this.schedule(10_000);
  }

  async onModuleDestroy() {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.active;
  }

  private schedule(delay: number) {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.active = this.run().catch(error => this.warn("cycle", error)).finally(() => this.schedule(WORKER_INTERVAL));
    }, delay);
    this.timer.unref();
  }

  private async run() {
    const datasourceUrl = databaseUrlWithConnectionLimit(process.env.DATABASE_URL, "1");
    if (!datasourceUrl) return;
    const url = new URL(datasourceUrl);
    url.searchParams.set("connect_timeout", "3");
    // Independent one-connection pool. Collection never waits on this client's transaction queue.
    const db = new PrismaClient({ datasourceUrl: url.toString() });
    try {
      const now = new Date();
      const today = formatInTimeZone(now, "Asia/Seoul", "yyyy-MM-dd");
      const recentFrom = new Date(toDateOnly(today)!.getTime() - 6 * DAY);
      if (this.lastSeed?.today !== today || now.getTime() - this.lastSeed.at >= HOUR) {
        const seeded = await inWorkerTransaction(db, async tx => {
          // Keep prior jobs even after all source rows for a day are deleted.
          await tx.$executeRaw`
            INSERT INTO influencer_projection_days (metric_date, next_check_at)
            SELECT bounds.first_date + days.offset_day, timestamp '1970-01-01'
            FROM (
              SELECT LEAST(${formatDateOnly(recentFrom)}::date, min(metric_date)) AS first_date
              FROM meta_ad_daily_metrics
            ) bounds
            CROSS JOIN LATERAL generate_series(0, ${today}::date - bounds.first_date) AS days(offset_day)
            ON CONFLICT (metric_date) DO NOTHING`;
          return true;
        });
        if (seeded) this.lastSeed = { today, at: now.getTime() };
      }
      if (now.getTime() - this.lastSourcePollAt >= 5 * MINUTE) {
        const queued = await queueCollectedDays(db, now).catch(error => {
          this.warn("source change poll", error);
          return true;
        });
        if (queued) this.lastSourcePollAt = now.getTime();
      }
      // Reserve capacity for both fresh results and old imports/corrections.
      for (const [recent, limit] of [[true, 2], [false, 4]] as const) {
        for (let count = 0; count < limit && !this.stopped; count++) {
          if (!await this.runDueDay(db, recentFrom, recent)) break;
        }
      }
      for (let count = 0; count < 3 && !this.stopped; count++) {
        if (!await this.runBackfill(db)) break;
      }
    } finally {
      await db.$disconnect();
    }
  }

  private async runDueDay(db: PrismaClient, recentFrom: Date, recent: boolean) {
    const now = new Date();
    let attempted: { metricDate: Date; nextCheckAt: Date; numberingAttempted: boolean } | undefined;
    try {
      return await inWorkerTransaction(db, async tx => {
        const job = await tx.influencerProjectionDay.findFirst({
          where: {
            OR: [{ numberingAttempted: false }, { nextCheckAt: { lte: now } }],
            metricDate: recent ? { gte: recentFrom } : { lt: recentFrom }
          },
          orderBy: [{ numberingAttempted: "asc" }, { nextCheckAt: "asc" }, { metricDate: "desc" }]
        });
        if (!job) return false;
        attempted = { metricDate: job.metricDate, nextCheckAt: job.nextCheckAt, numberingAttempted: job.numberingAttempted };
        await projectInfluencerDay(tx, job.metricDate, now);
        await tx.influencerProjectionDay.update({
          where: { metricDate: job.metricDate },
          data: { numberingAttempted: true, nextCheckAt: new Date(now.getTime() + (recent ? 30 * MINUTE : 7 * DAY)) }
        });
        return true;
      });
    } catch (error) {
      if (!attempted) throw error;
      this.warn(formatDateOnly(attempted.metricDate), error);
      await db.influencerProjectionDay.updateMany({
        where: attempted,
        data: { numberingAttempted: true, nextCheckAt: new Date(now.getTime() + (recent ? 5 * MINUTE : HOUR)) }
      });
      return true;
    }
  }

  private async runBackfill(db: PrismaClient) {
    const now = new Date();
    let attempted: { id: string; version: string; lastJobAt: Date | null } | undefined;
    try {
      return await inWorkerTransaction(db, async tx => {
        const record = await tx.influencerCollaboration.findFirst({
          where: { needsBackfill: true, OR: [{ lastJobAt: null }, { lastJobAt: { lte: new Date(now.getTime() - 5 * MINUTE) } }] },
          orderBy: [{ lastJobAt: { sort: "asc", nulls: "first" } }, { id: "asc" }],
          select: { id: true, version: true, lastJobAt: true }
        });
        if (!record) return false;
        attempted = record;
        await backfillInfluencerCollaboration(tx, record.id, now);
        return true;
      });
    } catch (error) {
      if (!attempted) throw error;
      this.warn("collaboration backfill", error);
      await db.influencerCollaboration.updateMany({
        where: { ...attempted, needsBackfill: true }, data: { lastJobAt: now }
      });
      return true;
    }
  }

  private warn(scope: string, error: unknown) {
    const code = error instanceof Prisma.PrismaClientKnownRequestError ? error.code
      : error instanceof Error ? error.name : "UnknownError";
    this.logger.warn(`Influencer projection will retry (${scope}, ${code})`);
  }
}

function queueCollectedDays(db: PrismaClient, now: Date) {
  // Both signals already exist in the collectors. Persist the new schedule and
  // observed revision together, so restarting a worker cannot lose a queued day.
  return inWorkerTransaction(db, async tx => {
    await tx.$executeRaw`
      WITH changed AS (
        SELECT c.metric_date, c.last_success_at AS source_change_at
        FROM source_coverage c JOIN influencer_projection_days d USING (metric_date)
        WHERE c.data_kind = 'META_AD' AND c.last_success_at IS NOT NULL
          AND (d.last_source_change_at IS NULL OR c.last_success_at > d.last_source_change_at)
        UNION ALL
        SELECT d.metric_date, b.imported_at AT TIME ZONE 'UTC' AS source_change_at
        FROM upload_batches b
        JOIN influencer_projection_days d ON d.metric_date BETWEEN b.report_start AND b.report_end
        WHERE b.level = 'AD' AND b.imported_at IS NOT NULL
          AND (d.last_source_change_at IS NULL OR b.imported_at AT TIME ZONE 'UTC' > d.last_source_change_at)
      ), latest AS (
        SELECT metric_date, max(source_change_at) AS source_change_at FROM changed GROUP BY metric_date
      )
      UPDATE influencer_projection_days d
      SET next_check_at = least(d.next_check_at, ${now}::timestamptz AT TIME ZONE 'UTC'),
          last_source_change_at = latest.source_change_at
      FROM latest WHERE d.metric_date = latest.metric_date`;
    return true;
  });
}

function inWorkerTransaction<T>(db: PrismaClient, work: (tx: Prisma.TransactionClient) => Promise<T>) {
  return db.$transaction(async tx => {
    await tx.$executeRaw`SET LOCAL statement_timeout = '4s'`;
    await tx.$executeRaw`SET LOCAL lock_timeout = '250ms'`;
    const [lock] = await tx.$queryRaw<{ acquired: boolean }[]>`
      SELECT pg_try_advisory_xact_lock(hashtextextended('influencer-performance-projector', 0)) AS acquired`;
    return lock.acquired ? work(tx) : undefined;
  }, TRANSACTION_OPTIONS);
}
