import { createHash } from "node:crypto";
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { Prisma, UnifiedProduct, UnifiedRule } from "@prisma/client";
import { AuthenticatedUser } from "../auth/auth.types";
import { Permission } from "../auth/role-permissions";
import { asDateOnly } from "../common/date-range";
import { assertBusinessDate, CatalogProduct, NameInput, NameRule, normalizeProductName, resolveProductName, validateNameRule } from "./domain/product-name-resolver";
import { SaleUnitDefinition, validateSaleUnit } from "./domain/sale-unit-validation";
import { ConfigurationQuery, DeleteConfigurationInput, ProductInput, RuleInput, RulePreviewInput, CONFIG_PLATFORMS, RULE_KINDS } from "./management.dto";
import { ManagementTransaction, managementVersions, UnifiedManagementRepository } from "./management.repository";
import { affectedConfigurationScope, configurationImpact } from "./management-impact";

type Actor = Pick<AuthenticatedUser, "id" | "permissions">;
const Decimal = Prisma.Decimal.clone({ precision: 80, rounding: Prisma.Decimal.ROUND_HALF_UP });
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const json = <T>(value: T) => JSON.parse(JSON.stringify(value));
const date = (value: Date) => value.toISOString().slice(0, 10);
const bad = (message: string): never => { throw new BadRequestException({ code: "UNIFIED_CONFIGURATION_INVALID", message }); };
export function assertUnifiedEnabled() {
  if (process.env.UNIFIED_PERFORMANCE_ENABLED !== "true") throw new ServiceUnavailableException({ code: "UNIFIED_PERFORMANCE_DISABLED", message: "제품 통합 성과 기능이 비활성화되어 있습니다." });
}
function requirePermission(actor: Actor, permission: Permission) {
  if (!actor?.permissions?.includes(permission)) throw new ForbiddenException({ code: "PERMISSION_DENIED", message: "변경 권한이 없습니다." });
}
function reason(value: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 1024) bad("변경 사유를 1~1024자로 입력해 주세요.");
  return value.trim();
}
function bounded<T>(rows: T[]): T[] {
  if (rows.length > 10000) bad("설정이 많습니다. 관리 범위를 나누어 주세요.");
  return rows;
}
function keys(payload: Record<string, unknown>, allowed: string[]) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || Object.keys(payload).some(key => !allowed.includes(key))) bad("규칙 입력 필드를 확인해 주세요.");
}
function text(value: unknown, field: string, max = 256): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) bad(`${field} 문자열을 확인해 주세요.`);
  return (value as string).trim();
}
function strings(value: unknown, field: string, required = false): string[] {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value) || value.length > 100 || (required && !value.length)) bad(`${field} 목록을 확인해 주세요.`);
  return [...new Set((value as unknown[]).map(item => normalizeProductName(text(item, field, 1024))))].sort();
}
function optionalCondition(value: unknown, field: string) {
  if (value == null) return null;
  if (typeof value !== "string" || value.length > 1024) bad(`${field} 문자열을 확인해 주세요.`);
  return normalizeProductName(value as string);
}
function validateDomain(work: () => void) {
  try { work(); } catch (error) { bad(error instanceof Error ? error.message : "규칙을 확인해 주세요."); }
}
export function configurationProduct(input: ProductInput) {
  const canonicalName = text(input.canonicalName, "기준 제품명");
  reason(input.reason);
  if (input.active !== undefined && typeof input.active !== "boolean") bad("활성 상태가 올바르지 않습니다.");
  return { canonicalName, normalizedName: normalizeProductName(canonicalName), active: input.active ?? true };
}
export function ruleName(row: Pick<UnifiedRule, "id" | "payload" | "platform" | "scopeKey" | "validFrom" | "validTo" | "active">, productName: string): NameRule {
  return { ...(row.payload as unknown as Omit<NameRule, "id" | "canonicalProductName" | "validFrom">), id: row.id,
    canonicalProductName: productName, platform: row.platform as NameRule["platform"], scopeKey: row.scopeKey,
    validFrom: date(row.validFrom), validTo: row.validTo ? date(row.validTo) : null, active: row.active };
}
export function configurationRule(input: RuleInput, canonicalProductName?: string) {
  if (!RULE_KINDS.includes(input.kind)) bad("규칙 종류가 올바르지 않습니다.");
  reason(input.reason);
  if (input.active !== undefined && typeof input.active !== "boolean") bad("활성 상태가 올바르지 않습니다.");
  if (input.platform != null && !CONFIG_PLATFORMS.includes(input.platform)) bad("플랫폼이 올바르지 않습니다.");
  const scopeKey = input.scopeKey == null ? null : text(input.scopeKey, "원천 범위");
  if (scopeKey && !input.platform) bad("원천 범위에는 플랫폼이 필요합니다.");
  validateDomain(() => { assertBusinessDate(input.validFrom); if (input.validTo != null) assertBusinessDate(input.validTo); });
  const validFrom = asDateOnly(input.validFrom), validTo = input.validTo == null ? null : asDateOnly(input.validTo);
  if (validTo && validTo < validFrom) bad("종료일은 시작일 이후여야 합니다.");
  const payload = input.payload;
  let normalizedPayload: Record<string, unknown>;
  let predicate: unknown;
  if (input.kind === "NAME") {
    keys(payload, ["matchType", "terms", "excludeTerms", "optionExact", "optionInclude", "optionExclude", "nameField", "saleUnitName"]);
    if (!input.productId || !canonicalProductName) bad("이름 규칙에는 기준 제품이 필요합니다.");
    normalizedPayload = { matchType: payload.matchType, terms: strings(payload.terms, "이름 조건", true),
      excludeTerms: strings(payload.excludeTerms, "제외어"), optionExact: optionalCondition(payload.optionExact, "정확 옵션"),
      optionInclude: strings(payload.optionInclude, "옵션 포함어"), optionExclude: strings(payload.optionExclude, "옵션 제외어"),
      nameField: payload.nameField == null ? null : text(payload.nameField, "원문 필드", 128),
      saleUnitName: payload.saleUnitName == null ? null : text(payload.saleUnitName, "판매단위", 256) };
    validateDomain(() => validateNameRule({ ...normalizedPayload, id: "preview", canonicalProductName, platform: input.platform,
      scopeKey, validFrom: input.validFrom, validTo: input.validTo } as NameRule));
    // The destination is intentionally absent: competing products cannot claim
    // the same predicate in an overlapping account/date range.
    const { saleUnitName: _saleUnitName, ...condition } = normalizedPayload;
    predicate = condition;
  } else if (input.kind === "SALE_UNIT") {
    keys(payload, ["saleUnitName", "optionExact", "optionInclude", "unitsPerSaleUnit", "quantityBasis", "salePrice", "productCost", "shippingCost", "otherCost"]);
    if (!input.productId || !canonicalProductName || !input.platform || ["META", "GOOGLE"].includes(input.platform)) bad("판매단위에는 기준 제품과 판매 플랫폼이 필요합니다.");
    normalizedPayload = { ...payload, saleUnitName: text(payload.saleUnitName, "판매단위"),
      optionExact: optionalCondition(payload.optionExact, "정확 옵션"), optionInclude: strings(payload.optionInclude, "옵션 포함어") };
    validateDomain(() => validateSaleUnit(normalizedPayload as unknown as SaleUnitDefinition));
    predicate = { productId: input.productId, saleUnitName: normalizeProductName(String(normalizedPayload.saleUnitName)),
      optionExact: normalizedPayload.optionExact, optionInclude: normalizedPayload.optionInclude };
  } else if (input.kind === "ALLOCATION") {
    keys(payload, ["method", "component", "nameExact", "targets"]);
    if (!input.platform || input.productId) bad("배분 규칙은 원천 플랫폼과 배분 대상 목록을 사용합니다.");
    if (!["UNALLOCATED", "FIXED_WEIGHTS", "REVENUE_SHARE"].includes(String(payload.method))) bad("배분 방식을 확인해 주세요.");
    if (!["AD_SPEND", "SHIPPING_INCOME", "SHIPPING_COST", "FAKE_PURCHASE", "OTHER"].includes(String(payload.component))) bad("배분 항목을 확인해 주세요.");
    if (["META", "GOOGLE"].includes(input.platform ?? "") && payload.component !== "AD_SPEND" || input.platform === "CAFE24" && payload.component === "AD_SPEND") bad("플랫폼과 배분 구성요소가 일치하지 않습니다.");
    if (!Array.isArray(payload.targets) || payload.targets.length > 100) bad("배분 대상 목록을 확인해 주세요.");
    const names = new Set<string>();
    const targets = (payload.targets as Record<string, unknown>[]).map(target => {
      keys(target, ["productName", "weight"]);
      const productName = text(target.productName, "배분 제품명"), normalizedName = normalizeProductName(productName);
      if (names.has(normalizedName)) bad("동일 제품의 배분 대상이 중복됩니다.");
      names.add(normalizedName);
      const weight = target.weight;
      if (payload.method === "FIXED_WEIGHTS") {
        if (typeof weight !== "string" || !/^(?:0|1)(?:\.\d{1,10})?$/.test(weight) || new Decimal(weight).lte(0) || new Decimal(weight).gt(1)) bad("배분 비중은 0 초과 1 이하 소수 문자열이어야 합니다.");
      } else if (weight != null) bad("고정 비중 배분 외에는 비중을 입력하지 않습니다.");
      return { productName, weight: weight ?? null };
    }).sort((a, b) => a.productName.localeCompare(b.productName));
    if (payload.method === "UNALLOCATED" && targets.length || payload.method !== "UNALLOCATED" && !targets.length) bad("배분 대상과 방식이 일치하지 않습니다.");
    if (payload.method === "FIXED_WEIGHTS" && !targets.reduce((sum, target) => sum.plus(target.weight as string), new Decimal(0)).eq(1)) bad("배분 비중 합계는 정확히 1이어야 합니다.");
    normalizedPayload = { method: payload.method, component: payload.component, nameExact: payload.nameExact == null ? null : normalizeProductName(text(payload.nameExact, "광고/비용 이름", 1024)), targets };
    predicate = { component: payload.component, nameExact: normalizedPayload.nameExact };
  } else {
    keys(payload, ["components"]);
    if (!input.productId || !canonicalProductName || !input.platform) bad("참여 정책에는 기준 제품과 플랫폼이 필요합니다.");
    const components = strings(payload.components, "적용 구성요소", true).map(value => value.toUpperCase());
    if (components.some(value => !["SALE", "AD_SPEND", "DIRECT_COST", "COMMON_EXPENSE"].includes(value))) bad("적용 구성요소가 올바르지 않습니다.");
    if (["META", "GOOGLE"].includes(input.platform ?? "") && components.some(value => value !== "AD_SPEND") || input.platform === "CAFE24" && components.includes("AD_SPEND")) bad("플랫폼과 적용 구성요소가 일치하지 않습니다.");
    normalizedPayload = { components };
    predicate = { productId: input.productId };
  }
  return { kind: input.kind, productId: input.productId ?? null, platform: input.platform ?? null, scopeKey,
    identityKey: digest(predicate), payload: normalizedPayload as Prisma.InputJsonObject, validFrom, validTo, active: input.active ?? true };
}
export function intervalsOverlap(a: { validFrom: Date; validTo: Date | null }, b: { validFrom: Date; validTo: Date | null }) {
  return (!a.validTo || a.validTo >= b.validFrom) && (!b.validTo || b.validTo >= a.validFrom);
}
export function scopesOverlap(a: { platform: string | null; scopeKey: string | null }, b: { platform: string | null; scopeKey: string | null }) {
  return (!a.platform || !b.platform || a.platform === b.platform) && (!a.scopeKey || !b.scopeKey || a.scopeKey === b.scopeKey);
}
function equivalentNameConflict(a: Prisma.JsonValue | Prisma.InputJsonObject, b: Prisma.JsonValue | Prisma.InputJsonObject) {
  const left = a as unknown as NameRule, right = b as unknown as NameRule;
  // Exact aliases stored together must still collide with a single-alias rule.
  // Disjoint option/name-field conditions describe distinct predicates.
  if (left.nameField && right.nameField && left.nameField !== right.nameField ||
      left.optionExact != null && right.optionExact != null && left.optionExact !== right.optionExact) return false;
  const option = left.optionExact ?? right.optionExact;
  const includes = [...(left.optionInclude ?? []), ...(right.optionInclude ?? [])];
  const excludes = [...(left.optionExclude ?? []), ...(right.optionExclude ?? [])];
  if (option != null && (includes.some(term => !option.includes(term)) || excludes.some(term => option.includes(term))) ||
      includes.some(term => excludes.some(exclude => term.includes(exclude)))) return false;
  const accepts = (rule: NameRule, name: string) => !(rule.excludeTerms ?? []).some(term => name.includes(term)) &&
    (rule.matchType === "EXACT" ? rule.terms.includes(name) : rule.terms.every(term => name.includes(term)));
  const examples = [...left.terms, ...right.terms, left.terms.join(" "), right.terms.join(" ")];
  return examples.some(name => accepts(left, name) && accepts(right, name));
}
function payloadConflict(kind: string, left: UnifiedRule, right: ReturnType<typeof configurationRule>) {
  if (left.identityKey === right.identityKey) return true;
  if (kind === "NAME") return equivalentNameConflict(left.payload, right.payload);
  const a = left.payload as Record<string, unknown>, b = right.payload as Record<string, unknown>;
  if (kind === "ALLOCATION") return a.component === b.component && (a.nameExact == null || b.nameExact == null || a.nameExact === b.nameExact);
  if (kind === "SALE_UNIT" && left.productId === right.productId && normalizeProductName(a.saleUnitName as string) === normalizeProductName(b.saleUnitName as string)) {
    if (a.optionExact != null && b.optionExact != null) return a.optionExact === b.optionExact;
    const exact = a.optionExact ?? b.optionExact;
    const includes = [...(a.optionInclude as string[] ?? []), ...(b.optionInclude as string[] ?? [])];
    return exact == null || includes.every(term => (exact as string).includes(term));
  }
  return false;
}

