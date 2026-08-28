import { describe, expect, it, vi } from "vitest";
import { MatchSource, MatchType, RowValidationStatus } from "@prisma/client";
import { toDateOnly } from "../domain/date-number";
import { acquireMetaAdsetMappingFences, MappingsService } from "./mappings.service";

describe("MappingsService rematch", () => {
  it("acquires unique adset fences in stable lexical order", async () => {
    const queries: unknown[] = [];
    await acquireMetaAdsetMappingFences({
      $queryRaw: vi.fn(async (query: unknown) => { queries.push(query); return []; })
    } as never, ["adset-z", "adset-a", "adset-z"]);

    expect(queries.map((query) => (query as { values?: unknown[] }).values?.[0])).toEqual([
      "meta-adset-mapping:adset-a",
      "meta-adset-mapping:adset-z"
    ]);
  });

  it("rematches ad-level metrics even when no adset-level metrics are unmatched", async () => {
    const prisma = fakePrisma();
    const service = new MappingsService(prisma as never);

    const result = await service.rematchCurrentMetrics({ from: "2026-06-11", to: "2026-06-11" });

    expect(result).toMatchObject({
      scannedCount: 1,
      rematchedCount: 0,
      rematchedAdMetricCount: 1,
      stillUnmatchedCount: 0
    });
    expect(prisma.metaAdDailyMetric.updates[0]).toMatchObject({
      where: { id: "ad-metric-gyro" },
      data: {
        productId: "product-gyro",
        productMatchSource: MatchSource.RULE,
        productMatchRuleId: "rule-gyro"
      }
    });
    expect(prisma.uploadRow.updateManyCalls[0]).toMatchObject({
      where: { id: "upload-row-gyro", productId: null },
      data: {
        productId: "product-gyro",
        productMatchSource: MatchSource.RULE,
        productMatchRuleId: "rule-gyro",
        validationStatus: RowValidationStatus.VALID
      }
    });
  });

  it("does not rematch an ad metric twice when its unmatched adset metric processes the same date", async () => {
    const prisma = fakePrisma({ includeUnmatchedAdset: true, includeSourceRows: true });
    const service = new MappingsService(prisma as never);

    const result = await service.rematchCurrentMetrics({ from: "2026-06-11", to: "2026-06-11" });

    expect(result).toMatchObject({
      scannedCount: 1,
      rematchedCount: 1,
      rematchedAdMetricCount: 1,
      stillUnmatchedCount: 0
    });
    expect(prisma.metaAdDailyMetric.updates).toHaveLength(1);
    expect(prisma.metaAdsetDailyMetric.updates).toHaveLength(1);
  });

  it("keeps currentProductId aligned to the latest already-mapped current metric", async () => {
    const prisma = fakePrisma({
      includeUnmatchedAdset: true,
      includeSourceRows: true,
      latestAdsetProductId: "product-newer"
    });
    const service = new MappingsService(prisma as never);

    await service.rematchCurrentMetrics({ from: "2026-06-11", to: "2026-06-11" });

    expect(prisma.metaAdset.updates.at(-1)).toMatchObject({
      where: { id: "adset-gyro" },
      data: { currentProductId: "product-newer" }
    });
  });

  it("re-reads behind the shared adset fence so a committed manual mapping cannot be overwritten by a stale rule", async () => {
    const waiting = deferred<void>();
    const releaseRematch = deferred<void>();
    const metric = {
      id: "metric-race", metricDate: date("2026-06-11"), adsetName: "자이로볼",
      metaAdsetId: "adset-race", uploadRowId: null, isCurrent: true,
      productId: null as string | null, productMatchSource: MatchSource.UNMATCHED,
      productMatchRuleId: null as string | null
    };
    const histories: Array<Record<string, unknown>> = [];
    const lockQueries: unknown[] = [];
    let transactionNumber = 0;
    const tx = {
      $queryRaw: vi.fn(async (query: unknown) => { lockQueries.push(query); return []; }),
      metaAdset: {
        findUnique: vi.fn(async () => ({ id: "adset-race" })),
        update: vi.fn(async ({ data }: { data: { currentProductId?: string } }) => data)
      },
      product: { findUnique: vi.fn(async () => ({ id: "manual-product", isActive: true })) },
      adsetProductHistory: {
        findMany: vi.fn(async () => histories),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          const row = { id: "history-race", ...data };
          histories.push(row);
          return row;
        })
      },
      productMatchRule: { findMany: vi.fn(async () => [{
        id: "stale-rule", productId: "rule-product", matchType: MatchType.CONTAINS,
        pattern: "자이로볼", patternKey: "자이로볼", priority: 1,
        validFrom: date("2026-01-01"), validTo: null, isActive: true
      }]) },
      metaAdsetDailyMetric: {
        findUnique: vi.fn(async () => ({ ...metric })),
        update: vi.fn(async ({ data }: { data: Partial<typeof metric> }) => Object.assign(metric, data)),
        updateMany: vi.fn(async ({ data }: { data: Partial<typeof metric> }) => {
          Object.assign(metric, data); return { count: 1 };
        })
      },
      metaAdDailyMetric: {
        findMany: vi.fn(async () => []),
        updateMany: vi.fn(async () => ({ count: 0 }))
      },
      uploadRow: { update: vi.fn(), updateMany: vi.fn(async () => ({ count: 0 })) },
      securityAuditEvent: { create: vi.fn(async ({ data }: { data: unknown }) => data) }
    };
    const prisma = {
      metaAdsetDailyMetric: { findMany: vi.fn(async () => [{ ...metric }]) },
      metaAdDailyMetric: { findMany: vi.fn(async () => []) },
      $transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => {
        transactionNumber += 1;
        if (transactionNumber === 1) {
          waiting.resolve();
          await releaseRematch.promise;
        }
        return work(tx);
      })
    };
    const service = new MappingsService(prisma as never);

    const rematch = service.rematchCurrentMetrics({ from: "2026-06-11", to: "2026-06-11" });
    await waiting.promise;
    await service.createManualProductMapping({
      metaAdsetId: "adset-race", productId: "manual-product",
      effectiveFrom: "2026-06-11", applyCurrentMetrics: true
    }, "actor-manual");
    releaseRematch.resolve();

    await expect(rematch).resolves.toMatchObject({ rematchedCount: 0, stillUnmatchedCount: 0 });
    expect(metric).toMatchObject({ productId: "manual-product", productMatchSource: MatchSource.MANUAL });
    expect(tx.productMatchRule.findMany).not.toHaveBeenCalled();
    expect(lockQueries).toHaveLength(2);
    expect(lockQueries.map((query) => (query as { values?: unknown[] }).values?.[0]))
      .toEqual(["meta-adset-mapping:adset-race", "meta-adset-mapping:adset-race"]);
  });
});

