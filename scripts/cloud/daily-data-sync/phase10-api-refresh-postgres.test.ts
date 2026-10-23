// Real product OAuth + vault transactions, synthetic provider response and
// deliberately mocked remote identity guard on a fresh local-only cluster.
import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { sealCredential } from "../../../apps/api/src/daily-sync/credential-vault";
const raw = process.env.PHASE10_API_SYNTHETIC_TEST_URL;
test("local PG real OAuth and CredentialVault rotate one synthetic pair atomically after backup", { skip: !raw }, async () => {
  assert(raw); const local = new URL(raw); assert.equal(local.hostname, "127.0.0.1"); assert.equal(local.port, "55434");
  assert.equal(local.pathname, "/phase10_api_synthetic_20261019"); assert.equal(local.searchParams.get("schema"), "meta_ads");
  const id = "0c35defe-45fc-4a54-bc79-704df7bca5b1", key = Buffer.alloc(32, 17).toString("base64");
  const previous = process.env.DAILY_SYNC_CREDENTIAL_KEY_V1; process.env.DAILY_SYNC_CREDENTIAL_KEY_V1 = key;
  const db = new PrismaClient({ datasourceUrl: raw }); let requests = 0, backups = 0;
  const events: string[] = [];
  try {
    await db.sourceConnection.create({ data: { id, provider: "CAFE24", externalAccountId: "didadi0729", shopKey: "shop1", currencyCode: "KRW", timeZone: "Asia/Seoul", displayName: "Synthetic local OAuth", enabled: true, accessState: "READY", credentialRef: `source_credentials:${id}:CAFE24_REFRESH`, credentialExpiresAt: new Date("2026-10-31T17:00:16Z") } });
    for (const kind of ["CAFE24_ACCESS", "CAFE24_REFRESH"] as const) await db.sourceCredential.create({ data: {
      connectionId: id, kind, revision: 6, ...sealCredential(kind === "CAFE24_ACCESS" ? "SYNTHETIC_OLD_ACCESS" : "SYNTHETIC_OLD_REFRESH", id, kind, 1),
      expiresAt: new Date(kind === "CAFE24_ACCESS" ? "2026-10-17T19:00:16Z" : "2026-10-31T17:00:16Z") } });
    const factory = () => new Proxy(db, { get(target, prop) {
      if (prop === "$disconnect") return async () => {};
      if (prop === "$transaction") return (fn: any, options: any) => target.$transaction(async tx => fn(new Proxy(tx, { get(t, p) {
        if (p === "$queryRawUnsafe") return async (sql: string, ...params: any[]) => {
          if (sql.startsWith("SELECT current_database() AS database")) {
            const identity = await t.$queryRawUnsafe<Array<{ database: string; schema: string }>>("SELECT current_database() AS database,current_schema() AS schema");
            assert.equal(identity[0].database, "phase10_api_synthetic_20261019"); assert.equal(identity[0].schema, "meta_ads");
            return [{ database: "postgres", role: "phase08_runtime", schema: "phase08_meta_ads", readonly: "on", tables: 68, leases: 0 }];
          }
          return t.$queryRawUnsafe(sql, ...params);
        };
        const value = Reflect.get(t, p); return typeof value === "function" ? value.bind(t) : value;
      } })), options);
      const value = Reflect.get(target, prop); return typeof value === "function" ? value.bind(target) : value;
    } });
    const modulePath = "./phase10-api-cafe-refresh.mjs";
    const { refreshPhase10CafeOnce } = await import(modulePath);
    const out = await refreshPhase10CafeOnce({ projectRef: "ehnfrrmbkvlsbpvqcvkr", classification: "SAME_SCOPE_EXACT_PAIR_REFRESH_ONCE", operationKey: "20261019-real-pg-synthetic",
      databaseUrl: "postgresql://phase08_runtime.ehnfrrmbkvlsbpvqcvkr:synthetic@aws-0-ap-northeast-2.pooler.supabase.com:5432/postgres?schema=phase08_meta_ads&sslmode=verify-full", env: {
        SUPABASE_DATABASE_SCHEMA: "phase08_meta_ads", SUPABASE_DATABASE_RUNTIME_USER: "phase08_runtime", DAILY_SYNC_CREDENTIAL_KEY_V1: key,
        DAILY_SYNC_ACTIVE_KEY_VERSION: "1", DAILY_SYNC_CAFE24_CLIENT_ID: "SYNTHETIC12345", DAILY_SYNC_CAFE24_CLIENT_SECRET: "SYNTHETIC_SECRET",
        DAILY_SYNC_CAFE24_REDIRECT_URI: "https://phase08-daily-data-sync-production.up.railway.app/backend-api/integrations/cafe24/oauth/callback", DAILY_SYNC_CAFE24_ISOLATED_ORIGIN: "https://phase08-daily-data-sync-production.up.railway.app" } }, {
      factory, protect: (snapshot: any) => { backups++; events.push("BACKUP"); assert.deepEqual(snapshot.pair.map((p: any) => p.revision), [6, 6]); return { path: "SYNTHETIC_NOT_A_REAL_BACKUP", sha256: "a".repeat(64), currentUserDpapi: true, currentUserOnlyAcl: true }; },
      request: async (url: URL, options: RequestInit) => { requests++; events.push("TOKEN_POST"); assert.equal(String(url), "https://didadi0729.cafe24api.com/api/v2/oauth/token"); assert.equal(options.method, "POST"); assert.equal(options.redirect, "error");
        const body = new URLSearchParams(String(options.body)); assert.equal(body.get("grant_type"), "refresh_token"); assert.equal(body.get("refresh_token"), "SYNTHETIC_OLD_REFRESH");
        return Response.json({ access_token: "SYNTHETIC_NEW_ACCESS", refresh_token: "SYNTHETIC_NEW_REFRESH", expires_at: new Date(Date.now() + 7200000).toISOString(), refresh_token_expires_at: new Date(Date.now() + 14 * 86400000).toISOString(),
          client_id: "SYNTHETIC12345", mall_id: "didadi0729", shop_no: 1, token_type: "Bearer", scopes: ["mall.read_order"] }); } });
    assert.equal(out.kind, "PHASE10_EXISTING_ISOLATED_CAFE_PAIR_REFRESHED"); assert.equal(requests, 1); assert.equal(backups, 1); assert.deepEqual(events, ["BACKUP", "TOKEN_POST"]);
    const rows = await db.sourceCredential.findMany({ where: { connectionId: id } }); assert.equal(rows.length, 2); assert(rows.every(r => r.revision === 7 && r.refreshOwner === null && r.refreshUntil === null));
    assert.equal(await db.securityAuditEvent.count({ where: { targetId: id, action: "CAFE24_CREDENTIAL_ROTATED" } }), 1);
    assert.equal(await db.syncRun.count({ where: { connectionId: id } }), 0);
    assert.equal((await db.sourceConnection.findUniqueOrThrow({ where: { id } })).accessState, "READY");
    console.log(JSON.stringify({ kind: "PHASE10_SYNTHETIC_REAL_PG_OAUTH_VAULT", providerResponse: "SYNTHETIC", realProviderRequests: 0, tokenTransportMockCalls: requests, backupImplementation: "MOCK", remoteIdentityGuard: "MOCK", actualOAuth: true, actualVaultTransactions: true, pairRevisions: [7, 7], rotationAudits: 1, sourceRuns: 0 }));
  } finally { await db.$disconnect(); if (previous === undefined) delete process.env.DAILY_SYNC_CREDENTIAL_KEY_V1; else process.env.DAILY_SYNC_CREDENTIAL_KEY_V1 = previous; }
});
