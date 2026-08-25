import "reflect-metadata";
import { ArgumentMetadata, ValidationPipe } from "@nestjs/common";
import { validate } from "class-validator";
import { describe, expect, it } from "vitest";
import { LoginDto } from "../auth/dto/login.dto";
import { AcceptInvitationDto } from "../auth/dto/accept-invitation.dto";
import { SetInitialPasswordDto } from "../auth/dto/set-initial-password.dto";
import { InviteUserDto } from "../users/dto/invite-user.dto";
import { ReconcileInvitationDto } from "../users/dto/reconcile-invitation.dto";
import { UpdateUserDto } from "../users/dto/update-user.dto";
import {
  CreateChangeLogDto,
  CreateCreativeChangeLogDto,
  CreateProductChangeLogDto
} from "../change-logs/dto/change-log-transport.dto";
import {
  CoupangCostRuleCorrectionDto,
  CoupangCreateProductSettingDto,
  CoupangDailyReportQueryDto,
  CoupangIncludeInactiveQueryDto,
  CoupangManualPurchasesBodyDto,
  CoupangMappingRuleDto,
  CoupangProductSettingsQueryDto,
  CoupangProductGroupDto,
  CoupangProductSettingDto,
  CoupangSalesFeeRuleDto,
  CoupangSalesUploadFormDto,
  CreateCoupangDailyReportCategoryDto,
  ReplaceCoupangDailyReportCategoryProductsDto,
  UpdateCoupangDailyReportCategoryDto
} from "../coupang/dto/coupang-transport.dto";
import { RunDecisionDto } from "../decisions/dto/decision-transport.dto";
import {
  CreateManualProductMappingDto,
  CreateManualStageMappingDto,
  CreateProductMappingRuleDto,
  RematchMetricsDto
} from "../mappings/dto/mappings-transport.dto";
import { DashboardSummaryQueryDto } from "../metrics/dto/metrics-query.dto";
import {
  CreateProductDto,
  ProductCostSnapshotDto,
  ProductCpaSnapshotDto,
  UpdateSettingDto
} from "../products/dto/product-transport.dto";
import { UpdateCoupangManualPurchaseVendorFeeDto } from "../products/dto/update-coupang-manual-purchase-vendor-fee.dto";
import { ExportReportDto } from "../reports/dto/report-transport.dto";
import { Cafe24CouponRuleDto, Cafe24RuleDto } from "../sales/dto/sales-transport.dto";
import { UploadFormDto } from "../uploads/dto/upload-transport.dto";
import { IncludeInactiveQueryDto, TakeQueryDto, UuidParamDto } from "./transport-validation";
import { DangerousJsonKeysPipe } from "./dangerous-json-keys.pipe";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const ISO_UPDATED_AT = "2026-08-25T01:02:03.000Z";

type DtoConstructor = new () => object;

const strictPipe = new ValidationPipe({
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true
});

async function validateDto<T extends object>(metatype: DtoConstructor, value: unknown, type: ArgumentMetadata["type"] = "body") {
  return strictPipe.transform(value, { type, metatype }) as Promise<T>;
}

