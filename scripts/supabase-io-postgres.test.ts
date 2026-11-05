// Starts its own loopback-only synthetic PostgreSQL. No environment DB URLs or business data.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { PrismaClient } from "@prisma/client";
import { sourceDateStatement as before } from "./fixtures/reconciliation-date-baseline";
import { sourceDateStatement as after, ReconciliationRepository } from "../apps/api/src/unified-performance/reconciliation.repository";
import type { PrismaService } from "../apps/api/src/common/prisma.service";
import type { ReportScope } from "../apps/api/src/unified-performance/report.repository";

const fixtureRequire = createRequire(__filename);
const runtime = resolve(process.env.LOCALAPPDATA!, "UnifiedPerformanceStage02");
const { Client } = fixtureRequire(resolve(runtime, "node_modules/pg"));
const bin = resolve(runtime, "node_modules/@embedded-postgres/windows-x64/native/bin");
const sourceDates: Record<string, string> = {
  meta_adset_daily_metrics: "metric_date", google_campaign_daily_costs: "metric_date", cafe24_order_lines: "order_date",
  coupang_sale_lines: "sale_date", coupang_ad_metrics: "metric_date", coupang_manual_purchases: "purchase_date"
};
const platforms = ["META", "GOOGLE", "CAFE24", "COUPANG", "NAVER"] as const;
const scopes: ReportScope[] = platforms.flatMap(platform => ["shop", "LEGACY_UNBOUND"].map(scopeKey => ({ platform, scopeKey, label: "fixture" })));
const root = join(tmpdir(), `supabase-io-${randomUUID()}`), data = join(root, "data");
const owner = "io_fixture_owner", worker = "meta_ads_unified_worker";
const child = (file: string, args: string[], quiet = false) => {
  const result = spawnSync(file, args, { windowsHide: true, encoding: "utf8", timeout: 60000, ...(quiet ? { stdio: "ignore" as const } : {}) });
  assert.equal(result.status, 0, result.stderr ?? "LOCAL_POSTGRES_START_FAILED");
};

