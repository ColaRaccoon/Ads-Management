import { AdStage, DecisionType } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { DecisionsService } from "./decisions.service";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";

describe("DecisionsService actor attribution", () => {
  it("stores the same authenticated actor on the run and every child log path", async () => {
    const decisionRunCreate = vi.fn(async ({ data }) => ({ id: "run-1", ...data }));
    let savedLogs: Array<Record<string, unknown>> = [];
    const decisionLogCreateMany = vi.fn(async ({ data }) => {
      savedLogs = data;
      return { count: data.length };
    });
    const prisma = {
      appSetting: { findMany: vi.fn(async () => []) },
      decisionRun: { create: decisionRunCreate },
      decisionLog: {
        createMany: decisionLogCreateMany,
        findMany: vi.fn(async () => savedLogs)
      }
    };
    const metricsService = {
      dashboardSummary: vi.fn(async () => ({
        totals: {
          purchaseCount: 1,
          spendKrw: 100,
          cpaKrw: 100,
          marginKrw: 1,
          ctrLinkPct: 1,
          landingPageViews: 1
        },
        selectedPeriod: { dataDays: 1 }
      })),
      productMetrics: vi.fn(async () => [
        { productId: "product-1", thresholds: null, ruleStatus: "MISSING_COST_RULE" }
      ]),
      adsetMetrics: vi.fn(async () => [
        {
          metaAdsetId: "adset-1",
          thresholds: null,
          ruleStatus: "MISSING_COST_RULE",
          stage: AdStage.SC,
          totals: { marginKrw: 10 }
        }
      ])
    };
    const service = new DecisionsService(prisma as never, metricsService as never);
    (service as unknown as { classifier: { classify: () => unknown[] } }).classifier = {
      classify: () => [
        {
          decision: DecisionType.KEEP,
          severity: 1,
          reason: "keep",
          recommendedAction: null
        }
      ]
    };

    await service.run({ from: "2026-08-24", to: "2026-08-24" }, ACTOR_ID);

    expect(decisionRunCreate.mock.calls[0][0].data.createdBy).toBe(ACTOR_ID);
    expect(decisionLogCreateMany).toHaveBeenCalledOnce();
    expect(savedLogs).toHaveLength(4);
    expect(savedLogs.every((log) => log.createdBy === ACTOR_ID)).toBe(true);
    expect(savedLogs.map((log) => log.scopeType)).toEqual(["OVERALL", "PRODUCT", "ADSET", "STAGE"]);
  });
});