function fakePrisma(options: {
  includeUnmatchedAdset?: boolean;
  includeSourceRows?: boolean;
  latestAdsetProductId?: string;
} = {}) {
  const metaAdDailyUpdates: unknown[] = [];
  const metaAdsetDailyUpdates: unknown[] = [];
  const uploadRowUpdateManyCalls: unknown[] = [];
  const metaAdsetUpdates: unknown[] = [];
  const adMetric = {
    id: "ad-metric-gyro",
    uploadRowId: "upload-row-gyro",
    metaAdsetRefId: "adset-gyro",
    metricDate: date("2026-06-11"),
    adNameSnapshot: "자이로볼 소재 01",
    adsetNameSnapshot: "SC 테스트",
    campaignNameSnapshot: "자이로볼 캠페인",
    productId: null,
    productMatchSource: MatchSource.UNMATCHED,
    productMatchRuleId: null
  };
  const unmatchedAdsetMetric = {
    id: "adset-metric-gyro",
    metricDate: date("2026-06-11"),
    adsetName: "SC 테스트",
    metaAdsetId: "adset-gyro",
    uploadRowId: "upload-row-adset-gyro"
  };
  const rules = [
    {
      id: "rule-gyro",
      productId: "product-gyro",
      matchType: MatchType.CONTAINS,
      pattern: "자이로볼",
      patternKey: "자이로볼",
      priority: 1,
      validFrom: date("2026-01-01"),
      validTo: null,
      isActive: true
    }
  ];
  const tx = {
    $queryRaw: async () => [],
    metaAdsetDailyMetric: {
      findUnique: async () => options.includeUnmatchedAdset
        ? { ...unmatchedAdsetMetric, isCurrent: true, productId: null }
        : null,
      update: async (args: unknown) => {
        metaAdsetDailyUpdates.push(args);
        return args;
      },
      findFirst: async () => ({ productId: options.latestAdsetProductId ?? "product-gyro" })
    },
    metaAdDailyMetric: {
      findUnique: async () => ({ ...adMetric, isCurrent: true }),
      findMany: async () => options.includeSourceRows ? [adMetric] : [],
      update: async (args: unknown) => {
        metaAdDailyUpdates.push(args);
        return args;
      }
    },
    uploadRow: {
      updateMany: async (args: unknown) => {
        uploadRowUpdateManyCalls.push(args);
        return { count: 1 };
      },
      update: async (args: unknown) => args
    },
    adsetProductHistory: { findMany: async () => [] },
    productMatchRule: { findMany: async () => rules },
    metaAdset: {
      update: async (args: unknown) => {
        metaAdsetUpdates.push(args);
        return args;
      }
    }
  };

  return {
    metaAdsetDailyMetric: {
      updates: metaAdsetDailyUpdates,
      findMany: async () => options.includeUnmatchedAdset ? [unmatchedAdsetMetric] : [],
      findFirst: async () => null
    },
    metaAdDailyMetric: {
      updates: metaAdDailyUpdates,
      findMany: async (args: { where?: { productId?: null } }) => {
        if (args.where?.productId === null) {
          return [adMetric];
        }
        return options.includeSourceRows ? [adMetric] : [];
      }
    },
    adsetProductHistory: {
      findMany: async () => []
    },
    productMatchRule: {
      findMany: async () => rules
    },
    metaAdset: {
      updates: metaAdsetUpdates,
      update: async (args: unknown) => args
    },
    uploadRow: {
      updateManyCalls: uploadRowUpdateManyCalls
    },
    $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)
  };
}

function date(value: string) {
  const parsed = toDateOnly(value);
  if (!parsed) {
    throw new Error(`Invalid test date: ${value}`);
  }
  return parsed;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
