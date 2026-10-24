import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { PrismaService } from "../../../apps/api/src/common/prisma.service";
import { CredentialVault, sealCredential } from "../../../apps/api/src/daily-sync/credential-vault";
import { cafe24ManualPreparationPreview, prepareCafe24ManualConnection } from "../../../apps/api/src/daily-sync/cafe24-manual-preparation";
import { Cafe24DayActivationInput } from "../../../apps/api/src/daily-sync/daily-sync.dto";
import { assertCafe24AuthorizationEnabled, assertCafe24TestReadEnabled, assertEnabled, assertSourceAdministrationEnabled } from "../../../apps/api/src/daily-sync/sync-contract";
import { cafe24TestAllowed } from "../../../apps/api/src/daily-sync/cafe24-test-connection.service";

test("preparation flag admits administration while collection stays disabled", () => {
  const env = { DAILY_SYNC_FEATURE_ENABLED: "false", DAILY_SYNC_SOURCE_ADMIN_ENABLED: "true" };
  assert.doesNotThrow(() => assertSourceAdministrationEnabled(env));
  assert.doesNotThrow(() => assertCafe24AuthorizationEnabled(env));
  assert.throws(() => assertCafe24TestReadEnabled(env));
  assert(cafe24TestAllowed("synthetic", "shop1", { ...env, DAILY_SYNC_ALLOWED_ACCOUNTS: '["CAFE24/synthetic/shop1","META/123/default"]' }));
  assert(!cafe24TestAllowed("foreign", "shop1", { ...env, DAILY_SYNC_ALLOWED_ACCOUNTS: '["CAFE24/synthetic/shop1"]' }));
  assert.throws(() => assertEnabled(env));
  assert.throws(() => assertSourceAdministrationEnabled({ ...env, DAILY_SYNC_SOURCE_ADMIN_ENABLED: "false" }));
});

test("activation rejects invalid nested review counts and request fields", async () => {
  const input = { day: "2026-10-23", expectedPolicyVersion: 1, expectedSuccessRunId: randomUUID(),
    reason: "REVIEWED_API_DAY", mode: "API_ONLY", couponInputSource: "UNKNOWN", expectedSnapshotDigest: "a".repeat(64) };
  assert.equal((await validate(plainToInstance(Cafe24DayActivationInput, input), { whitelist: true, forbidNonWhitelisted: true })).length, 0);
  for (const patch of [{ expectedPolicyVersion: 0 }, { expectedSnapshotDigest: "forged" },
    { expectedInputDifferences: { totalOrderOrders: -1, paidOrders: 0, paymentMethodOrders: 0, couponSignalOrders: 0 } },
    { bypass: true }]) {
    assert((await validate(plainToInstance(Cafe24DayActivationInput, { ...input, ...patch }), { whitelist: true, forbidNonWhitelisted: true })).length > 0);
  }
});

