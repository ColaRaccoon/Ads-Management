import { MatchType, SecurityAuditResult } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { CoupangService } from "../coupang/coupang.service";
import { ProductsService } from "../products/products.service";
import { Cafe24UploadsService } from "../sales/cafe24-uploads.service";
import { UploadLifecycleService } from "../uploads/upload-lifecycle.service";
import { MappingsService } from "./mappings.service";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";

describe("required mutation security audit coverage", () => {
  it("commits a product delete and SUCCESS audit through the same transaction client", async () => {
    const product = { id: "product-1", code: "P1", name: "Product", isActive: true };
    const auditCreate = vi.fn(async ({ data }) => data);
    const tx = {
      productMatchRule: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      cafe24ProductRule: {
        deleteMany: vi.fn(async () => ({ count: 0 })),
        updateMany: vi.fn(async () => ({ count: 0 }))
      },
      cafe24CouponRule: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      productCpaRule: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      productCostRule: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      product: { delete: vi.fn(async () => product) },
      securityAuditEvent: { create: auditCreate }
    };
    const emptyCount = { count: vi.fn(async () => 0) };
    const prisma = {
      product: { findUnique: vi.fn(async () => product) },
      metaAdset: emptyCount,
      adsetProductHistory: emptyCount,
      uploadRow: emptyCount,
      metaAdsetDailyMetric: emptyCount,
      decisionLog: emptyCount,
      changeLog: emptyCount,
      productChangeLog: emptyCount,
      cafe24OrderLine: emptyCount,
      cafe24ProductRule: emptyCount,
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx))
    };

    await new ProductsService(prisma as never).deleteProduct(product.id, ACTOR_ID);

    expect(tx.product.delete).toHaveBeenCalled();
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorUserId: ACTOR_ID,
        action: "PRODUCT_DELETED",
        result: SecurityAuditResult.SUCCESS,
        targetId: product.id
      })
    });
  });

  it("audits a global setting without copying its raw value", async () => {
    const auditCreate = vi.fn(async ({ data }) => data);
    const tx = {
      appSetting: {
        findUnique: vi.fn(async () => ({ key: "security_mode", valueJson: "old", description: null })),
        upsert: vi.fn(async () => ({ key: "security_mode", valueJson: "sensitive-raw-value", description: null }))
      },
      securityAuditEvent: { create: auditCreate }
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx))
    };

    await new ProductsService(prisma as never).updateSetting(
      "security_mode",
      { valueJson: "sensitive-raw-value" },
      ACTOR_ID
    );

    const event = auditCreate.mock.calls[0][0].data;
    expect(event.action).toBe("APP_SETTING_CHANGED");
    expect(JSON.stringify(event)).not.toContain("sensitive-raw-value");
  });

  it("preserves a Meta upload DB reference and records PARTIAL when file deletion fails", async () => {
    const auditCreate = vi.fn(async ({ data }) => data);
    const transaction = vi.fn();
    const service = new UploadLifecycleService(
      {
        uploadBatch: {
          findUnique: vi.fn(async () => ({
            id: "batch-1",
            originalFilename: "upload.csv",
            storedFilePath: "uploads/file.csv",
            fileHashSha256: "a".repeat(64),
            status: "IMPORTED"
          }))
        },
        securityAuditEvent: { create: auditCreate },
        $transaction: transaction.mockResolvedValue({
          deletedAdMetricCount: 0,
          deletedAdsetMetricCount: 0,
          deletedRowCount: 0,
          deletedErrorCount: 0,
          restoredAdCurrentCount: 0,
          restoredAdsetCurrentCount: 0,
          deletedCreativePlacementCount: 0,
          deletedCreativeAliasCount: 0,
          deletedCreativeLogCount: 0,
          deletedCreativeCount: 0,
          deactivatedCreativeCount: 0
        })
      } as never,
      { retain: vi.fn(async () => { throw new Error("storage unavailable"); }) } as never
    );

    await expect(service.deleteUpload("batch-1", ACTOR_ID)).rejects.toMatchObject({
      response: expect.objectContaining({ code: "UPLOAD_FILE_RETENTION_RETRY_REQUIRED" })
    });
    expect(transaction).toHaveBeenCalledOnce();
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "META_UPLOAD_DELETE",
        result: SecurityAuditResult.REQUESTED
      })
    });
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "META_UPLOAD_DELETE",
        result: SecurityAuditResult.PARTIAL,
        afterJson: expect.objectContaining({ databaseReferencePreserved: true, retryable: true })
      })
    });
  });

  it("writes create-rule audits atomically for Meta and Coupang mappings", async () => {
    const metaAudit = vi.fn(async ({ data }) => data);
    const metaTx = {
      productMatchRule: {
        create: vi.fn(async ({ data }) => ({
          id: "meta-rule-1",
          ...data,
          matchType: MatchType.EXACT,
          priority: 1,
          isActive: true,
          product: { id: "product-1" }
        }))
      },
      securityAuditEvent: { create: metaAudit }
    };
    const metaPrisma = {
      product: { findUnique: vi.fn(async () => ({ id: "product-1", isActive: true })) },
      $transaction: vi.fn(async (callback: (client: typeof metaTx) => Promise<unknown>) => callback(metaTx))
    };
    await new MappingsService(metaPrisma as never).createProductRule(
      { productId: "product-1", pattern: "Product", matchType: "EXACT", priority: 1 },
      ACTOR_ID
    );
    expect(metaAudit).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "META_MAPPING_RULE_CREATED", result: SecurityAuditResult.SUCCESS })
    });

    const coupangAudit = vi.fn(async ({ data }) => data);
    const coupangTx = {
      coupangProductRule: {
        create: vi.fn(async ({ data }) => ({
          id: "coupang-rule-1",
          ...data,
          priority: 1,
          isActive: true,
          product: { id: "coupang-product-1" }
        }))
      },
      securityAuditEvent: { create: coupangAudit }
    };
    const coupangPrisma = {
      coupangProduct: {
        findUnique: vi.fn(async () => ({ id: "coupang-product-1", displayName: "Product", isActive: true }))
      },
      $transaction: vi.fn(async (callback: (client: typeof coupangTx) => Promise<unknown>) => callback(coupangTx))
    };
    await new CoupangService(coupangPrisma as never).createMappingRule(
      { coupangProductId: "coupang-product-1", includeKeywords: ["Product"], priority: 1 },
      ACTOR_ID
    );
    expect(coupangAudit).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "COUPANG_MAPPING_RULE_CREATED", result: SecurityAuditResult.SUCCESS })
    });
  });

  it("records no-op rematch requests for Meta, Cafe24, and Coupang", async () => {
    const auditCreate = vi.fn(async ({ data }) => data);
    const tx = { securityAuditEvent: { create: auditCreate } };
    const transaction = vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx));

    await new MappingsService({
      metaAdsetDailyMetric: { findMany: vi.fn(async () => []) },
      metaAdDailyMetric: { findMany: vi.fn(async () => []) },
      $transaction: transaction
    } as never).rematchCurrentMetrics({}, ACTOR_ID);

    await new Cafe24UploadsService({
      cafe24ProductRule: { findMany: vi.fn(async () => []) },
      cafe24UploadBatch: { findMany: vi.fn(async () => []) },
      $transaction: transaction
    } as never, {} as never).rematchCafe24Lines(
      { from: "2026-08-01", to: "2026-08-01" },
      ACTOR_ID
    );

    await new CoupangService({
      coupangProductRule: { findMany: vi.fn(async () => []) },
      coupangSaleLine: { findMany: vi.fn(async () => []) },
      coupangAdMetric: { findMany: vi.fn(async () => []) },
      coupangPromotionPrice: { findMany: vi.fn(async () => []) },
      $transaction: transaction
    } as never).rematch(
      { from: "2026-08-01", to: "2026-08-01" },
      ACTOR_ID
    );

    expect(auditCreate.mock.calls.map(([call]) => call.data.action)).toEqual([
      "META_MAPPING_REMATCH",
      "CAFE24_MAPPING_REMATCH",
      "COUPANG_MAPPING_REMATCH"
    ]);
  });
});
