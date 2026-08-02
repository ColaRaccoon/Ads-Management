import { describe, expect, it } from "vitest";
import { MatchSource, MatchType, RowValidationStatus } from "@prisma/client";
import { toDateOnly } from "../domain/date-number";
import { MappingsService } from "./mappings.service";

describe("MappingsService rematch", () => {
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
});

function fakePrisma() {
  const metaAdDailyUpdates: unknown[] = [];
  const uploadRowUpdateManyCalls: unknown[] = [];
  const tx = {
    metaAdDailyMetric: {
      update: async (args: unknown) => {
        metaAdDailyUpdates.push(args);
        return args;
      }
    },
    uploadRow: {
      updateMany: async (args: unknown) => {
        uploadRowUpdateManyCalls.push(args);
        return { count: 1 };
      }
    }
  };

  return {
    metaAdsetDailyMetric: {
      findMany: async () => [],
      findFirst: async () => null
    },
    metaAdDailyMetric: {
      updates: metaAdDailyUpdates,
      findMany: async (args: { where?: { productId?: null } }) =>
        args.where?.productId === null
          ? [
              {
                id: "ad-metric-gyro",
                uploadRowId: "upload-row-gyro",
                metaAdsetRefId: "adset-gyro",
                metricDate: date("2026-06-11"),
                adNameSnapshot: "자이로볼 소재 01",
                adsetNameSnapshot: "SC 테스트",
                campaignNameSnapshot: "자이로볼 캠페인"
              }
            ]
          : []
    },
    adsetProductHistory: {
      findMany: async () => []
    },
    productMatchRule: {
      findMany: async () => [
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
      ]
    },
    metaAdset: {
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
