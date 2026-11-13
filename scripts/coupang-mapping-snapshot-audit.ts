import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { reviewCoupangMappings, type MappingReviewInput } from "../apps/api/src/domain/coupang-mapping-review";

// Offline evidence only. Never connects to a database or changes source snapshots.
const dirs = process.argv.slice(2);
if (!dirs.length) throw new Error("Pass one or more local snapshot directories.");
const maps = { products: new Map<string, any>(), rules: new Map<string, any>(), sales: new Map<string, any>(), ads: new Map<string, any>(), promotions: new Map<string, any>() };
const counts: object[] = [];
for (const directory of dirs) {
  const read = (name: string) => JSON.parse(readFileSync(resolve(directory, `${name}.json`), "utf8"));
  const batches = new Map<string, string>(read("coupangUploadBatch").map((batch: any) => [batch.id, batch.originalFilename]));
  for (const product of read("products").coupang) maps.products.set(product.id, product);
  for (const rule of read("coupangProductRule")) maps.rules.set(rule.id, { ...rule, productId: rule.coupangProductId });
  for (const [kind, file] of [["sales", "coupangSaleLine"], ["ads", "coupangAdMetric"], ["promotions", "coupangPromotionPrice"]] as const) {
    const rows = read(file).filter((row: any) => row.validationStatus !== "ERROR" && (kind === "promotions" || row.isCurrent));
    counts.push({ directory, kind, rows: rows.length });
    for (const row of rows) maps[kind].set(row.id, { ...row, batch: { originalFilename: batches.get(row.uploadBatchId) ?? "" } });
  }
}
const input: MappingReviewInput = Object.fromEntries(Object.entries(maps).map(([name, map]) => [name, [...map.values()]])) as unknown as MappingReviewInput;
const review = reviewCoupangMappings(input);
const covered = new Set(input.rules.map(rule => rule.productId));
const inScope = review.rows.filter(row => row.beforeProductId && covered.has(row.beforeProductId));
const changes = inScope.filter(row => row.change !== "UNCHANGED");
const signatures = new Map<string, any>();
for (const row of inScope) {
  const key = JSON.stringify([row.targetKind, row.beforeProductName, row.productName, row.optionName]);
  const signature = signatures.get(key) ?? { target: row.targetKind, before: row.beforeProductName, after: row.afterProductName,
    productName: row.productName, optionName: row.optionName, rows: 0, firstDate: row.date, lastDate: row.date,
    optionIds: new Set<string>(), reasons: new Set<string>(), amountKrw: 0 };
  signature.rows++; signature.firstDate = [signature.firstDate, row.date].sort()[0]; signature.lastDate = [signature.lastDate, row.date].sort().at(-1);
  if (row.optionId) signature.optionIds.add(row.optionId);
  for (const reason of [row.reason, ...row.reviewReasons]) signature.reasons.add(reason);
  signature.amountKrw += row.amountKrw; signatures.set(key, signature);
}
const output = resolve("reports/coupang-mapping-review-20261113"); mkdirSync(output, { recursive: true });
// Independent, product-specific check after inspecting the original names/options.
// This deliberately does not call the matcher or use its saved include/exclude rules.
const identityChecks = [...signatures.values()].map(signature => {
  const raw = `${signature.productName} ${signature.optionName}`;
  const quantities = [...new Set([...String(signature.optionName || signature.productName).matchAll(/(\d+)\s*개(?:입)?/g)].map(match => match[1]))];
  let expected: string | null = null;
  if (quantities.length === 1 && ["1", "2"].includes(quantities[0])) {
    if (raw.includes("베놈") && raw.includes("무릎보호대")) expected = `베놈${raw.includes("여성") ? "여성" : "공용"}${quantities[0] === "2" ? " 2개입" : ""}`;
    if (raw.includes("두줄") && raw.includes("무릎보호대")) expected = `두줄보호대${quantities[0] === "2" ? " 2개입" : ""}`;
  }
  return { productName: signature.productName, optionName: signature.optionName, target: signature.target, rows: signature.rows,
    before: signature.before, expected, status: expected === null ? "INSUFFICIENT_SOURCE" : expected === signature.before ? "CONSISTENT" : "MISMATCH" };
});
const optionIdentities = new Map<string, Set<string>>();
for (const row of inScope) if (row.optionId && !["-", "0"].includes(row.optionId) && row.productName !== "-") {
  const identities = optionIdentities.get(row.optionId) ?? new Set<string>(); identities.add(row.beforeProductName!); optionIdentities.set(row.optionId, identities);
}
const report = { observedAt: new Date().toISOString(), source: "LOCAL_HISTORICAL_SNAPSHOTS_ONLY", currentProductionVerified: false,
  limitation: "Historical product-specific exports contain only six product rules. Other products and current production issues are not audited.",
  snapshots: counts, coveredProducts: input.products.filter(product => covered.has(product.id)),
  inScopeTargetCount: inScope.length, outOfScopeTargetCount: review.rows.length - inScope.length,
  changedTargetCount: changes.length, reviewTargetCount: inScope.filter(row => row.needsReview).length,
  changes, reviewRows: inScope.filter(row => row.needsReview), identityChecks,
  independentIdentitySummary: Object.fromEntries(["CONSISTENT", "MISMATCH", "INSUFFICIENT_SOURCE"].map(status => [status,
    { signatures: identityChecks.filter(item => item.status === status).length, targets: identityChecks.filter(item => item.status === status).reduce((sum, item) => sum + item.rows, 0) }])),
  optionIdentityConflicts: [...optionIdentities.entries()].filter(([, identities]) => identities.size > 1).map(([optionId, identities]) => {
    const rows = inScope.filter(row => row.optionId === optionId && row.productName !== "-");
    const groups = [...identities].map(product => ({ product, count: rows.filter(row => row.beforeProductName === product).length }));
    const majorityCount = Math.max(...groups.map(group => group.count));
    return { optionId, products: groups, minorityRecords: rows.filter(row => groups.find(group => group.product === row.beforeProductName)!.count < majorityCount),
      interpretation: "Source inconsistency only. Frequency and option IDs do not authorize reassignment; verify original report rows." };
  }),
  signatures: [...signatures.values()].map(signature => ({ ...signature, optionIds: [...signature.optionIds], reasons: [...signature.reasons] })) };
writeFileSync(resolve(output, "snapshot-audit.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ output, inScopeTargetCount: report.inScopeTargetCount, outOfScopeTargetCount: report.outOfScopeTargetCount,
  changedTargetCount: report.changedTargetCount, reviewTargetCount: report.reviewTargetCount, signatures: report.signatures.length,
  independentIdentitySummary: report.independentIdentitySummary, optionIdentityConflicts: report.optionIdentityConflicts,
  changes: changes.slice(0, 10) }, null, 2));
