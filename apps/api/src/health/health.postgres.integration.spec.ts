import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { HealthService } from "./health.service";
import { supabaseIntegrationEnabled } from "../common/supabase-integration-target";

const integrationDescribe = supabaseIntegrationEnabled("RUN_HEALTH_DB_INTEGRATION", "TEST_DATABASE_URL") ? describe : describe.skip;

integrationDescribe("readiness PostgreSQL transaction", () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasourceUrl: process.env.TEST_DATABASE_URL });
    await prisma.$connect();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("ok", { status: 200 })));
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await prisma.$disconnect();
  });

  it("applies the transaction-local statement deadline before the database probe", async () => {
    const health = new HealthService(
      prisma as never,
      {
        supabaseUrl: "https://synthetic.invalid",
        supabasePublishableKey: "synthetic-publishable"
      } as never,
      {
        readinessTimeoutMs: 1_500,
        databaseReadinessTimeoutMs: 1_000,
        storageCredentialExpiresAtMs: null,
        storageReadinessKey: null
      } as never,
      { get: () => undefined } as never
    );

    await expect(health.assertReady()).resolves.toBeUndefined();
  });
});