describe("strict transport validation", () => {
  it("rejects unknown fields, malformed UUID/date/range/take/boolean/enum values, and NaN-like numbers", async () => {
    await expect(validateDto(CreateProductDto, { code: "P-1", name: "Product", unexpected: true }))
      .rejects.toThrow();
    await expect(validateDto(UuidParamDto, { id: "not-a-uuid" }, "param")).rejects.toThrow();
    await expect(validateDto(RematchMetricsDto, { from: "2026-02-30", to: "2026-03-01" }))
      .rejects.toThrow();
    await expect(validateDto(RematchMetricsDto, { from: "2026-08-25", to: "2026-08-24" }))
      .rejects.toThrow();
    for (const take of ["0", "-1", "1.5", "1e2", "NaN", "Infinity", "501"]) {
      await expect(validateDto(TakeQueryDto, { take }, "query")).rejects.toThrow();
    }
    await expect(validateDto(UpdateUserDto, { isActive: "false" })).rejects.toThrow();
    await expect(validateDto(CreateProductMappingRuleDto, {
      productId: UUID_A,
      matchType: "NOT_AN_ENUM",
      pattern: "Product"
    })).rejects.toThrow();
  });

  it("keeps query booleans exact and converts only canonical positive integer text", async () => {
    await expect(validateDto(IncludeInactiveQueryDto, { includeInactive: "0" }, "query")).rejects.toThrow();
    const boolQuery = await validateDto<IncludeInactiveQueryDto>(
      IncludeInactiveQueryDto,
      { includeInactive: "false" },
      "query"
    );
    const takeQuery = await validateDto<TakeQueryDto>(TakeQueryDto, { take: "50" }, "query");
    expect(boolQuery.includeInactive).toBe("false");
    expect(takeQuery.take).toBe(50);
  });

  it("rejects null for optional non-null fields and preserves explicit nullable contracts", async () => {
    for (const field of ["name", "role", "isActive"] as const) {
      await expect(validateDto(UpdateUserDto, { [field]: null }), field).rejects.toMatchObject({ status: 400 });
    }
    await expect(validateDto(CoupangProductGroupDto, { displayName: null }))
      .rejects.toMatchObject({ status: 400 });

    await expect(validateDto(CoupangCreateProductSettingDto, {
      displayName: "Product",
      groupId: null,
      sellerShippingFeeKrw: null,
      hanaroShippingFeeKrw: null,
      note: null
    })).resolves.toBeDefined();
    await expect(validateDto(Cafe24CouponRuleDto, {
      name: "Coupon",
      scope: "GLOBAL",
      productId: null,
      discountKrw: 1_000,
      validFrom: "2026-08-25",
      validTo: null,
      note: null
    })).resolves.toBeDefined();
  });

  it("rejects oversized strings, arrays, and deeply nested JSON", async () => {
    await expect(validateDto(CreateProductDto, { code: "X".repeat(81), name: "Product" })).rejects.toThrow();
    await expect(validateDto(CoupangMappingRuleDto, {
      coupangProductId: UUID_A,
      includeKeywords: Array.from({ length: 101 }, (_, index) => `keyword-${index}`)
    })).rejects.toThrow();
    let deep: unknown = "leaf";
    for (let depth = 0; depth < 8; depth += 1) deep = { child: deep };
    await expect(validateDto(UpdateSettingDto, { valueJson: deep })).rejects.toThrow();
  });

  it("rejects dangerous, oversized, and control-character JSON keys and enforces serialized bytes", async () => {
    for (const key of ["__proto__", "prototype", "constructor"]) {
      const valueJson = JSON.parse(`{${JSON.stringify(key)}:{"polluted":true}}`) as Record<string, unknown>;
      const dto = new UpdateSettingDto();
      dto.valueJson = valueJson;
      expect(await validate(dto), key).not.toHaveLength(0);
    }
    const dangerousKeysPipe = new DangerousJsonKeysPipe();
    for (const key of ["__proto__", "prototype", "constructor"]) {
      const valueJson = JSON.parse(`{${JSON.stringify(key)}:{"polluted":true}}`) as Record<string, unknown>;
      expect(() => dangerousKeysPipe.transform({ valueJson }, { type: "body" })).toThrow();
    }
    let excessivelyDeep: unknown = "leaf";
    for (let depth = 0; depth < 5_000; depth += 1) {
      excessivelyDeep = { child: excessivelyDeep };
    }
    expect(() => dangerousKeysPipe.transform(
      { unexpected: excessivelyDeep },
      { type: "body" }
    )).toThrow("Request JSON exceeds the allowed depth or node count.");
    await expect(validateDto(UpdateSettingDto, { valueJson: { ["k".repeat(257)]: true } })).rejects.toThrow();
    await expect(validateDto(UpdateSettingDto, { valueJson: { "line\nbreak": true } })).rejects.toThrow();
    await expect(validateDto(UpdateSettingDto, { valueJson: { value: "x".repeat(32_767) } })).rejects.toThrow();
  });

  it("rejects unknown nested fields and oversized nested arrays", async () => {
    await expect(validateDto(RunDecisionDto, {
      from: "2026-08-24",
      to: "2026-08-25",
      filters: { deliveryStatus: "active", unexpected: true }
    })).rejects.toThrow();
    await expect(validateDto(CoupangManualPurchasesBodyDto, {
      entries: [{ coupangProductId: UUID_A, quantity: 1, unexpected: true }]
    })).rejects.toThrow();
  });

  it("accepts the normal Web mutation payload contract for every active DTO family", async () => {
    const fixtures: Array<[DtoConstructor, Record<string, unknown>]> = [
      [LoginDto, { email: "owner@example.com", password: "correct horse battery staple" }],
      [AcceptInvitationDto, { tokenHash: "A".repeat(32) }],
      [SetInitialPasswordDto, { password: "long-initial-password" }],
      [InviteUserDto, { email: "operator@example.com", name: "Operator", role: "USER" }],
      [UpdateUserDto, { name: "Updated", role: "ADMIN", isActive: true }],
      [ReconcileInvitationDto, { action: "RETRY_INVITATION" }],
      [CreateProductDto, { code: "P-001", name: "Product", displayName: "Product display" }],
      [ProductCostSnapshotDto, {
        effectiveFrom: "2026-08-24",
        salePriceKrw: "29900",
        productCostKrw: "12000",
        shippingKrw: "3000",
        extraCostKrw: "500",
        fxRateKrwPerUsd: "1380.25"
      }],
      [ProductCpaSnapshotDto, {
        effectiveFrom: "2026-08-24",
        targetRatio: "1.25",
        watchRatio: "1.5",
        stopRatio: "2"
      }],
      [UpdateCoupangManualPurchaseVendorFeeDto, { valueJson: 100 }],
      [CreateProductMappingRuleDto, {
        productId: UUID_A,
        matchType: "CONTAINS",
        pattern: "Product",
        priority: 100,
        isActive: true,
        validFrom: "2026-08-24",
        validTo: null,
        note: null
      }],
      [CreateManualProductMappingDto, {
        metaAdsetId: UUID_B,
        productId: UUID_A,
        effectiveFrom: "2026-08-24",
        effectiveTo: null,
        applyCurrentMetrics: true,
        note: null
      }],
      [CreateManualStageMappingDto, {
        metaAdsetId: UUID_B,
        stage: "CBO",
        effectiveFrom: "2026-08-24",
        effectiveTo: null,
        applyCurrentMetrics: true,
        note: null
      }],
      [RunDecisionDto, {
        from: "2026-08-24",
        to: "2026-08-25",
        compareType: "previousSamePeriod",
        filters: { deliveryStatus: "active" }
      }],
      [ExportReportDto, {
        from: "2026-08-24",
        to: "2026-08-25",
        reportType: "DAILY_HTML",
        parameters: { deliveryStatus: "all" }
      }],
      [CreateChangeLogDto, {
        actionDate: "2026-08-25",
        actionType: "NOTE",
        targetType: "PRODUCT",
        productId: UUID_A,
        reason: "normal payload",
        previousValue: { enabled: false },
        newValue: { enabled: true }
      }],
      [CreateCreativeChangeLogDto, { actionDate: "2026-08-25", actionType: "NOTE", reason: "normal" }],
      [CreateProductChangeLogDto, { actionDate: "2026-08-25", text: "normal" }],
      [UploadFormDto, { conflictPolicy: "SKIP" }],
      [Cafe24RuleDto, {
        productId: UUID_A,
        displayName: "Cafe24 rule",
        productNumbers: ["P-001"],
        productNameAliases: ["Product"],
        optionIncludeKeywords: ["red"],
        optionExcludeKeywords: ["damaged"],
        adCostSourceProductId: UUID_B,
        roasGroup: null,
        salePriceKrwOverride: 29_900,
        productCostKrwOverride: 12_000,
        shippingKrwOverride: 3_000,
        extraCostKrwOverride: 500,
        priority: 100,
        isActive: true,
        validFrom: "2026-08-24",
        validTo: null,
        note: null
      }],
      [Cafe24CouponRuleDto, {
        name: "Global coupon",
        scope: "GLOBAL",
        productId: null,
        discountKrw: 1_000,
        priority: 100,
        validFrom: "2026-08-24",
        validTo: null,
        isActive: true,
        note: null
      }],
      [CoupangSalesUploadFormDto, {
        conflictPolicy: "SKIP",
        reportDate: "2026-08-24",
        cancelAmountMode: "SALES_IS_NET"
      }],
      [CoupangCreateProductSettingDto, {
        displayName: "Coupang product",
        standardName: "Coupang product",
        groupId: null,
        salePriceKrw: 29_900,
        supplyPriceKrw: 15_000,
        productCostKrw: 12_800,
        sellerShippingFeeKrw: null,
        hanaroShippingFeeKrw: null,
        growthInboundFeeKrw: 0,
        growthShippingFeeKrw: 0,
        returnRate: 0.01,
        returnCostPerUnitKrw: 0,
        extraCostKrw: 0,
        effectiveFrom: "2026-08-24"
      }],
      [CoupangProductSettingDto, {
        displayName: "Coupang product",
        standardName: "Coupang product",
        groupId: null,
        mappingRuleId: UUID_B,
        includeKeywords: ["Product"],
        excludeKeywords: [],
        priority: 100,
        productCostKrw: 12_800,
        effectiveFrom: "2026-08-24"
      }],
      [CoupangCostRuleCorrectionDto, {
        productCostKrw: 12_800,
        salesFeeRate: 0.1188,
        salesFeeKrw: 0,
        effectiveFrom: "2026-08-24",
        note: null
      }],
      [CoupangSalesFeeRuleDto, { salesFeePercent: 11.88, effectiveFrom: "2026-08-24" }],
      [CoupangMappingRuleDto, {
        coupangProductId: UUID_A,
        displayName: "Mapping rule",
        includeKeywords: ["Product"],
        excludeKeywords: [],
        priority: 100,
        validFrom: "2026-08-24",
        validTo: null,
        adEnabled: true,
        isActive: true,
        note: null
      }],
      [CoupangManualPurchasesBodyDto, {
        entries: [{ coupangProductId: UUID_A, coupangProductRuleId: null, quantity: 3, memo: "manual" }]
      }],
      [CreateCoupangDailyReportCategoryDto, { displayName: "Category", sortOrder: 100, productIds: [UUID_A] }],
      [UpdateCoupangDailyReportCategoryDto, { displayName: "Category", sortOrder: 100, isActive: true }],
      [ReplaceCoupangDailyReportCategoryProductsDto, {
        displayName: "Category",
        sortOrder: 100,
        productIds: [UUID_A, UUID_B],
        expectedUpdatedAt: ISO_UPDATED_AT
      }]
    ];

    for (const [metatype, payload] of fixtures) {
      await expect(validateDto(metatype, payload), metatype.name).resolves.toBeDefined();
    }
  });

  it("accepts normal Web query payloads while rejecting malformed daily-report input", async () => {
    await expect(validateDto(DashboardSummaryQueryDto, {
      from: "2026-08-24",
      to: "2026-08-25",
      deliveryStatus: "all"
    }, "query")).resolves.toBeDefined();
    await expect(validateDto(CoupangDailyReportQueryDto, {
      from: "2026-08-24",
      to: "2026-08-25",
      categoryIds: `${UUID_A},${UUID_B}`,
      includeUncategorized: "true",
      q: "Product"
    }, "query")).resolves.toBeDefined();
    await expect(validateDto(CoupangDailyReportQueryDto, {
      categoryIds: `${UUID_A},not-a-uuid`,
      includeUncategorized: "yes"
    }, "query")).rejects.toThrow();
  });

  it("enforces the endpoint-specific manual mapping Web payload split", async () => {
    await expect(validateDto(CreateManualProductMappingDto, {
      metaAdsetId: UUID_B,
      productId: UUID_A,
      stage: "SC",
      effectiveFrom: "2026-08-24"
    })).rejects.toThrow();
    await expect(validateDto(CreateManualStageMappingDto, {
      metaAdsetId: UUID_B,
      stage: "SC",
      productId: UUID_A,
      effectiveFrom: "2026-08-24"
    })).rejects.toThrow();
  });

  it("rejects fields that each Coupang endpoint does not consume", async () => {
    await expect(validateDto(CoupangIncludeInactiveQueryDto, {
      includeInactive: "true",
      date: "2026-08-25"
    }, "query")).rejects.toThrow();
    await expect(validateDto(CoupangProductSettingsQueryDto, {
      includeInactive: "true",
      date: "2026-08-25"
    }, "query")).resolves.toBeDefined();

    await expect(validateDto(CoupangCreateProductSettingDto, {
      displayName: "Product",
      mappingRuleId: UUID_A
    })).rejects.toThrow();
    await expect(validateDto(CoupangProductSettingDto, {
      displayName: "Product",
      salesFeeRate: 0.1
    })).rejects.toThrow();
    await expect(validateDto(CoupangCostRuleCorrectionDto, {
      productCostKrw: 12_800,
      displayName: "ignored metadata"
    })).rejects.toThrow();

    await expect(validateDto(CreateCoupangDailyReportCategoryDto, {
      displayName: "Category",
      sortOrder: 100,
      productIds: [UUID_A],
      isActive: true
    })).rejects.toThrow();
    await expect(validateDto(UpdateCoupangDailyReportCategoryDto, {
      displayName: "Category",
      productIds: [UUID_A]
    })).rejects.toThrow();
    await expect(validateDto(ReplaceCoupangDailyReportCategoryProductsDto, {
      displayName: "Category",
      sortOrder: 100,
      productIds: [UUID_A],
      expectedUpdatedAt: ISO_UPDATED_AT,
      isActive: true
    })).rejects.toThrow();
  });
});