const raw = process.env.SOURCE_PREP_SYNTHETIC_URL;
test("local PG preparation enforces OAuth vault binding, expiry, CAS, CSV conflict and atomic audit", { skip: !raw }, async () => {
  assert(raw); const url = new URL(raw);
  assert.equal(url.hostname, "127.0.0.1"); assert.equal(url.port, "55436");
  assert.equal(url.pathname, "/sourceprep_synthetic_20261024"); assert.equal(url.searchParams.get("schema"), "public");
  const before = { ...process.env };
  Object.assign(process.env, { DATABASE_URL: raw, PRISMA_IDLE_DISCONNECT_MS: "0", PRISMA_CONNECTION_LIMIT: "3",
    DAILY_SYNC_FEATURE_ENABLED: "false", DAILY_SYNC_SOURCE_ADMIN_ENABLED: "true",
    DAILY_SYNC_CAFE24_MANUAL_PREPARATION_ENABLED: "true", DAILY_SYNC_CREDENTIAL_KEY_V1: randomBytes(32).toString("base64") });
  const db = new PrismaService(), actor = await db.appUser.create({ data: { name: "Synthetic preparation operator", role: "SUPER_ADMIN", inviteStatus: "ACTIVE" } });
  const day = new Date(Date.now() - 3 * 86400_000).toISOString().slice(0, 10);
  async function fixture() {
    const account = "synthetic-" + randomUUID();
    process.env.DAILY_SYNC_ALLOWED_ACCOUNTS = JSON.stringify([`CAFE24/${account}/shop1`]);
    const connection = await db.sourceConnection.create({ data: { provider: "CAFE24", externalAccountId: account,
      shopKey: "shop1", displayName: "Synthetic only", currencyCode: "KRW", timeZone: "Asia/Seoul" } });
    await new CredentialVault(db).storeCafe24Pair({ connectionId: connection.id, access: "SYNTHETIC_ACCESS",
      refresh: "SYNTHETIC_REFRESH", accessExpiresAt: new Date(Date.now() + 3600_000),
      refreshExpiresAt: new Date(Date.now() + 86400_000), expectedRefreshRevision: null, actorUserId: actor.id });
    const preview = await cafe24ManualPreparationPreview(db, connection.id);
    assert(!JSON.stringify(preview).match(/SYNTHETIC_ACCESS|SYNTHETIC_REFRESH|ciphertext|authTag|credentialRef/));
    return { id: connection.id, input: { fromDate: day, expectedUpdatedAt: preview.updatedAt,
      expectedAccessRevision: 1, expectedRefreshRevision: 1 } };
  }
  try {
    for (const mode of ["stale", "expired", "refresh-owner", "wrong-aad", "revision", "csv", "audit-fault"]) {
      const { id, input } = await fixture();
      if (mode === "stale") input.expectedUpdatedAt = new Date(0).toISOString();
      if (mode === "revision") input.expectedAccessRevision = 2;
      if (mode === "expired") await db.sourceCredential.updateMany({ where: { connectionId: id, kind: "CAFE24_ACCESS" }, data: { expiresAt: new Date(0) } });
      if (mode === "refresh-owner") await db.sourceCredential.updateMany({ where: { connectionId: id, kind: "CAFE24_REFRESH" }, data: { refreshOwner: randomUUID(), refreshUntil: new Date(Date.now() + 60000) } });
      if (mode === "wrong-aad") await db.sourceCredential.updateMany({ where: { connectionId: id, kind: "CAFE24_ACCESS" }, data: sealCredential("SYNTHETIC", randomUUID(), "CAFE24_ACCESS", 1) });
      let csv: { id: string } | undefined;
      if (mode === "csv") csv = await db.cafe24OrderLine.create({ data: { source: "CSV", orderLineKey: randomUUID(), orderNo: "synthetic", lineOrderNo: "synthetic", productNo: "1", productName: "Synthetic", optionName: "Synthetic", orderDate: new Date(`${day}Z`) } });
      const target = mode === "audit-fault" ? randomUUID() : actor.id;
      await assert.rejects(prepareCafe24ManualConnection(db, id, input, target));
      assert.equal((await db.sourceConnection.findUniqueOrThrow({ where: { id } })).enabled, false);
      assert.equal(await db.sourcePolicy.count({ where: { connectionId: id } }), 0);
      assert.equal(await db.securityAuditEvent.count({ where: { targetId: id, action: "CAFE24_MANUAL_PREPARED" } }), 0);
      if (csv) await db.cafe24OrderLine.delete({ where: { id: csv.id } });
    }
    const { id, input } = await fixture();
    const outcomes = await Promise.allSettled([prepareCafe24ManualConnection(db, id, input, actor.id), prepareCafe24ManualConnection(db, id, input, actor.id)]);
    assert.equal(outcomes.filter(r => r.status === "fulfilled").length, 1);
    assert.equal(await db.sourcePolicy.count({ where: { connectionId: id, primarySource: "CSV", version: 1 } }), 1);
    assert.equal(await db.securityAuditEvent.count({ where: { targetId: id, action: "CAFE24_MANUAL_PREPARED" } }), 1);
    assert.equal(await db.syncRun.count(), 0);
    assert.equal(process.env.DAILY_SYNC_FEATURE_ENABLED, "false");
    assert.equal(process.env.DAILY_SYNC_SCHEDULE_ENABLED, before.DAILY_SYNC_SCHEDULE_ENABLED);
    console.log(JSON.stringify({ localOnly: true, providerRequests: 0, concurrentWinner: 1, failedPreparationRollback: true, csvPrimary: true }));
  } finally { await db.$disconnect(); process.env = before; }
});