test("date discovery preserves results and reduces local query work", async t => {
  const port = await new Promise<number>((done, reject) => {
    const server = createServer(); server.once("error", reject); server.listen(0, "127.0.0.1", () => {
      const address = server.address() as { port: number }; server.close(error => error ? reject(error) : done(address.port));
    });
  });
  mkdirSync(root, { recursive: true });
  let started = false, db: any, prisma: PrismaClient | undefined;
  const measurements: unknown[] = [];
  try {
    child(join(bin, "initdb.exe"), ["-D", data, "-U", owner, "--auth-local=trust", "--auth-host=trust", "--encoding=UTF8", "--locale=C"]);
    child(join(bin, "pg_ctl.exe"), ["-D", data, "-l", join(root, "postgres.log"), "-o",
      `-h 127.0.0.1 -p ${port} -c log_statement=none -c log_min_error_statement=panic`, "-w", "start"], true);
    started = true;
    db = new Client({ host: "127.0.0.1", port, user: owner, database: "postgres" }); await db.connect();
    const identity = (await db.query("SELECT inet_server_addr()::text host,current_user role,current_setting('server_version_num') version")).rows[0];
    assert.equal(identity.host, "127.0.0.1/32"); assert.equal(identity.role, owner); assert.match(identity.version, /^17/);
    await db.query(`CREATE SCHEMA meta_ads; CREATE ROLE ${worker} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
      GRANT USAGE ON SCHEMA meta_ads TO ${worker};
      CREATE TABLE meta_ads.source_connections(id text PRIMARY KEY,provider text);
      CREATE TABLE meta_ads.unified_source_publications(source_system text DEFAULT 'UNIFIED',platform text,scope_key text,business_date date,
        PRIMARY KEY(source_system,platform,scope_key,business_date));
      CREATE INDEX ON meta_ads.unified_source_publications(platform,scope_key,business_date);
      CREATE TABLE meta_ads.unified_reconciliation_checks(platform text,scope_key text,business_date date,last_checked_at timestamptz,
        PRIMARY KEY(platform,scope_key,business_date));
      CREATE INDEX ON meta_ads.unified_reconciliation_checks(platform,scope_key,last_checked_at,business_date);
      CREATE TABLE meta_ads.source_coverage(connection_id text,data_kind text,metric_date date,state text,row_count int,
        last_success_run_id text,last_success_at timestamptz);`);
    for (const [table, date] of Object.entries(sourceDates)) await db.query(`CREATE TABLE meta_ads.${table}
      (${date} date,connection_id text,source text DEFAULT 'CSV',is_current boolean DEFAULT true,validation_status text DEFAULT 'OK');
      CREATE INDEX ON meta_ads.${table}(${date});`);
    for (const table of ["daily_store_summaries", "daily_sales_unit_profits", "daily_fake_purchases"])
      await db.query(`CREATE TABLE public.${table}(payload jsonb); CREATE INDEX ON public.${table}((payload->>'storeId'),(payload->>'date'));`);
    const tables = ["meta_ads.source_connections", "meta_ads.unified_source_publications", "meta_ads.unified_reconciliation_checks", "meta_ads.source_coverage",
      ...Object.keys(sourceDates).map(table => `meta_ads.${table}`), ...["daily_store_summaries", "daily_sales_unit_profits", "daily_fake_purchases"].map(table => `public.${table}`)];
    for (const table of tables) await db.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY; ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
      GRANT SELECT ON ${table} TO ${worker}; CREATE POLICY fixture_read ON ${table} FOR SELECT TO ${worker} USING(true)`);
    prisma = new PrismaClient({ datasourceUrl: `postgresql://${worker}@127.0.0.1:${port}/postgres?schema=meta_ads&connection_limit=1`, log: [] });
    const run = async (builder: typeof before, scope: ReportScope, from = "2026-11-01", through = "2026-11-04", limit = 24) => {
      const sql = builder(scope, from, through, limit);
      return prisma!.$queryRawUnsafe<Array<{ date: string; published: boolean; lastCheckedAt: Date | null }>>(sql.text, ...sql.values);
    };
    const compare = async () => {
      for (const scope of scopes) assert.deepEqual(await run(after, scope), await run(before, scope), `${scope.platform}/${scope.scopeKey}`);
    };
    await t.test("empty sources and publications", compare);
    await t.test("duplicates, invalid JSON dates, future dates, CSV/API ownership and confirmed zero days", async () => {
      for (const [table, date] of Object.entries(sourceDates)) await db.query(`INSERT INTO meta_ads.${table}(${date},connection_id,source,is_current,validation_status)
        SELECT d::date,c,s,current,validation FROM (VALUES ('2026-10-01'),('2026-11-01'),('2026-11-04'),('2026-11-05'),(null)) dates(d)
        CROSS JOIN (VALUES ('shop'::text,'API'),(null,'CSV'),('foreign','API')) con(c,s)
        CROSS JOIN (VALUES (true,'OK'::text),(false,'OK'),(true,'ERROR')) valid(current,validation) CROSS JOIN generate_series(1,5);`);
      for (const table of ["daily_store_summaries", "daily_sales_unit_profits", "daily_fake_purchases"])
        await db.query(`INSERT INTO public.${table}(payload) SELECT jsonb_build_object('storeId',s,'date',d)
          FROM (VALUES ('2026-11-01'),('2026-11-04'),('2026-11-05'),('2026-02-30'),('bad'),(null)) dates(d)
          CROSS JOIN (VALUES ('shop'),('foreign')) stores(s) CROSS JOIN generate_series(1,5)`);
      await db.query(`INSERT INTO meta_ads.source_connections VALUES('shop','CAFE24');
        INSERT INTO meta_ads.source_coverage VALUES('shop','CAFE24_ORDER','2026-10-03','COMPLETE_ZERO',0,'success',now()),
          ('shop','META_ADSET','2026-10-04','COMPLETE_ZERO',0,'success',now()),
          ('shop','GOOGLE_CAMPAIGN','2026-10-05','COMPLETE_ZERO',0,null,null);
        INSERT INTO meta_ads.unified_source_publications(platform,scope_key,business_date)
          SELECT p,s,'2026-09-01' FROM unnest(ARRAY['META','GOOGLE','CAFE24','COUPANG','NAVER']) p CROSS JOIN unnest(ARRAY['shop','LEGACY_UNBOUND']) s;
        INSERT INTO meta_ads.unified_source_publications VALUES('SECOND_SOURCE','META','shop','2026-09-01');
        INSERT INTO meta_ads.unified_reconciliation_checks VALUES('META','shop','2026-11-01','2026-11-03T15:00:00Z');`);
      await compare();
      await db.query("INSERT INTO meta_ads.source_connections VALUES('other','CAFE24')"); await compare();
      await db.query("DELETE FROM meta_ads.source_connections"); await compare();
    });
    await t.test("late arrival, corrected date and cancellation keep historical publication evidence", async () => {
      await db.query("INSERT INTO meta_ads.cafe24_order_lines(order_date,connection_id,source) VALUES('2026-08-01','shop','API')"); await compare();
      await db.query("UPDATE meta_ads.cafe24_order_lines SET order_date='2026-08-02' WHERE order_date='2026-08-01'"); await compare();
      await db.query("UPDATE meta_ads.cafe24_order_lines SET is_current=false WHERE order_date='2026-08-02'; DELETE FROM meta_ads.coupang_sale_lines"); await compare();
      assert((await run(after, scopes.find(s => s.platform === "COUPANG")!)).some(row => row.date === "2026-09-01"));
    });
    await t.test("date boundaries are stable across session timezones, retries and concurrent discoveries", async () => {
      for (const zone of ["UTC", "Asia/Seoul", "America/Los_Angeles"]) {
        await prisma!.$executeRawUnsafe(`SET TIME ZONE '${zone}'`); await compare();
      }
      const repository = new ReconciliationRepository(prisma as unknown as PrismaService);
      const peer = new PrismaClient({ datasourceUrl: `postgresql://${worker}@127.0.0.1:${port}/postgres?schema=meta_ads&connection_limit=1`, log: [] });
      try {
        const results = await Promise.all([repository.discover(scopes, "2026-11-01", "2026-11-04", 24),
          new ReconciliationRepository(peer as unknown as PrismaService).discover(scopes, "2026-11-01", "2026-11-04", 24)]);
        assert.deepEqual(results[0], results[1]); assert.deepEqual(results[0].failures, []);
      } finally { await peer.$disconnect(); }
      await db.query("INSERT INTO meta_ads.coupang_manual_purchases(purchase_date) VALUES('2026-07-01')");
      assert((await repository.discover(scopes, "2026-11-01", "2026-11-04", 24)).candidates.some(row => row.platform === "COUPANG" && row.date === "2026-07-01"));
    });
    await t.test("same-data local benchmark with PostgreSQL buffer and plan metrics", async () => {
      for (const [table, date] of Object.entries(sourceDates)) await db.query(`INSERT INTO meta_ads.${table}(${date},connection_id,source)
        SELECT DATE '2020-01-01'+(i%2400),'shop','API' FROM generate_series(1,48000) i`);
      await db.query(`INSERT INTO meta_ads.unified_source_publications(platform,scope_key,business_date)
        SELECT p,'shop',DATE '2020-01-01'+i FROM unnest(ARRAY['META','GOOGLE','CAFE24','COUPANG','NAVER']) p CROSS JOIN generate_series(0,2399) i ON CONFLICT DO NOTHING;
        INSERT INTO meta_ads.unified_reconciliation_checks
        SELECT p,'shop',DATE '2020-01-01'+i,'2026-11-01T00:00:00Z'::timestamptz+(i%5)*interval '1 minute'
        FROM unnest(ARRAY['META','GOOGLE','CAFE24','COUPANG','NAVER']) p CROSS JOIN generate_series(0,2399) i ON CONFLICT DO NOTHING;
        ANALYZE;`);
      await prisma!.$executeRawUnsafe("SET work_mem='2184kB'");
      for (const platform of ["CAFE24", "COUPANG", "NAVER"] as const) {
        const scope = scopes.find(s => s.platform === platform && s.scopeKey === "shop")!;
        assert.deepEqual(await run(after, scope), await run(before, scope));
        for (const [version, builder] of [["before", before], ["after", after]] as const) {
          const sql = builder(scope, "2026-11-01", "2026-11-04", 24);
          const samples: any[] = [];
          for (let i = 0; i < 3; i++) {
            const result = await prisma!.$queryRawUnsafe<any[]>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql.text}`, ...sql.values);
            const plan = result[0]["QUERY PLAN"][0];
            const nodes: any[] = []; const walk = (node: any) => { nodes.push(node); node.Plans?.forEach(walk); }; walk(plan.Plan);
            samples.push({ executionMs: plan["Execution Time"], planningMs: plan["Planning Time"], returnedRows: plan.Plan["Actual Rows"],
              sharedHits: plan.Plan["Shared Hit Blocks"], sharedReads: plan.Plan["Shared Read Blocks"], tempWritten: plan.Plan["Temp Written Blocks"],
              visitedRows: nodes.reduce((n, x) => n + ((x["Actual Rows"] ?? 0) + (x["Rows Removed by Filter"] ?? 0)) * (x["Actual Loops"] ?? 0), 0),
              scannedRows: nodes.filter(x => /Scan/.test(x["Node Type"])).reduce((n, x) => n + ((x["Actual Rows"] ?? 0) + (x["Rows Removed by Filter"] ?? 0)) * (x["Actual Loops"] ?? 0), 0),
              maxNodeMemoryKb: Math.max(0, ...nodes.map(x => x["Peak Memory Usage"] ?? x["Sort Space Used"] ?? 0)), jit: plan.JIT ?? null });
          }
          measurements.push({ platform, version, samples });
        }
      }
      for (const platform of ["CAFE24", "COUPANG", "NAVER"]) {
        const pair = measurements as Array<{ platform: string; version: string; samples: Array<{ sharedHits: number }> }>;
        assert(pair.find(m => m.platform === platform && m.version === "after")!.samples[0].sharedHits <
          pair.find(m => m.platform === platform && m.version === "before")!.samples[0].sharedHits,
          `${platform}: optimized fixture must perform fewer buffer accesses`);
      }
    });
    writeFileSync(join(tmpdir(), "supabase-io-local-results.json"), JSON.stringify({ status: "PASS", realBusinessData: false,
      remoteWrites: 0, sourceRowsAddedPerTable: 48000, measurements }, null, 2));
    console.log(JSON.stringify({ status: "PASS", report: join(tmpdir(), "supabase-io-local-results.json"), measurements }));
  } finally {
    await prisma?.$disconnect(); await db?.end();
    if (started) child(join(bin, "pg_ctl.exe"), ["-D", data, "-m", "fast", "-w", "stop"], true);
  }
});
