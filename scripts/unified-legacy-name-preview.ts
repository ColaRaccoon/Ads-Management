/** Local evidence-only dry run. No database client, network or mutation of existing configuration. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BASELINE_CANONICAL_PRODUCTS, LegacyNameRuleSnapshot, previewLegacyNameMigration,
  projectCafe24NameRules, projectGoogleNameRules, projectNaverNameRules
} from "../apps/api/src/unified-performance/domain/legacy-name-migration";
import { CatalogProduct, NameInput, normalizeProductName } from "../apps/api/src/unified-performance/domain/product-name-resolver";
import { SaleUnitDefinition, validateSaleUnit } from "../apps/api/src/unified-performance/domain/sale-unit-validation";
import type { Platform } from "../apps/api/src/unified-performance/types";

type Row = Record<string, unknown>;
type Query = { name: string; status: string; rows: Row[] | Row | null; observedAt: string; sqlSha256: string };
type Evidence = { rowsChanged: number; queries: Query[] };
const root = resolve(__dirname, "..");
const evidenceDirectory = resolve(root, "docs/product-performance/research");
const files = ["inventory", "coverage", "detail", "followup"] as const;
const evidence = Object.fromEntries(files.map(name => {
  const bytes = readFileSync(resolve(evidenceDirectory, `01-${name}-result.json`));
  const data = JSON.parse(bytes.toString("utf8")) as Evidence;
  assert.equal(data.rowsChanged, 0, "01 input must be a read-only evidence receipt.");
  return [name, { data, sha256: createHash("sha256").update(bytes).digest("hex") }];
})) as Record<typeof files[number], { data: Evidence; sha256: string }>;
function rows(file: typeof files[number], query: string): Row[] {
  const result = evidence[file].data.queries.find(q => q.name === query);
  assert.ok(result && result.status === "SUCCESS", `Missing successful evidence query: ${file}/${query}`);
  return result.rows === null ? [] : Array.isArray(result.rows) ? result.rows : [result.rows];
}
const string = (value: unknown): string => typeof value === "string" ? value : "";
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
const active = (value: unknown) => value === true || value === "true";
const date = (value: unknown) => string(value).slice(0, 10);
const names = rows("inventory", "products");
const products: CatalogProduct[] = [...new Set(names.filter(row => active(row.is_active)).map(row => string(row.display_name)))].map(canonicalName => ({ canonicalName }));
assert.deepEqual(products.map(p => p.canonicalName).sort(), BASELINE_CANONICAL_PRODUCTS.map(p => p.canonicalName).sort(), "Review any change to the 01 canonical catalog before regenerating migration proposals.");
const canonicalNames = new Set(products.map(p => p.canonicalName));
// These are exact, individual specimens stated in 01 contract §3; never strip digits or guess by similarity.
const approvedSpellings: Readonly<Record<string, string>> = {
  "두줄보호대": "두줄무릎보호대", "두줄보호대 1+1": "두줄무릎보호대", "두줄보호대 단품": "두줄무릎보호대",
  "버닝웨이브바 1개입": "버닝웨이브바", "버닝웨이브바 2개입": "버닝웨이브바", "버닝웨이브바 1+1": "버닝웨이브바",
  "플로우라이트_1개입": "플로우라이트", "플로우라이트_2개입": "플로우라이트",
  "한줄보호대 단품": "한줄보호대", "한줄보호대 1+1": "한줄보호대"
};
function reviewedProduct(name: string): string | null {
  if (canonicalNames.has(name)) return name;
  return approvedSpellings[name] ?? null;
}
const connections = rows("inventory", "connections");
const scope = (platform: string) => {
  const matches = connections.filter(row => row.provider === platform);
  assert.equal(matches.length, 1, `Expected exactly the one ${platform} connection established in 01.`);
  return string(matches[0].id);
};
const cafeScope = scope("CAFE24"), googleScope = scope("GOOGLE");
const day = "2026-10-26";
const drafts: LegacyNameRuleSnapshot[] = [];
const sourceDiagnostics: { source: string; row: string; name: string; code: string }[] = [];
const sampleRows: { provenance: string; inputKind: string; input: NameInput }[] = [];
const addSample = (name: string, platform: Platform, scopeKey: string, provenance: string, inputKind: string, businessDate = day, originalOption: string | null = null) => {
  sampleRows.push({ provenance, inputKind, input: { originalName: name, originalOption, nameField: platform === "GOOGLE" ? "campaign_name" : "configured_name", platform, scopeKey, businessDate } });
};

const cafeRules = rows("coverage", "cafe24_rules");
drafts.push(...projectCafe24NameRules(cafeRules.map((row, index) => ({
  id: `evidence:cafe24_rules:${index + 1}`, canonicalProductName: string(row.name),
  // The actual legacy model has no per-connection condition; do not invent one.
  scopeKey: null, validFrom: date(row.valid_from), validTo: row.valid_to == null ? null : date(row.valid_to),
  productNameAliases: strings(row.product_name_aliases), optionIncludeKeywords: strings(row.option_include_keywords),
  optionExcludeKeywords: strings(row.option_exclude_keywords)
}))));
for (const [index, row] of cafeRules.entries()) {
  const configuredNames = strings(row.product_name_aliases);
  if (!configuredNames.length) configuredNames.push(string(row.name));
  for (const name of configuredNames) addSample(name, "CAFE24", cafeScope, `coverage/cafe24_rules:${index + 1}`, "CONFIGURED_NAME_NOT_OBSERVED_ORDER");
}
sourceDiagnostics.push({ source: "CAFE24", row: "coverage/cafe24_rules", name: "", code: "EXTERNAL_ID_CONDITIONS_AND_DATABASE_RULE_IDS_NOT_CAPTURED" });

const naverUnits = rows("coverage", "naver_units_named");
for (const row of naverUnits) {
  const name = string(row.name), id = string(row.id), scopeKey = string(row.store_id);
  addSample(name, "NAVER", scopeKey, `coverage/naver_units_named:${id}`, "CONFIGURED_SALES_UNIT_NOT_OBSERVED_ORDER");
  if (row.is_group === "true" || row.is_group === true) {
    sourceDiagnostics.push({ source: "NAVER", row: id, name, code: "STRUCTURAL_GROUP_NOT_IMPORTED_AS_SALE_UNIT" });
    continue;
  }
  const canonicalProductName = reviewedProduct(name);
  if (!canonicalProductName) {
    sourceDiagnostics.push({ source: "NAVER", row: id, name, code: "CANONICAL_EQUIVALENCE_NOT_ESTABLISHED" });
    continue;
  }
  sourceDiagnostics.push({ source: "NAVER", row: id, name, code: "NAME_RULE_VALID_FROM_NOT_AVAILABLE_DRAFT_ONLY" });
  drafts.push(...projectNaverNameRules([{ id, canonicalProductName, scopeKey, validFrom: day,
    displayName: name, matchAliases: strings(row.aliases), saleUnitName: name, isActive: active(row.active) }]));
}

const coupangProducts = rows("inventory", "coupang_products");
for (const [index, row] of coupangProducts.entries()) {
  const name = string(row.standard_name), canonicalProductName = reviewedProduct(name);
  addSample(name, "COUPANG", "LEGACY_COUPANG_SINGLE_UPLOAD", `inventory/coupang_products:${index + 1}`, "CONFIGURED_PRODUCT_NOT_OBSERVED_SALE");
  if (!canonicalProductName) {
    sourceDiagnostics.push({ source: "COUPANG", row: `evidence:coupang_products:${index + 1}`, name, code: "INDEPENDENT_PRODUCT_OR_UNIT_REVIEW_REQUIRED" });
    continue;
  }
  drafts.push({ legacyRuleId: `evidence:coupang_products:${index + 1}`, canonicalProductName, platform: "COUPANG",
    scopeKey: "LEGACY_COUPANG_SINGLE_UPLOAD", validFrom: day, matchType: "EXACT", terms: [name], active: active(row.is_active) });
}
sourceDiagnostics.push({ source: "COUPANG", row: "inventory/coupang_products", name: "", code: "CATALOG_ALIAS_DRAFT_ONLY_EXISTING_KEYWORD_RULES_NOT_IN_EVIDENCE" });
sourceDiagnostics.push({ source: "META", row: "01-evidence", name: "", code: "META_NAME_RULE_ROWS_NOT_IN_EVIDENCE" });

drafts.push(...projectGoogleNameRules(names.filter(row => active(row.is_active)).map((row, index) => ({
  id: `evidence:products:${index + 1}`, canonicalProductName: string(row.display_name), scopeKey: googleScope, validFrom: day,
  name: string(row.name), displayName: string(row.display_name)
}))));
const googleNames = rows("detail", "google_campaign_names");
for (const [index, row] of googleNames.entries()) addSample(string(row.campaign_name), "GOOGLE", googleScope,
  `detail/google_campaign_names:${index + 1}`, "OBSERVED_CAMPAIGN_NAME", date(row.metric_date));
sourceDiagnostics.push({ source: "GOOGLE", row: "inventory/products", name: "", code: "CATALOG_CONTAINS_DRAFT_VALID_FROM_NOT_ESTABLISHED" });

const saleUnitProposals = rows("coverage", "google_sale_units").map((row, index) => {
  const unit: SaleUnitDefinition = { saleUnitName: string(row.sale_unit_label), quantityBasis: "SALE_UNIT_TOTAL",
    optionExact: row.option_scope === "EXACT" ? string(row.option_name) : null,
    unitsPerSaleUnit: null, salePrice: row.sale_price_krw_override as string | null, productCost: row.product_cost_krw_override as string | null,
    shippingCost: row.shipping_krw_override as string | null, otherCost: row.extra_cost_krw_override as string | null };
  validateSaleUnit(unit);
  return { evidenceRowId: `evidence:google_sale_units:${index + 1}`, canonicalProductName: string(row.name), platform: "CAFE24",
    originalConfigurationOwner: "GOOGLE_SALE", validFrom: date(row.start_date), validTo: row.end_date == null ? null : date(row.end_date),
    unit, reviewed: false, note: "The four observed amounts are totals per sale unit. Physical unit count is not inferred from its label; source name/option validation remains required." };
});

const migration = previewLegacyNameMigration(products, drafts, sampleRows.map(row => row.input), "02-evidence-preview-v1");
const statuses = migration.preview.reduce<Record<string, number>>((counts, row) => {
  counts[row.result.matchStatus] = (counts[row.result.matchStatus] ?? 0) + 1; return counts;
}, {});
const issueCounts = migration.issues.reduce<Record<string, number>>((counts, issue) => {
  counts[issue.code] = (counts[issue.code] ?? 0) + 1; return counts;
}, {});
const output = {
  version: "02-evidence-preview-v1", inputEvidenceDate: "2026-10-27", databaseAccess: false, networkAccess: false,
  writesPerformed: false, databaseRowsChanged: 0, localArtifactWritten: "docs/product-performance/research/02-name-migration-preview.json",
  importReady: false, requiresReview: true,
  limitations: [
    "This local dry run reuses 01 evidence, not a new production query or completed migration.",
    "Cafe24 rule database IDs were not captured; evidence row IDs are provenance markers, not database identities.",
    "Configured product/unit names are not observed order samples. Only the 20 Google campaign-name samples were observed source names.",
    "Naver/Coupang/Google derived name drafts use 2026-10-26 only as an explicit preview date; historical validity was not established.",
    "Unknown independent products remain diagnostics; no whitespace stripping, parent-ID equivalence, numeric stripping or calf-sleeve to arm-sleeve remapping occurs.",
    "Current baseline product exact-name recognition can succeed even where an option-only Cafe24 rule cannot be migrated; this does not validate sale-unit costs."
  ],
  evidence: files.map(file => ({ file: `01-${file}-result.json`, sha256: evidence[file].sha256,
    queries: evidence[file].data.queries.map(query => ({ name: query.name, status: query.status,
      rowCount: query.rows == null ? 0 : Array.isArray(query.rows) ? query.rows.length : 1 })) })),
  counts: { canonicalProducts: products.length, capturedLegacyProductRows: names.length, cafe24RuleRows: cafeRules.length,
    naverUnitRows: naverUnits.length, coupangProductRows: coupangProducts.length, observedGoogleNameRows: googleNames.length,
    projectedDraftRows: drafts.length, proposedNameRules: migration.proposedRules.length, saleUnitProposals: saleUnitProposals.length,
    sampleCount: sampleRows.length, statuses, issueCounts },
  canonicalProducts: products, proposedRules: migration.proposedRules, saleUnitProposals,
  issues: migration.issues, sourceDiagnostics,
  samples: migration.preview.map((row, index) => ({ provenance: sampleRows[index].provenance, inputKind: sampleRows[index].inputKind,
    platform: row.input.platform, businessDate: row.input.businessDate, originalName: row.input.originalName,
    originalOption: row.input.originalOption, canonicalProductName: row.result.canonicalProductName,
    saleUnitName: row.result.saleUnitName, status: row.result.matchStatus, candidateNames: row.result.candidateNames,
    ruleIds: row.result.ruleIds, reasons: row.result.reasons }))
};
assert.equal(output.databaseAccess, false);
assert.equal(output.importReady, false);
assert.ok(!JSON.stringify(output).includes("orderId"));
writeFileSync(resolve(evidenceDirectory, "02-name-migration-preview.json"), `${JSON.stringify(output, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ artifact: output.localArtifactWritten, importReady: false, ...output.counts }, null, 2));
