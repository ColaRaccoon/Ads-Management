import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { ExecutionContext, HttpException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { PermissionGuard } from "../auth/permission.guard";
import { REQUIRED_PERMISSIONS } from "../auth/route-decorators";
import { UnifiedProductsController, UnifiedRulesController } from "./management.controller";
import { configurationProduct, configurationRule, intervalsOverlap, scopesOverlap, UnifiedManagementService } from "./management.service";
import { RuleInput } from "./management.dto";
import { UnifiedManagementRepository } from "./management.repository";

const base = { kind: "NAME", productId: "product-1", platform: "CAFE24", payload: { matchType: "EXACT", terms: ["상품 A"] }, validFrom: "2026-10-20", reason: "합성 검증" } as RuleInput;
const enabled = async (work: () => Promise<void>) => {
  const before = process.env.UNIFIED_PERFORMANCE_ENABLED;
  process.env.UNIFIED_PERFORMANCE_ENABLED = "true";
  try { await work(); } finally { if (before === undefined) delete process.env.UNIFIED_PERFORMANCE_ENABLED; else process.env.UNIFIED_PERFORMANCE_ENABLED = before; }
};
const product = (id = "product-1", canonicalName = "상품 A") => ({ id, canonicalName, normalizedName: canonicalName.toLowerCase(), active: true, version: 1, createdAt: new Date(), updatedAt: new Date() });

test("management endpoints and real permission guard deny read-only users all writes", () => {
  const guard = new PermissionGuard(new Reflector());
  for (const [controller, permission] of [[UnifiedProductsController, "products.manage"], [UnifiedRulesController, "mappings.manage"]] as const) {
    for (const method of ["list", "preview", "audit", "create", "update", "remove"] as const) {
      const handler = controller.prototype[method];
      const write = ["create", "update", "remove"].includes(method);
      assert.deepEqual(Reflect.getMetadata(REQUIRED_PERMISSIONS, handler), [write ? permission : "data.read"]);
      const context = { getHandler: () => handler, switchToHttp: () => ({ getRequest: () => ({ authenticatedUser: { permissions: ["data.read"] } }) }) } as unknown as ExecutionContext;
      if (write) assert.throws(() => guard.canActivate(context), (error: unknown) => error instanceof HttpException && error.getStatus() === 403);
      else assert.equal(guard.canActivate(context), true);
    }
  }
});

test("disabled feature and unauthorized direct service saves never reach the database", async () => {
  const service = new UnifiedManagementService(new Proxy({}, { get: () => { throw Error("DB accessed"); } }) as UnifiedManagementRepository);
  const previous = process.env.UNIFIED_PERFORMANCE_ENABLED;
  delete process.env.UNIFIED_PERFORMANCE_ENABLED;
  try { await assert.rejects(service.listProducts({}), /비활성화/); } finally { if (previous !== undefined) process.env.UNIFIED_PERFORMANCE_ENABLED = previous; }
  await enabled(async () => {
    await assert.rejects(service.saveProduct({ canonicalName: "상품 A", reason: "test" }, { id: "reader", permissions: ["data.read"] }), /변경 권한/);
    await assert.rejects(service.saveRule(base, { id: "reader", permissions: ["data.read"] }), /변경 권한/);
    await assert.rejects(service.deleteRule("id", { expectedVersion: 1, reason: "test" }, { id: "reader", permissions: ["data.read"] }), /변경 권한/);
  });
});

test("validation retains model numbers and option symbols and rejects ID predicates, invalid date, number amounts", () => {
  assert.equal(configurationProduct({ canonicalName: "  PORON  1+1  100ML ", reason: "test" }).normalizedName, "poron 1+1 100ml");
  assert.throws(() => configurationRule({ ...base, payload: { ...base.payload, productNo: "external-id" } }, "상품 A"), /입력 필드/);
  assert.throws(() => configurationRule({ ...base, validFrom: "2026-02-30" }, "상품 A"));
  assert.throws(() => configurationRule({ ...base, validTo: "2026-10-19" }, "상품 A"));
  assert.throws(() => configurationRule({ ...base, payload: { matchType: "REGEX", terms: ["x"] } }, "상품 A"), (error: unknown) => error instanceof HttpException && error.getStatus() === 400);
  assert.throws(() => configurationRule({ ...base, kind: "SALE_UNIT", payload: { saleUnitName: "1+1", quantityBasis: "SALE_UNIT_TOTAL", productCost: 9000 } }, "상품 A"));
  assert.equal(configurationRule({ ...base, kind: "SALE_UNIT", payload: { saleUnitName: "1+1", quantityBasis: "SALE_UNIT_TOTAL", optionExact: "", productCost: "9000", unitsPerSaleUnit: "2" } }, "상품 A").payload.productCost, "9000");
  assert.throws(() => configurationRule({ ...base, payload: { matchType: "EXACT", terms: [" "] } }, "상품 A"));
  assert.throws(() => configurationRule({ ...base, kind: "SCOPE_POLICY", platform: "META", payload: { components: ["SALE"] } }, "상품 A"), /구성요소/);
  assert.throws(() => configurationRule({ ...base, kind: "SCOPE_POLICY", payload: { components: ["AD_SPEND"] } }, "상품 A"), /구성요소/);
});

test("allocation uses exact decimal weights, rejects repeated products and preserves explicit unallocated policy", () => {
  const allocation = { ...base, kind: "ALLOCATION", productId: null, platform: "NAVER", payload: { method: "FIXED_WEIGHTS", component: "SHIPPING_COST", targets: [
    { productName: "A", weight: "0.1" }, { productName: "B", weight: "0.2" }, { productName: "C", weight: "0.7" }
  ] } } as RuleInput;
  assert.equal(configurationRule(allocation).kind, "ALLOCATION");
  assert.throws(() => configurationRule({ ...allocation, payload: { ...allocation.payload, targets: [{ productName: "A", weight: "0.9999999999" }] } }), /정확히 1/);
  assert.throws(() => configurationRule({ ...allocation, payload: { ...allocation.payload, targets: [{ productName: "A", weight: "0.5" }, { productName: "a", weight: "0.5" }] } }), /중복/);
  assert.throws(() => configurationRule({ ...allocation, payload: { ...allocation.payload, targets: [{ productName: "A", weight: 1 }] } }), /소수 문자열/);
  assert.equal(configurationRule({ ...allocation, payload: { method: "UNALLOCATED", component: "SHIPPING_COST", targets: [] } }).payload.method, "UNALLOCATED");
});

test("inclusive ranges and wildcard scopes collide while separate scopes and next day do not", () => {
  const period = (from: string, to: string | null) => ({ validFrom: new Date(from), validTo: to ? new Date(to) : null });
  assert.equal(intervalsOverlap(period("2026-10-20", "2026-10-21"), period("2026-10-21", null)), true);
  assert.equal(intervalsOverlap(period("2026-10-20", "2026-10-21"), period("2026-10-22", null)), false);
  assert.equal(scopesOverlap({ platform: null, scopeKey: null }, { platform: "CAFE24", scopeKey: "one" }), true);
  assert.equal(scopesOverlap({ platform: "CAFE24", scopeKey: "one" }, { platform: "CAFE24", scopeKey: "two" }), false);
});

test("preview performs only read operations and detects alias intersections across a wildcard scope", async () => enabled(async () => {
  const prepared = configurationRule({ ...base, platform: null, payload: { matchType: "EXACT", terms: ["상품 A", "같은 별칭"] } }, "상품 A");
  const catalog = [product(), product("product-2", "상품 B")];
  let reads = 0;
  const readonlyTx = {
    unifiedProduct: { findMany: async () => { reads++; return catalog; } },
    unifiedRule: { findMany: async () => { reads++; return [{ id: "existing", version: 1, ...prepared }]; } }
  };
  const repository = { read: async (work: (tx: unknown) => unknown) => work(readonlyTx), mutate: () => { throw Error("preview attempted mutation"); } } as unknown as UnifiedManagementRepository;
  const service = new UnifiedManagementService(repository);
  const result = await service.previewRule({ ...base, productId: "product-2", payload: { matchType: "EXACT", terms: ["같은 별칭"] }, samples: [{
    originalName: "같은 별칭", originalOption: "", nameField: "product_name", platform: "CAFE24", scopeKey: "synthetic", businessDate: "2026-10-20"
  }] });
  assert.equal(reads, 2);
  assert.equal(result.writesPerformed, false);
  assert.equal(result.canSave, false);
  assert.equal(result.overlaps.length, 1);
  assert.equal(result.samples[0].matchStatus, "AMBIGUOUS");
  const validSample = { originalName: "같은 별칭", nameField: "product_name", platform: "CAFE24", scopeKey: "synthetic", businessDate: "2026-10-20" };
  for (const malformed of [{ saleUnitName: 123 }, { restorationPath: {} }, { requiresSaleUnit: "false" }, { scopeKey: "x".repeat(257) }])
    await assert.rejects(service.previewRule({ ...base, samples: [{ ...validSample, ...malformed }] }),
      (error: unknown) => error instanceof HttpException && error.getStatus() === 400);
}));

test("save and audit run in same repository transaction; stale version does not write", async () => enabled(async () => {
  let writes = 0, audits = 0;
  const before = product();
  const tx = { unifiedProduct: { findUnique: async () => before, findFirst: async () => null,
    update: async ({ data }: { data: object }) => { writes++; return { ...before, ...data, version: 2 }; } },
    unifiedRule: { findMany: async () => [] }, unifiedMappingAudit: { create: async () => { audits++; return {}; } } };
  const repository = { mutate: async (work: (tx: unknown) => unknown) => work(tx) } as unknown as UnifiedManagementRepository;
  const service = new UnifiedManagementService(repository), actor = { id: "actor", permissions: ["products.manage" as const] };
  await assert.rejects(service.saveProduct({ canonicalName: "상품 A", reason: "test", expectedVersion: 2 }, actor, "product-1"), /변경되었습니다/);
  assert.equal(writes, 0); assert.equal(audits, 0);
  const result = await service.saveProduct({ canonicalName: "상품 A", reason: "test", expectedVersion: 1 }, actor, "product-1");
  assert.equal(result.product.version, 2); assert.equal(writes, 1); assert.equal(audits, 1);
}));

test("wildcard allocation names and sale-unit options cannot create competing overlapping rules", async () => enabled(async () => {
  for (const kind of ["ALLOCATION", "SALE_UNIT"] as const) {
    const input = kind === "ALLOCATION" ? { ...base, kind, productId: null, platform: "NAVER" as const,
      payload: { method: "UNALLOCATED", component: "SHIPPING_COST", targets: [] } } : { ...base, kind,
      payload: { saleUnitName: "1+1", quantityBasis: "SALE_UNIT_TOTAL", productCost: "9000" } };
    const stored = configurationRule(input, "상품 A");
    const repository = { read: async (work: (tx: unknown) => unknown) => work({
      unifiedProduct: { findMany: async () => [product()] },
      unifiedRule: { findMany: async () => [{ id: "existing", version: 1, ...stored }] }
    }) } as unknown as UnifiedManagementRepository;
    const preview = await new UnifiedManagementService(repository).previewRule({ ...input,
      payload: kind === "ALLOCATION" ? { ...input.payload, nameExact: "배송 항목" } : { ...input.payload, optionExact: "블랙" } });
    assert.equal(preview.canSave, false);
    assert.equal(preview.overlaps.length, 1);
  }
}));

test("distinct product contains rules remain saveable but a concrete combined name is ambiguous", async () => enabled(async () => {
  const left = configurationRule({ ...base, payload: { matchType: "CONTAINS", terms: ["상품 A"] } }, "상품 A");
  const repository = { read: async (work: (tx: unknown) => unknown) => work({ unifiedProduct: { findMany: async () => [product(), product("product-2", "상품 B")] },
    unifiedRule: { findMany: async () => [{ id: "existing", version: 1, ...left }] } }) } as unknown as UnifiedManagementRepository;
  const preview = await new UnifiedManagementService(repository).previewRule({ ...base, productId: "product-2", payload: { matchType: "CONTAINS", terms: ["상품 B"] }, samples: [{
    originalName: "상품 A 상품 B 혼합 세트", nameField: "product_name", platform: "CAFE24", scopeKey: "synthetic", businessDate: "2026-10-20"
  }] });
  assert.equal(preview.canSave, true);
  assert.equal(preview.samples[0].matchStatus, "AMBIGUOUS");
}));

test("sale-unit preview reports ambiguity and honors an explicit label without defaulting cost", async () => enabled(async () => {
  const stored = configurationRule({ ...base, kind: "SALE_UNIT", payload: { saleUnitName: "단품", quantityBasis: "SALE_UNIT_TOTAL", productCost: "4500" } }, "상품 A");
  const repository = { read: async (work: (tx: unknown) => unknown) => work({ unifiedProduct: { findMany: async () => [product()] },
    unifiedRule: { findMany: async () => [{ id: "existing", version: 1, ...stored }] } }) } as unknown as UnifiedManagementRepository;
  const sample = { originalName: "상품 A", nameField: "product_name", platform: "CAFE24", scopeKey: "synthetic", businessDate: "2026-10-20", requiresSaleUnit: true };
  const preview = await new UnifiedManagementService(repository).previewRule({ ...base, kind: "SALE_UNIT",
    payload: { saleUnitName: "1+1", quantityBasis: "SALE_UNIT_TOTAL", productCost: "9000", unitsPerSaleUnit: "2" },
    samples: [sample, { ...sample, saleUnitName: "1+1" }, { ...sample, saleUnitName: "알 수 없음" }] });
  assert.equal(preview.canSave, true);
  assert.equal(preview.samples[0].matchStatus, "UNIT_REQUIRED");
  assert.equal(preview.samples[0].unitPreview?.candidates.length, 2);
  assert.equal(preview.samples[1].matchStatus, "MATCHED");
  assert.equal(preview.samples[1].unitPreview?.candidates[0].productCost, "9000");
  assert.equal(preview.samples[2].matchStatus, "UNIT_REQUIRED");
  assert.equal(preview.samples[2].unitPreview?.candidates.length, 0);
}));
