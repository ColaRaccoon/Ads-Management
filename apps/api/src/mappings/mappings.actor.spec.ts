import { describe, expect, it, vi } from "vitest";
import { MappingsService } from "./mappings.service";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const SPOOFED_ACTOR_ID = "22222222-2222-4222-8222-222222222222";

describe("MappingsService actor attribution", () => {
  it("attributes product rules and both manual history types to the authenticated actor", async () => {
    const productMatchRuleCreate = vi.fn(async ({ data }) => data);
    const adsetProductHistoryCreate = vi.fn(async ({ data }) => data);
    const adsetStageHistoryCreate = vi.fn(async ({ data }) => data);
    const prisma = {
      product: { findUnique: vi.fn(async () => ({ id: "product-1", isActive: true })) },
      productMatchRule: { create: productMatchRuleCreate },
      metaAdset: {
        findUnique: vi.fn(async () => ({ id: "adset-1" })),
        update: vi.fn(async ({ data }) => data)
      },
      adsetProductHistory: { create: adsetProductHistoryCreate },
      adsetStageHistory: { create: adsetStageHistoryCreate },
      securityAuditEvent: { create: vi.fn(async (args) => args) },
      $transaction: vi.fn(async (callback: (client: unknown) => Promise<unknown>) => callback(prisma))
    };
    const service = new MappingsService(prisma as never);

    await service.createProductRule(
      {
        productId: "product-1",
        matchType: "EXACT",
        pattern: "actor product",
        createdBy: SPOOFED_ACTOR_ID
      },
      ACTOR_ID
    );
    await service.createManualProductMapping(
      {
        metaAdsetId: "adset-1",
        productId: "product-1",
        effectiveFrom: "2026-08-24",
        createdBy: SPOOFED_ACTOR_ID
      },
      ACTOR_ID
    );
    await service.createManualStageMapping(
      {
        metaAdsetId: "adset-1",
        stage: "SC",
        effectiveFrom: "2026-08-24",
        createdBy: SPOOFED_ACTOR_ID
      },
      ACTOR_ID
    );

    expect(productMatchRuleCreate.mock.calls[0][0].data.createdBy).toBe(ACTOR_ID);
    expect(adsetProductHistoryCreate.mock.calls[0][0].data.createdBy).toBe(ACTOR_ID);
    expect(adsetStageHistoryCreate.mock.calls[0][0].data.createdBy).toBe(ACTOR_ID);
  });
});
