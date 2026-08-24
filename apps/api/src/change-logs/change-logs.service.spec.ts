import { describe, expect, it, vi } from "vitest";
import { ChangeLogsService } from "./change-logs.service";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const SPOOFED_ACTOR_ID = "22222222-2222-4222-8222-222222222222";

describe("ChangeLogsService actor attribution", () => {
  it("stores the authenticated actor for general, creative, and product logs", async () => {
    const changeLogCreate = vi.fn(async ({ data }) => data);
    const creativeChangeLogCreate = vi.fn(async ({ data }) => data);
    const productChangeLogCreate = vi.fn(async ({ data }) => data);
    const prisma = {
      changeLog: { create: changeLogCreate },
      creative: { findFirst: vi.fn(async () => ({ id: "creative-1" })) },
      creativeChangeLog: { create: creativeChangeLogCreate },
      product: { findUnique: vi.fn(async () => ({ id: "product-1" })) },
      productChangeLog: { create: productChangeLogCreate }
    };
    const service = new ChangeLogsService(prisma as never);

    await service.create(
      {
        actionType: "NOTE",
        targetType: "PRODUCT",
        reason: "general",
        createdBy: SPOOFED_ACTOR_ID
      },
      ACTOR_ID
    );
    await service.createCreativeLog(
      "creative-1",
      { reason: "creative", createdBy: SPOOFED_ACTOR_ID },
      ACTOR_ID
    );
    await service.createProductLog(
      "product-1",
      { text: "product", createdBy: SPOOFED_ACTOR_ID },
      ACTOR_ID
    );

    expect(changeLogCreate.mock.calls[0][0].data.createdBy).toBe(ACTOR_ID);
    expect(creativeChangeLogCreate.mock.calls[0][0].data.createdBy).toBe(ACTOR_ID);
    expect(productChangeLogCreate.mock.calls[0][0].data.createdBy).toBe(ACTOR_ID);
  });

  it("preserves a legacy NULL actor in reads", async () => {
    const legacy = { id: "legacy-log", createdBy: null };
    const service = new ChangeLogsService({ changeLog: { findMany: vi.fn(async () => [legacy]) } } as never);

    await expect(service.list()).resolves.toEqual([legacy]);
  });
});
