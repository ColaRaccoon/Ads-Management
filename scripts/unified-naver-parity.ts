import "reflect-metadata";
import { existsSync, lstatSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Prisma, PrismaClient } from "@prisma/client";
import type { PrismaService } from "../apps/api/src/common/prisma.service";
import { aggregationWorkerDatabaseUrl } from "../apps/api/src/unified-performance/aggregation.worker";
import { UnifiedManagementRepository } from "../apps/api/src/unified-performance/management.repository";
import { UnifiedReportRepository } from "../apps/api/src/unified-performance/report.repository";
import { parseReportQuery } from "../apps/api/src/unified-performance/report-query";
import { summarizeReport } from "../apps/api/src/unified-performance/domain/report-calculation";

const STORES = ["5ba1d3cf-7aee-4cd1-aecd-d44352f665dd", "78f8cb08-ffe3-481a-94d7-be87ae93ed79"] as const;
const SUMMARY_FIELDS = ["totalProductRevenue", "totalAdCost", "estimatedNetProfit", "totalVatAmount", "estimatedDeliveryBaseCost", "customerPaidDeliveryFee", "deliveryMargin", "deliveryUnitCost"] as const;
const PRODUCT_FIELDS = ["totalQuantity", "totalProductRevenue", "totalAdCost", "totalUnitCost", "totalFeeCost", "totalOtherCost", "estimatedNetProfit", "vatAmount"] as const;
const numeric = (value: unknown): string | null => {
  if (typeof value !== "number" && typeof value !== "string" || !/^-?\d+(?:\.\d+)?$/.test(String(value))) return null;
  try { const number = new Prisma.Decimal(value); return number.isFinite() ? number.toFixed(6) : null; } catch { return null; }
};
const sum = (values: readonly unknown[]) => {
  const known = values.map(numeric).filter((value): value is string => value !== null);
  return known.length ? known.reduce((total, value) => total.plus(value), new Prisma.Decimal(0)).toFixed(6) : null;
};
const difference = (a: string | null, b: string | null) => a === null || b === null ? null : new Prisma.Decimal(a).minus(b).toFixed(6);
const fields = (row: Record<string, unknown>, keys: readonly string[]) => Object.fromEntries(keys.map(key => [key, numeric(row[key])]));
// Fixed local financial field names only; store/date values remain bound. No whole payload is selected.
const projection = (keys: readonly string[]) => Prisma.raw(keys.map(key => `CASE WHEN jsonb_typeof(t.payload->'${key}') IN ('number','string') THEN t.payload->>'${key}' END AS "${key}"`).join(","));
function facade(tx: Prisma.TransactionClient): PrismaService {
  return new Proxy(tx, { get(object, key) {
    if (key === "$transaction") return <T>(work: (client: Prisma.TransactionClient) => Promise<T>) => work(tx);
    const value = Reflect.get(object, key); return typeof value === "function" ? value.bind(object) : value;
  } }) as unknown as PrismaService;
}
export async function runNaverParity(args = process.argv.slice(2)) {
  if (args.length !== 1 || !/^--date=\d{4}-\d{2}-\d{2}$/.test(args[0])) throw Error("NAVER_PARITY_ARGUMENT_REJECTED");
  const date = args[0].slice(7);
  if (!Number.isFinite(Date.parse(date + "T00:00:00Z")) || new Date(date + "T00:00:00Z").toISOString().slice(0, 10) !== date) throw Error("NAVER_PARITY_DATE_REJECTED");
  const target = join(tmpdir(), `unified-naver-parity-${date}.json`);
  if (existsSync(target) && (lstatSync(target).isSymbolicLink() || !lstatSync(target).isFile())) throw Error("NAVER_PARITY_OUTPUT_REJECTED");
  const client = new PrismaClient({ datasourceUrl: aggregationWorkerDatabaseUrl() }); let phase = "ROLE";
  try {
    const result = await client.$transaction(async tx => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`; await tx.$executeRaw`SET LOCAL statement_timeout='15000ms'`;
      const [role] = await tx.$queryRaw<Array<{ role: string; rolsuper: boolean; rolbypassrls: boolean; rolcreatedb: boolean; rolcreaterole: boolean; owns: bigint }>>`
        SELECT current_user role,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,(SELECT count(*) FROM pg_tables WHERE tableowner=current_user) owns FROM pg_roles WHERE rolname=current_user`;
      if (!role || role.role !== "meta_ads_unified_worker" || [role.rolsuper, role.rolbypassrls, role.rolcreatedb, role.rolcreaterole].some(flag => flag !== false) || String(role.owns) !== "0") throw Error("NAVER_PARITY_RESTRICTED_WORKER_REQUIRED");
      const repository = new UnifiedReportRepository(new UnifiedManagementRepository(facade(tx))), scopes = await repository.access(["NAVER"]);
      if (!STORES.every(key => scopes.some(scope => scope.platform === "NAVER" && scope.scopeKey === key))) throw Error("NAVER_PARITY_AUTHORIZED_SCOPES_REQUIRED");
      const snapshot = await repository.snapshot(parseReportQuery({ from: date, to: date, compareFrom: date, compareTo: date, platforms: ["NAVER"], scopeKeys: [...STORES], grain: "day" }));
      const stores = [];
      for (let ordinal = 0; ordinal < STORES.length; ordinal++) {
        phase = `STORE_${ordinal + 1}`; const scope = STORES[ordinal];
        const summaries = await tx.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`SELECT ${projection(SUMMARY_FIELDS)},t.payload->>'calculationVersion' AS version,t.payload->>'profitStatus' AS status
          FROM public.daily_store_summaries t WHERE t.payload->>'storeId'=${scope} AND t.payload->>'date'=${date} ORDER BY t.id LIMIT 3`);
        const products = await tx.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`SELECT ${projection(PRODUCT_FIELDS)},t.payload->>'calculationVersion' AS version,t.payload->>'profitStatus' AS status
          FROM public.daily_sales_unit_profits t WHERE t.payload->>'storeId'=${scope} AND t.payload->>'date'=${date} ORDER BY t.id LIMIT 10001`);
        const fakes = await tx.$queryRaw<Array<{ amount: unknown }>>(Prisma.sql`SELECT ${projection(["amount"])} FROM public.daily_fake_purchases t WHERE t.payload->>'storeId'=${scope} AND t.payload->>'date'=${date} ORDER BY t.id LIMIT 10001`);
        if (summaries.length > 1 || products.length > 10000 || fakes.length > 10000) throw Error("NAVER_PARITY_SOURCE_BOUND_EXCEEDED");
        const summary = summaries[0], fake = sum(fakes.map(row => row.amount)), displayed = difference(summary ? numeric(summary.estimatedNetProfit) : null, fake ?? "0");
        const published = summarizeReport(snapshot.facts.filter(row => row.platform === "NAVER" && row.scopeKey === scope && row.date === date), snapshot.coverage.filter(row => row.platform === "NAVER" && row.scopeKey === scope && row.date === date), { platforms: ["NAVER"] });
        stores.push({ ordinal: ordinal + 1, nativeStoredSummary: summary ? { ...fields(summary, SUMMARY_FIELDS), versionMatches: summary.version === "profit-v2", complete: summary.status === "COMPLETE" } : null,
          nativeProducts: products.map((row, index) => ({ ordinal: index + 1, ...fields(row, PRODUCT_FIELDS), versionMatches: row.version === "profit-v2", complete: row.status === "COMPLETE" })),
          nativeProductTotals: Object.fromEntries(PRODUCT_FIELDS.map(key => [key, sum(products.map(row => row[key]))])), fakeRowCount: fakes.length,
          invalidFakeRows: fakes.filter(row => numeric(row.amount) === null).length, fakePurchaseAmount: fake, nativeDisplayedNetAfterFakePurchase: displayed,
          published: { knownTotals: published.knownTotals, completeTotals: published.completeTotals, issues: published.issues.filter(issue => /^[A-Z][A-Z0-9_:.-]{0,127}$/.test(issue)) }, nativeMinusPublishedNet: difference(displayed, published.knownTotals.estimatedProfit) });
      }
      return { status: "COMPLETE", operation: "READ_ONLY_NAVER_STORED_PARITY", date, observedAt: new Date().toISOString(), sourceWrites: 0, publicationWrites: 0, role: "meta_ads_unified_worker", repeatableRead: true,
        note: "Top-level stored financial rows only; nested childRows never summed. Native displayed net is stored summary net minus fake purchase once. Identifiers and names omitted.", stores };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 10000, timeout: 90000 });
    writeFileSync(target, JSON.stringify(result, null, 2) + "\n", { mode: 0o600 }); return { status: result.status, date, readOnly: true, output: target };
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    writeFileSync(target, JSON.stringify({ status: "NAVER_PARITY_FAILED", readOnly: true, date, phase, ...(typeof code === "string" && /^P\d{4}$/.test(code) ? { prismaCode: code } : {}) }, null, 2) + "\n", { mode: 0o600 }); throw Error("NAVER_PARITY_FAILED");
  } finally { await client.$disconnect(); }
}
if (require.main === module) runNaverParity().then(result => process.stdout.write(JSON.stringify(result) + "\n")).catch(() => { process.stderr.write("NAVER_PARITY_FAILED\n"); process.exitCode = 1; });
