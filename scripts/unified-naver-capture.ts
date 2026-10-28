import { writeFileSync } from "node:fs";
import { naverQueries } from "../apps/api/src/unified-performance/adapters/naver-reader";

// Same bound SQL as the runtime reader. Hash identifiers inside PostgreSQL before data leaves the server.
const quote = (value: unknown): string => typeof value === "number" ? String(value) : `'${String(value).replaceAll("'", "''")}'`;
const render = (query: ReturnType<typeof naverQueries>["stores"]) => query.strings.reduce((sql, part, index) => sql + part + (index < query.values.length ? quote(query.values[index]) : ""), "");
const ids = ["id", "storeId", "externalProductOrderId", "orderSourceSignatureId", "canonicalSalesUnitId", "productId", "parentSalesUnitId", "snapshotId", "sourceUploadId", "campaignId", "orderId", "packageNumber", "replacedUploadId"];
const names = ["rawProductName", "rawOptionInfo", "productName", "productNameFallback", "rawProductNameSnapshot", "rawOptionInfoSnapshot", "normalizedProductName", "normalizedOptionInfo", "campaignName"];
const pseudonym = (value: string) => `substr(md5(${value}),1,8)||'-'||substr(md5(${value}),9,4)||'-4'||substr(md5(${value}),14,3)||'-8'||substr(md5(${value}),18,3)||'-'||substr(md5(${value}),21,12)`;
const scrub = (sql: string) => {
  const replacements = [
    ...ids.map(key => `'${key}',CASE WHEN j->>'${key}' IS NULL THEN NULL ELSE ${pseudonym(`j->>'${key}'`)} END`),
    ...names.map(key => `'${key}',CASE WHEN j->>'${key}' ~ '([0-9]{2,3}[- ][0-9]{3,4}[- ][0-9]{4}|@)' THEN '[REDACTED_NAME]' ELSE j->>'${key}' END`)
  ].join(",");
  return `SELECT count(*)::text AS row_count,coalesce(jsonb_agg(j || jsonb_build_object(${replacements})),'[]'::jsonb) AS rows FROM (SELECT to_jsonb(t) AS j FROM (${sql}) t) projected`;
};
const queries: { name: string; sql: string }[] = [{ name: "identity", sql: "SELECT current_database() db,current_user role,current_setting('transaction_read_only') read_only" },
  { name: "catalog", sql: "SELECT display_name AS \"canonicalName\",is_active AS active FROM meta_ads.products ORDER BY display_name,id LIMIT 1000" }];
for (const [label, scope] of [["infinity", "5ba1d3cf-7aee-4cd1-aecd-d44352f665dd"], ["patima", "78f8cb08-ffe3-481a-94d7-be87ae93ed79"]]) {
  for (const [table, query] of Object.entries(naverQueries(scope, "2026-10-26")))
    queries.push({ name: `${label}:2026-10-26:${table}`, sql: scrub(render(query)) });
}
writeFileSync("docs/product-performance/research/05-live-queries-20261028.json", JSON.stringify(queries, null, 2) + "\n");
console.log(JSON.stringify({ queries: queries.length, sourceProjections: "runtime SQL", day: "2026-10-26", storeCount: 2, identifiersHashedOnServer: true }));