@Injectable()
export class UnifiedManagementService {
  constructor(private readonly repository: UnifiedManagementRepository) {}
  async configuration() {
    assertUnifiedEnabled();
    return this.repository.read(async tx => {
      const catalog = await this.catalog(tx);
      return { ...catalog, rules: catalog.rules.map(row => ({ ...row, validFrom: date(row.validFrom), validTo: row.validTo ? date(row.validTo) : null })) };
    });
  }
  private async catalog(tx: ManagementTransaction) {
    const products = bounded(await tx.unifiedProduct.findMany({ orderBy: { id: "asc" }, take: 10001 }));
    const rules = bounded(await tx.unifiedRule.findMany({ orderBy: { id: "asc" }, take: 10001 }));
    return { products, rules, versions: managementVersions(products, rules) };
  }
  async listProducts(query: ConfigurationQuery) {
    assertUnifiedEnabled();
    return this.repository.read(async tx => {
      const catalog = await this.catalog(tx), page = query.page ?? 1, pageSize = query.pageSize ?? 50;
      return { products: catalog.products.slice((page - 1) * pageSize, page * pageSize), pagination: { page, pageSize, total: catalog.products.length }, versions: catalog.versions };
    });
  }
  async listRules(query: ConfigurationQuery) {
    assertUnifiedEnabled();
    return this.repository.read(async tx => {
      const catalog = await this.catalog(tx), page = query.page ?? 1, pageSize = query.pageSize ?? 50;
      const rows = catalog.rules.filter(row => !query.kind || row.kind === query.kind);
      return { rules: rows.map(row => ({ ...row, validFrom: date(row.validFrom), validTo: row.validTo ? date(row.validTo) : null })).slice((page - 1) * pageSize, page * pageSize),
        pagination: { page, pageSize, total: rows.length }, versions: catalog.versions };
    });
  }
  async audit(entityId: string) {
    assertUnifiedEnabled();
    return this.repository.read(tx => tx.unifiedMappingAudit.findMany({ where: { entityId }, orderBy: [{ createdAt: "desc" }, { id: "asc" }], take: 100 }));
  }
  async previewProduct(input: ProductInput, id?: string) {
    assertUnifiedEnabled();
    const after = configurationProduct(input);
    return this.repository.read(async tx => {
      const before = id ? await tx.unifiedProduct.findUnique({ where: { id } }) : null;
      if (id && !before) throw new NotFoundException("기준 제품을 찾을 수 없습니다.");
      after.active = input.active ?? before?.active ?? true;
      const conflict = await tx.unifiedProduct.findFirst({ where: { normalizedName: after.normalizedName, ...(id ? { id: { not: id } } : {}) } });
      const aliases = bounded(await tx.unifiedRule.findMany({ where: { kind: "NAME", active: true, ...(id ? { productId: { not: id } } : {}) }, take: 10001 }));
      const aliasConflicts = aliases.filter(row => (row.payload as Record<string, unknown>).matchType === "EXACT" && ((row.payload as Record<string, unknown>).terms as string[]).includes(after.normalizedName)).map(row => row.id);
      const allocations = before && before.canonicalName !== after.canonicalName ? bounded(await tx.unifiedRule.findMany({ where: { kind: "ALLOCATION", active: true }, take: 10001 })) : [];
      const referencedAllocationRules = allocations.filter(row => ((row.payload as Record<string, unknown>).targets as { productName: string }[]).some(target => normalizeProductName(target.productName) === before!.normalizedName)).map(row => row.id);
      const versionConflict = before ? input.expectedVersion !== before.version : input.expectedVersion !== undefined;
      return { before, after, conflicts: conflict ? [conflict] : [], aliasConflicts, referencedAllocationRules, versionConflict,
        canSave: !conflict && !aliasConflicts.length && !referencedAllocationRules.length && !versionConflict, writesPerformed: false };
    });
  }
  async saveProduct(input: ProductInput, actor: Actor, id?: string) {
    assertUnifiedEnabled(); requirePermission(actor, "products.manage");
    const data = configurationProduct(input);
    return this.conflicts(() => this.repository.mutate(async tx => {
      const before = id ? await tx.unifiedProduct.findUnique({ where: { id } }) : null;
      if (id && !before) throw new NotFoundException("기준 제품을 찾을 수 없습니다.");
      this.expected(before?.version, input.expectedVersion);
      if (await tx.unifiedProduct.findFirst({ where: { normalizedName: data.normalizedName, ...(id ? { id: { not: id } } : {}) } })) throw new ConflictException("정규화한 기준 제품명이 다른 제품과 충돌합니다.");
      const aliases = bounded(await tx.unifiedRule.findMany({ where: { kind: "NAME", active: true, ...(id ? { productId: { not: id } } : {}) }, take: 10001 }));
      if (aliases.some(rule => (rule.payload as Record<string, unknown>).matchType === "EXACT" && ((rule.payload as Record<string, unknown>).terms as string[]).includes(data.normalizedName))) throw new ConflictException("기준 제품명이 다른 제품의 정확 별칭과 충돌합니다.");
      if (before && before.canonicalName !== data.canonicalName) {
        const allocations = bounded(await tx.unifiedRule.findMany({ where: { kind: "ALLOCATION", active: true }, take: 10001 }));
        if (allocations.some(rule => ((rule.payload as Record<string, unknown>).targets as { productName: string }[]).some(target => normalizeProductName(target.productName) === before.normalizedName)))
          throw new ConflictException("이 제품을 사용하는 배분 규칙을 비활성화한 뒤 제품명을 변경하고 새 이름으로 배분 규칙을 갱신해 주세요.");
      }
      const after = id ? await tx.unifiedProduct.update({ where: { id, version: input.expectedVersion }, data: { ...data, active: input.active ?? before!.active, version: { increment: 1 } } }) : await tx.unifiedProduct.create({ data });
      await this.record(tx, "PRODUCT", after.id, before ? "UPDATE" : "CREATE", actor, before, after, input.reason);
      return { product: after, affectedRange: { from: null, to: null }, rebuildRequired: true };
    }));
  }
  private expected(actual: number | undefined, expected: number | undefined) {
    if (actual === undefined) { if (expected !== undefined) bad("신규 설정에는 expectedVersion을 지정하지 않습니다."); return; }
    if (!Number.isInteger(expected) || expected !== actual) throw new ConflictException({ code: "UNIFIED_CONFIGURATION_CHANGED", message: "설정이 변경되었습니다. 새로고침해 주세요." });
  }
  private async prepare(tx: ManagementTransaction, input: RuleInput, id?: string) {
    const catalog = await this.catalog(tx);
    const before = id ? catalog.rules.find(row => row.id === id) : null;
    if (id && !before) throw new NotFoundException("규칙을 찾을 수 없습니다.");
    const product = input.productId ? catalog.products.find(row => row.id === input.productId) : undefined;
    if (input.productId && !product) throw new NotFoundException("기준 제품을 찾을 수 없습니다.");
    const after = configurationRule(input, product?.canonicalName);
    after.active = input.active ?? before?.active ?? true;
    await this.scope(tx, after.platform, after.scopeKey);
    if (input.kind === "ALLOCATION") {
      for (const target of (after.payload.targets as unknown as { productName: string }[]))
        if (!catalog.products.some(row => row.normalizedName === normalizeProductName(target.productName))) throw new NotFoundException("배분 대상 기준 제품을 찾을 수 없습니다.");
    }
    const overlaps = after.active ? catalog.rules.filter(row => row.id !== id && row.active && row.kind === after.kind &&
      payloadConflict(after.kind, row, after) && scopesOverlap(row, after) && intervalsOverlap(row, after)) : [];
    const aliasConflicts: string[] = [];
    if (after.kind === "NAME" && after.active && after.payload.matchType === "EXACT") {
      for (const term of after.payload.terms as string[]) for (const item of catalog.products)
        if (item.normalizedName === term && item.id !== input.productId) aliasConflicts.push(item.canonicalName);
    }
    const from = before && before.validFrom < after.validFrom ? before.validFrom : after.validFrom;
    const to = before && (!before.validTo || !after.validTo) ? null : before?.validTo && after.validTo && before.validTo > after.validTo ? before.validTo : after.validTo;
    return { before, after, overlaps, aliasConflicts, canSave: !overlaps.length && !aliasConflicts.length,
      affectedRange: { from: date(from), to: to ? date(to) : null }, catalog };
  }
  private async scope(tx: ManagementTransaction, platform: string | null, scopeKey: string | null) {
    if (!scopeKey) return;
    if (scopeKey === "LEGACY_UNBOUND" && (platform === "META" || platform === "CAFE24") &&
        (process.env.UNIFIED_REPORT_LEGACY_PLATFORMS ?? "META,CAFE24").split(",").includes(platform)) return;
    if (platform === "COUPANG") { if (scopeKey !== "LEGACY_COUPANG_SINGLE_UPLOAD") bad("쿠팡의 확인된 단일 업로드 범위를 사용해 주세요."); return; }
    if (platform === "NAVER") {
      // Names are configuration-only here. Reader access to public is intentionally
      // unavailable to the web role; step 05 resolves authorized store keys.
      if (!/^[A-Za-z0-9가-힣][A-Za-z0-9가-힣._:-]{0,255}$/.test(scopeKey)) bad("네이버 스토어 범위 키를 확인해 주세요.");
      return;
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(scopeKey)) bad("원천 연결 범위는 내부 연결 키여야 합니다.");
    const connection = await tx.sourceConnection.findUnique({ where: { id: scopeKey }, select: { provider: true } });
    if (!connection || connection.provider !== platform) throw new NotFoundException("해당 플랫폼의 원천 연결을 찾을 수 없습니다.");
  }
  async previewRule(input: RulePreviewInput) {
    assertUnifiedEnabled();
    return this.repository.read(async tx => {
      const prepared = await this.prepare(tx, input, input.id);
      const { catalog, ...result } = prepared;
      const products: CatalogProduct[] = catalog.products.map(row => ({ canonicalName: row.canonicalName, active: row.active }));
      const ruleRows = catalog.rules.filter(row => row.kind === "NAME" && row.id !== input.id);
      const nameRules = ruleRows.map(row => ruleName(row, catalog.products.find(product => product.id === row.productId)!.canonicalName));
      if (prepared.after.kind === "NAME") nameRules.push(ruleName({ id: input.id ?? "preview", ...prepared.after } as UnifiedRule, catalog.products.find(product => product.id === input.productId)!.canonicalName));
      if (input.samples && (!Array.isArray(input.samples) || input.samples.length > 100)) bad("미리보기 표본은 100개 이하입니다.");
      const unitRows = catalog.rules.filter(row => row.kind === "SALE_UNIT" && row.id !== input.id);
      if (prepared.after.kind === "SALE_UNIT") unitRows.push({ id: input.id ?? "preview", ...prepared.after } as UnifiedRule);
      const samples = (input.samples ?? []).map(sample => {
        keys(sample, ["originalName", "originalOption", "nameField", "restorationPath", "platform", "scopeKey", "businessDate", "saleUnitName", "requiresSaleUnit"]);
        if (!CONFIG_PLATFORMS.includes(sample.platform as never)) bad("표본의 플랫폼을 확인해 주세요.");
        text(sample.scopeKey, "표본 원천 범위", 256);
        validateDomain(() => assertBusinessDate(sample.businessDate as string));
        text(sample.nameField, "표본 원문 필드", 128);
        if (sample.originalName != null && (typeof sample.originalName !== "string" || sample.originalName.length > 4096)) bad("표본 이름을 확인해 주세요.");
        if (sample.originalOption != null && (typeof sample.originalOption !== "string" || sample.originalOption.length > 4096)) bad("표본 옵션을 확인해 주세요.");
        for (const field of ["saleUnitName", "restorationPath"] as const)
          if (sample[field] != null && (typeof sample[field] !== "string" || (sample[field] as string).length > 1024)) bad("표본 판매단위와 복원 경로를 확인해 주세요.");
        if (sample.requiresSaleUnit !== undefined && typeof sample.requiresSaleUnit !== "boolean") bad("표본 판매단위 필요 여부가 올바르지 않습니다.");
        const sampleInput = sample as unknown as NameInput;
        const resolution = resolveProductName(sampleInput, products, nameRules, `${catalog.versions.nameRuleVersion}:preview:${digest(prepared.after)}`);
        const product = catalog.products.find(row => row.canonicalName === resolution.canonicalProductName);
        if (!product || resolution.matchStatus === "AMBIGUOUS") return { ...resolution, unitPreview: null };
        const forProduct = unitRows.filter(row => row.productId === product.id && row.active);
        const option = normalizeProductName(sampleInput.originalOption), unitName = normalizeProductName(sampleInput.saleUnitName ?? resolution.saleUnitName);
        const candidates = forProduct.filter(row => {
          if (row.platform && row.platform !== sampleInput.platform || row.scopeKey && row.scopeKey !== sampleInput.scopeKey ||
              sampleInput.businessDate < date(row.validFrom) || row.validTo && sampleInput.businessDate > date(row.validTo)) return false;
          const unit = row.payload as unknown as SaleUnitDefinition;
          return (!unitName || normalizeProductName(unit.saleUnitName) === unitName) &&
            (unit.optionExact == null || normalizeProductName(unit.optionExact) === option) &&
            (unit.optionInclude ?? []).every(term => option.includes(normalizeProductName(term)));
        });
        const unitPreview = { status: !forProduct.length ? "NOT_CONFIGURED" : candidates.length === 1 ? "MATCHED" : "UNIT_REQUIRED",
          candidates: candidates.map(row => ({ ruleId: row.id, ...(row.payload as unknown as SaleUnitDefinition) })),
          reason: !forProduct.length ? "SALE_UNIT_RULE_MISSING" : candidates.length > 1 ? "MULTIPLE_SALE_UNIT_CANDIDATES" : !candidates.length ? "SALE_UNIT_UNRESOLVED" : "UNIQUE_SALE_UNIT_RULE" };
        return { ...resolution, matchStatus: unitPreview.status === "UNIT_REQUIRED" ? "UNIT_REQUIRED" as const : unitPreview.status === "MATCHED" ? "MATCHED" as const : resolution.matchStatus,
          saleUnitName: candidates.length === 1 ? (candidates[0].payload as unknown as SaleUnitDefinition).saleUnitName : resolution.saleUnitName,
          unitPreview };
      });
      const versionConflict = prepared.before ? input.expectedVersion !== prepared.before.version : input.expectedVersion !== undefined;
      const configurationConflict = input.expectedConfigurationVersion !== undefined && input.expectedConfigurationVersion !== catalog.versions.configurationVersion;
      const impact = input.impactFrom !== undefined || input.impactTo !== undefined
        ? await configurationImpact(tx, input, prepared.before, catalog.products) : undefined;
      return { ...result, canSave: result.canSave && !versionConflict && !configurationConflict,
        versionConflict: versionConflict || configurationConflict, samples, versions: catalog.versions, impact, writesPerformed: false };
    });
  }
  async saveRule(input: RuleInput, actor: Actor, id?: string) {
    assertUnifiedEnabled(); requirePermission(actor, "mappings.manage");
    return this.conflicts(() => this.repository.mutate(async tx => {
      const prepared = await this.prepare(tx, input, id);
      this.expected(prepared.before?.version, input.expectedVersion);
      if (input.expectedConfigurationVersion !== undefined && input.expectedConfigurationVersion !== prepared.catalog.versions.configurationVersion)
        throw new ConflictException({ code: "UNIFIED_CONFIGURATION_CHANGED", message: "미리보기 이후 설정이 변경되었습니다. 다시 미리보기해 주세요." });
      if (!prepared.canSave) throw new ConflictException({ code: "UNIFIED_RULE_OVERLAP", message: "같은 기간과 범위의 이름/규칙이 충돌합니다." });
      const after = id ? await tx.unifiedRule.update({ where: { id, version: input.expectedVersion }, data: { ...prepared.after, version: { increment: 1 } } }) : await tx.unifiedRule.create({ data: prepared.after });
      await this.record(tx, "RULE", after.id, prepared.before ? "UPDATE" : "CREATE", actor, prepared.before, after, input.reason);
      return { rule: { ...after, validFrom: date(after.validFrom), validTo: after.validTo ? date(after.validTo) : null }, affectedRange: prepared.affectedRange,
        affectedScope: affectedConfigurationScope(input, prepared.before), rebuildRequired: true };
    }));
  }
  async deleteProduct(id: string, input: DeleteConfigurationInput, actor: Actor) {
    assertUnifiedEnabled(); requirePermission(actor, "products.manage"); reason(input.reason);
    return this.conflicts(() => this.repository.mutate(async tx => {
      const before = await tx.unifiedProduct.findUnique({ where: { id } });
      if (!before) throw new NotFoundException("기준 제품을 찾을 수 없습니다.");
      this.expected(before.version, input.expectedVersion);
      const after = await tx.unifiedProduct.update({ where: { id, version: input.expectedVersion }, data: { active: false, version: { increment: 1 } } });
      await this.record(tx, "PRODUCT", id, "DEACTIVATE", actor, before, after, input.reason);
      return { product: after, affectedRange: { from: null, to: null }, rebuildRequired: true };
    }));
  }
  async deleteRule(id: string, input: DeleteConfigurationInput, actor: Actor) {
    assertUnifiedEnabled(); requirePermission(actor, "mappings.manage"); reason(input.reason);
    return this.conflicts(() => this.repository.mutate(async tx => {
      const before = await tx.unifiedRule.findUnique({ where: { id } });
      if (!before) throw new NotFoundException("규칙을 찾을 수 없습니다.");
      this.expected(before.version, input.expectedVersion);
      const after = await tx.unifiedRule.update({ where: { id, version: input.expectedVersion }, data: { active: false, version: { increment: 1 } } });
      await this.record(tx, "RULE", id, "DEACTIVATE", actor, before, after, input.reason);
      return { rule: { ...after, validFrom: date(after.validFrom), validTo: after.validTo ? date(after.validTo) : null }, affectedRange: { from: date(before.validFrom), to: before.validTo ? date(before.validTo) : null }, rebuildRequired: true };
    }));
  }
  private record(tx: ManagementTransaction, entityType: string, entityId: string, action: string, actor: Actor, before: unknown, after: unknown, changeReason: string) {
    return tx.unifiedMappingAudit.create({ data: { entityType, entityId, action, actorUserId: actor.id, before: before ? json(before) : Prisma.DbNull,
      after: json(after), reason: reason(changeReason) } });
  }
  private async conflicts<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && ["P2002", "P2025", "P2034"].includes(error.code)) throw new ConflictException({ code: "UNIFIED_CONFIGURATION_CONFLICT", message: "동시 변경 또는 중복된 설정입니다. 새로고침해 주세요." });
      throw error;
    }
  }
}
