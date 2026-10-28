import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaService } from "../apps/api/src/common/prisma.service";
import { UnifiedManagementRepository } from "../apps/api/src/unified-performance/management.repository";
import { UnifiedManagementService } from "../apps/api/src/unified-performance/management.service";
import { RuleInput } from "../apps/api/src/unified-performance/management.dto";

const requested = process.env.UNIFIED_TEST_URL;
const allowed = "postgresql://unified_config@127.0.0.1:55447/unified_stage02?schema=meta_ads";
test("isolated PostgreSQL configuration CRUD, preview, CAS, conflicts, rollback and revision snapshots", { skip: !requested }, async () => {
  assert.equal(requested, allowed, "Only this test's isolated host/port/database/config role is allowed.");
  const db = new PrismaClient({ datasourceUrl: requested });
  const repository = new UnifiedManagementRepository(db as unknown as PrismaService);
  const service = new UnifiedManagementService(repository);
  const originalFlag = process.env.UNIFIED_PERFORMANCE_ENABLED;
  process.env.UNIFIED_PERFORMANCE_ENABLED = "true";
  const actor = { id: "00000000-0000-4000-8000-000000000001", permissions: ["products.manage", "mappings.manage"] as const };
  const admin = { ...actor, permissions: [...actor.permissions] };
  const token = randomUUID(), firstName = `테스트 A ${token}`, secondName = `테스트 B ${token}`, alias = `정확 별칭 ${token}`;
  try {
    const identity = await db.$queryRaw<{ database: string; username: string; host: string; version: string }[]>`SELECT current_database() AS database,current_user AS username,inet_server_addr()::text AS host,current_setting('server_version_num') AS version`;
    assert.equal(identity[0].database, "unified_stage02");
    assert.equal(identity[0].username, "unified_config");
    assert.match(identity[0].host, /^127\.0\.0\.1(?:\/32)?$/);
    assert.match(identity[0].version, /^17/);
    const first = (await service.saveProduct({ canonicalName: firstName, reason: "합성 등록" }, admin)).product;
    const second = (await service.saveProduct({ canonicalName: secondName, reason: "합성 등록" }, admin)).product;
    assert.equal(first.version, 1);
    await assert.rejects(repository.read(tx => tx.unifiedProduct.create({ data: { canonicalName: `미리보기 쓰기 ${token}`, normalizedName: `read-only-${token}` } })), /read.only|읽기.?전용/i);
    await assert.rejects(service.saveProduct({ canonicalName: firstName.toUpperCase(), reason: "충돌" }, admin));
    await assert.rejects(service.saveProduct({ canonicalName: firstName, expectedVersion: 9, reason: "오래된 버전" }, admin, first.id));
    const changed = (await service.saveProduct({ canonicalName: firstName, expectedVersion: 1, reason: "수정" }, admin, first.id)).product;
    assert.equal(changed.version, 2);
    assert.equal((await service.audit(first.id)).length, 2);

    const input: RuleInput = { kind: "NAME", productId: first.id, platform: null, scopeKey: null,
      payload: { matchType: "EXACT", terms: [alias] }, validFrom: "2026-10-20", validTo: "2026-10-21", reason: "합성 별칭" };
    const beforeCounts = await db.$transaction([db.unifiedRule.count(), db.unifiedMappingAudit.count()]);
    const preview = await service.previewRule({ ...input, samples: [{ originalName: alias, originalOption: "1+1", platform: "CAFE24", scopeKey: "synthetic", nameField: "product_name", businessDate: "2026-10-20" }] });
    assert.equal(preview.canSave, true); assert.equal(preview.samples[0].canonicalProductName, firstName);
    assert.deepEqual(await db.$transaction([db.unifiedRule.count(), db.unifiedMappingAudit.count()]), beforeCounts);
    const rule = (await service.saveRule(input, admin)).rule;
    await assert.rejects(service.saveRule({ ...input, platform: "CAFE24", scopeKey: "00000000-0000-4000-8000-000000000099" }, admin), /원천 연결/);
    await assert.rejects(service.saveRule({ ...input, platform: "CAFE24", productId: second.id, validFrom: "2026-10-21", validTo: null }, admin));
    const nonOverlapping = (await service.saveRule({ ...input, platform: "CAFE24", productId: second.id, validFrom: "2026-10-22", validTo: null }, admin)).rule;
    assert.equal(nonOverlapping.version, 1);
    const changedRule = (await service.saveRule({ ...input, expectedVersion: 1, reason: "동시 수정 기준" }, admin, rule.id)).rule;
    assert.equal(changedRule.version, 2);
    await assert.rejects(service.saveRule({ ...input, expectedVersion: 1 }, admin, rule.id));
    const inactive = (await service.deleteRule(rule.id, { expectedVersion: 2, reason: "비활성화" }, admin)).rule;
    assert.equal(inactive.active, false); assert.equal(inactive.version, 3);
    assert.equal((await service.audit(rule.id)).length, 3);

    // Two simultaneous creates are serialized across wildcard account scopes.
    const concurrentAlias = `동시 별칭 ${token}`;
    const competing = await Promise.allSettled([first, second].map(item => service.saveRule({ ...input, productId: item.id,
      payload: { matchType: "EXACT", terms: [concurrentAlias] } }, admin)));
    assert.equal(competing.filter(item => item.status === "fulfilled").length, 1);
    assert.equal(competing.filter(item => item.status === "rejected").length, 1);

    const unit = (await service.saveRule({ ...input, kind: "SALE_UNIT", platform: "CAFE24", validTo: null,
      payload: { saleUnitName: "1+1", quantityBasis: "SALE_UNIT_TOTAL", optionExact: "", unitsPerSaleUnit: "2", salePrice: "34900", productCost: "9000", shippingCost: "0", otherCost: "0" } }, admin)).rule;
    assert.equal((unit.payload as Record<string, unknown>).productCost, "9000");
    await service.saveRule({ ...input, kind: "SALE_UNIT", platform: "CAFE24", validTo: null,
      payload: { saleUnitName: "단품", quantityBasis: "SALE_UNIT_TOTAL", optionExact: "", unitsPerSaleUnit: "1", productCost: "4500" } }, admin);
    const sample = { originalName: firstName, originalOption: "", platform: "CAFE24", scopeKey: "synthetic", nameField: "product_name", businessDate: "2026-10-20", requiresSaleUnit: true };
    const unitPreview = await service.previewRule({ ...input, id: unit.id, kind: "SALE_UNIT", platform: "CAFE24", validTo: null,
      payload: unit.payload as Record<string, unknown>, samples: [sample, { ...sample, saleUnitName: "1+1" }] });
    assert.equal(unitPreview.samples[0].matchStatus, "UNIT_REQUIRED");
    assert.equal(unitPreview.samples[0].unitPreview?.candidates.length, 2);
    assert.equal(unitPreview.samples[1].matchStatus, "MATCHED");
    assert.equal(unitPreview.samples[1].unitPreview?.candidates[0].productCost, "9000");
    const allocation = (await service.saveRule({ ...input, kind: "ALLOCATION", productId: null, platform: "NAVER", validTo: null,
      payload: { method: "FIXED_WEIGHTS", component: "SHIPPING_COST", targets: [{ productName: firstName, weight: "0.1" }, { productName: secondName, weight: "0.9" }] } }, admin)).rule;
    await assert.rejects(service.saveProduct({ canonicalName: `${firstName} 변경`, expectedVersion: 2, reason: "배분 참조 보호" }, admin, first.id), /배분 규칙/);
    await assert.rejects(service.saveRule({ ...input, kind: "ALLOCATION", productId: null, platform: "NAVER", validTo: null,
      payload: { method: "FIXED_WEIGHTS", component: "SHIPPING_COST", targets: [{ productName: firstName, weight: "0.8" }] } }, admin));
    await service.deleteRule(allocation.id, { expectedVersion: 1, reason: "종료" }, admin);

    // Failed audit FK must roll the configuration write back atomically.
    const beforeRollback = await db.unifiedProduct.findUniqueOrThrow({ where: { id: first.id } });
    await assert.rejects(service.saveProduct({ canonicalName: `${firstName} 변경`, expectedVersion: beforeRollback.version, reason: "감사 실패 롤백" },
      { ...admin, id: "00000000-0000-4000-8000-000000000099" }, first.id));
    assert.deepEqual(await db.unifiedProduct.findUniqueOrThrow({ where: { id: first.id } }), beforeRollback);
    const snapshot = await repository.snapshot();
    assert.equal(typeof snapshot.versions.configurationVersion, "string");
    // Payload fingerprints protect snapshot revisions even from an out-of-band
    // editor that failed to increment version. This is synthetic fixture only.
    await db.unifiedRule.update({ where: { id: unit.id }, data: { payload: { ...(unit.payload as Record<string, string>), productCost: "9001" } } });
    const afterSnapshot = await repository.snapshot();
    assert.notEqual(afterSnapshot.versions.configurationVersion, snapshot.versions.configurationVersion);
    assert.notEqual(afterSnapshot.versions.saleUnitRuleVersion, snapshot.versions.saleUnitRuleVersion);
    assert.equal(afterSnapshot.versions.nameRuleVersion, snapshot.versions.nameRuleVersion);
    await assert.rejects(service.saveRule(input, { id: admin.id, permissions: ["data.read"] }));
  } finally {
    if (originalFlag === undefined) delete process.env.UNIFIED_PERFORMANCE_ENABLED; else process.env.UNIFIED_PERFORMANCE_ENABLED = originalFlag;
    await db.$disconnect();
  }
});
