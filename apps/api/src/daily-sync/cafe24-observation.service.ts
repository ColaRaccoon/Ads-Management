import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../common/prisma.service";
import type { Cafe24OrderPreflightClient } from "./cafe24-order-preflight.client";
import { cafe24TestAllowed } from "./cafe24-test-connection.service";
import { parseIsoDate, syncError } from "./sync-contract";
import { observeCafe24EpochDay, type Cafe24ObservationEpochScope } from "./cafe24-observation-epoch";

/** Durable observation evidence. It never writes canonical rows or source coverage. */
@Injectable()
export class Cafe24ObservationService {
  constructor(private readonly prisma: PrismaService,
    private readonly orders: Pick<Cafe24OrderPreflightClient, "readDayObservedRevision">) {}

  /** Explicit operator-approved epoch capability. No scheduled/legacy entry calls it. */
  observeEpochDay(connectionId: string, day: string, scope: Cafe24ObservationEpochScope) {
    return observeCafe24EpochDay(this.prisma, this.orders, connectionId, day, scope);
  }

  async observeDay(connectionId: string, day: string) {
    const orderDate = parseIsoDate(day);
    const observation = await this.orders.readDayObservedRevision(connectionId, day);
    if (observation.keyVersion !== 1 || observation.epoch) syncError("FIELD_UNSUPPORTED");
    if (observation.day !== day || observation.snapshotComplete !== false ||
        !observation.readComplete ||
        !Number.isInteger(observation.keyVersion) || observation.keyVersion < 1 ||
        observation.rows.length !== observation.orderCount ||
        observation.rows.length > 1_000 || observation.itemCount < observation.orderCount ||
        !/^[a-f0-9]{64}$/.test(observation.snapshotHash) ||
        observation.rows.some((row) => !/^[a-f0-9]{64}$/.test(row.orderKeyHash) ||
          !/^[a-f0-9]{64}$/.test(row.contentHash)) ||
        new Set(observation.rows.map((row) => row.orderKeyHash)).size !== observation.rows.length)
      syncError("RECONCILIATION_FAILED");
    const observationId = randomUUID();
    return this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id" FROM "source_connections" WHERE "id" = ${connectionId}::uuid FOR UPDATE
      `);
      if (locked.length !== 1) syncError("ACCOUNT_SCOPE_MISMATCH");
      const connection = await tx.sourceConnection.findUnique({ where: { id: connectionId },
        select: { provider: true, externalAccountId: true, shopKey: true,
          currencyCode: true, timeZone: true, accessState: true, enabled: true } });
      const isolatedRead = process.env.DAILY_SYNC_FEATURE_ENABLED !== "true" &&
        process.env.DAILY_SYNC_CAFE24_TEST_ENABLED === "true";
      if (!connection || connection.provider !== "CAFE24" ||
          (isolatedRead ? connection.enabled : !connection.enabled) ||
          connection.accessState !== "READY" || connection.currencyCode !== "KRW" ||
          connection.timeZone !== "Asia/Seoul" ||
          !cafe24TestAllowed(connection.externalAccountId, connection.shopKey))
        syncError("ACCOUNT_SCOPE_MISMATCH");
      if (await tx.cafe24ObservedDayCheckpoint.count({ where: {
        connectionId, keyVersion: { not: observation.keyVersion }
      } }) > 0) syncError("FIELD_UNSUPPORTED");
      const checkpoint = await tx.cafe24ObservedDayCheckpoint.findUnique({ where: {
        connectionId_orderDate: { connectionId, orderDate }
      } });
      if (checkpoint && checkpoint.keyVersion !== observation.keyVersion)
        syncError("FIELD_UNSUPPORTED");
      if (checkpoint && checkpoint.queryStartedAt > observation.startedAt)
        syncError("LEASE_LOST");
      const prior = await tx.cafe24ObservedOrderRevision.findMany({ where: {
        connectionId, orderDate, isCurrent: true
      }, select: { orderKeyHash: true, contentHash: true, revision: true } });
      const current = new Map(prior.map((row) => [row.orderKeyHash, row]));
      const next = new Set(observation.rows.map((row) => row.orderKeyHash));
      if (next.size && await tx.cafe24ObservedOrderRevision.count({ where: {
        connectionId, orderKeyHash: { in: [...next] }, isCurrent: true,
        orderDate: { not: orderDate }
      } }) > 0) syncError("RECONCILIATION_FAILED");
      if (current.size !== prior.length || prior.some((row) => !next.has(row.orderKeyHash)))
        syncError("RECONCILIATION_FAILED");
      const unchangedKeys: string[] = [];
      const changedKeys: string[] = [];
      const inserts: Prisma.Cafe24ObservedOrderRevisionCreateManyInput[] = [];
      let newOrders = 0, changedOrders = 0;
      for (const row of observation.rows) {
        const before = current.get(row.orderKeyHash);
        if (before?.contentHash === row.contentHash) {
          unchangedKeys.push(row.orderKeyHash);
          continue;
        }
        if (before) {
          changedKeys.push(row.orderKeyHash);
          changedOrders += 1;
        } else newOrders += 1;
        inserts.push({
          connectionId, orderKeyHash: row.orderKeyHash, revision: (before?.revision ?? 0) + 1,
          orderDate, contentHash: row.contentHash,
          firstObservedAt: observation.startedAt, lastObservedAt: observation.startedAt,
          observationId, isCurrent: true
        });
      }
      if (unchangedKeys.length) {
        const updated = await tx.cafe24ObservedOrderRevision.updateMany({ where: {
          connectionId, orderDate, isCurrent: true,
          orderKeyHash: { in: unchangedKeys }
        }, data: { lastObservedAt: observation.startedAt } });
        if (updated.count !== unchangedKeys.length) syncError("LEASE_LOST");
      }
      if (changedKeys.length) {
        const demoted = await tx.cafe24ObservedOrderRevision.updateMany({ where: {
          connectionId, orderDate, isCurrent: true,
          orderKeyHash: { in: changedKeys }
        }, data: { isCurrent: false } });
        if (demoted.count !== changedKeys.length) syncError("LEASE_LOST");
      }
      if (inserts.length) {
        const created = await tx.cafe24ObservedOrderRevision.createMany({ data: inserts });
        if (created.count !== inserts.length) syncError("LEASE_LOST");
      }
      await tx.cafe24ObservedDayCheckpoint.upsert({ where: {
        connectionId_orderDate: { connectionId, orderDate }
      }, create: { connectionId, orderDate, queryStartedAt: observation.startedAt,
        completedAt: new Date(), observationId, keyVersion: observation.keyVersion,
        orderCount: observation.orderCount,
        itemCount: observation.itemCount, snapshotHash: observation.snapshotHash },
      update: { queryStartedAt: observation.startedAt, completedAt: new Date(),
        observationId, keyVersion: observation.keyVersion,
        orderCount: observation.orderCount, itemCount: observation.itemCount,
        snapshotHash: observation.snapshotHash } });
      return { observedOrders: observation.orderCount, newOrders, changedOrders,
        unchangedOrders: unchangedKeys.length, snapshotComplete: false as const };
    }, { timeout: 60_000 });
  }
}
