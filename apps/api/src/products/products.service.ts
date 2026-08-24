import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../common/prisma.service";
import { asDateOnly } from "../common/date-range";
import { dateValuesDiffer, previousUtcDate } from "../domain/effective-rule";
import { formatDateOnly } from "../domain/date-number";

const PRODUCT_RULE_TRANSACTION_OPTIONS = {
  maxWait: 30_000,
  timeout: 60_000
};

const COST_SNAPSHOT_FIELDS = ["salePriceKrw", "productCostKrw", "shippingKrw", "extraCostKrw", "note"] as const;
const COST_REQUIRED_FIRST_SNAPSHOT_FIELDS = ["salePriceKrw", "productCostKrw", "shippingKrw", "extraCostKrw"] as const;
const CPA_SNAPSHOT_FIELDS = ["targetRatio", "watchRatio", "stopRatio", "note"] as const;
const CPA_REQUIRED_FIRST_SNAPSHOT_FIELDS = ["targetRatio", "watchRatio", "stopRatio"] as const;

@Injectable()
export class ProductsService {
  constructor(private readonly prisma: PrismaService) {}

  async listProducts(includeInactive = false) {
    return this.prisma.product.findMany({
      where: includeInactive ? undefined : { isActive: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      include: {
        costRules: { orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }, { id: "desc" }], take: 3 },
        cpaRules: { orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }, { id: "desc" }], take: 3 }
      }
    });
  }

  async deleteProduct(id: string) {
    const product = await this.assertProduct(id);
    const [
      currentAdsetCount,
      adsetHistoryCount,
      uploadRowCount,
      dailyMetricCount,
      decisionLogCount,
      changeLogCount,
      productChangeLogCount,
      cafe24OrderLineCount,
      cafe24ProductRuleCount,
      cafe24AdCostSourceRuleCount
    ] = await Promise.all([
      this.prisma.metaAdset.count({ where: { currentProductId: id } }),
      this.prisma.adsetProductHistory.count({ where: { productId: id } }),
      this.prisma.uploadRow.count({ where: { productId: id } }),
      this.prisma.metaAdsetDailyMetric.count({ where: { productId: id } }),
      this.prisma.decisionLog.count({ where: { productId: id } }),
      this.prisma.changeLog.count({ where: { productId: id } }),
      this.prisma.productChangeLog.count({ where: { productId: id } }),
      this.prisma.cafe24OrderLine.count({ where: { productId: id } }),
      this.prisma.cafe24ProductRule.count({ where: { productId: id } }),
      this.prisma.cafe24ProductRule.count({ where: { adCostSourceProductId: id } })
    ]);
    const hasOperationalData =
      currentAdsetCount +
        adsetHistoryCount +
        uploadRowCount +
        dailyMetricCount +
        decisionLogCount +
        changeLogCount +
        productChangeLogCount +
        cafe24OrderLineCount +
        cafe24ProductRuleCount +
        cafe24AdCostSourceRuleCount >
      0;

    if (hasOperationalData) {
      const deletedCode = `${product.code}__deleted__${Date.now()}`;
      const updated = await this.prisma.$transaction(async (tx) => {
        await tx.productMatchRule.updateMany({ where: { productId: id }, data: { isActive: false } });
        await tx.cafe24ProductRule.updateMany({ where: { productId: id }, data: { isActive: false } });
        await tx.cafe24CouponRule.updateMany({ where: { productId: id }, data: { isActive: false } });
        await tx.cafe24ProductRule.updateMany({ where: { adCostSourceProductId: id }, data: { adCostSourceProductId: null } });
        await tx.metaAdset.updateMany({ where: { currentProductId: id }, data: { currentProductId: null } });
        return tx.product.update({
          where: { id },
          data: {
            code: deletedCode,
            isActive: false,
            sortOrder: 9999
          }
        });
      });

      return { mode: "deactivated", product: updated };
    }

    const deleted = await this.prisma.$transaction(async (tx) => {
      await tx.productMatchRule.deleteMany({ where: { productId: id } });
      await tx.cafe24ProductRule.deleteMany({ where: { productId: id } });
      await tx.cafe24CouponRule.deleteMany({ where: { productId: id } });
      await tx.cafe24ProductRule.updateMany({ where: { adCostSourceProductId: id }, data: { adCostSourceProductId: null } });
      await tx.productCpaRule.deleteMany({ where: { productId: id } });
      await tx.productCostRule.deleteMany({ where: { productId: id } });
      return tx.product.delete({ where: { id } });
    });

    return { mode: "deleted", product: deleted };
  }

  async createProduct(body: Record<string, unknown>) {
    const code = requiredString(body.code, "code");
    const name = requiredString(body.name, "name");
    return this.prisma.product.create({
      data: {
        code,
        name,
        displayName: String(body.displayName ?? name),
        sku: optionalString(body.sku),
        sortOrder: numberOrDefault(body.sortOrder, 100),
        isActive: booleanValue(body.isActive, true)
      }
    });
  }

  async updateProduct(id: string, body: Record<string, unknown>) {
    await this.assertProduct(id);
    const data = {
      code: optionalString(body.code),
      name: optionalString(body.name),
      displayName: optionalString(body.displayName),
      sku: body.sku === null ? null : optionalString(body.sku),
      sortOrder: body.sortOrder === undefined ? undefined : numberOrDefault(body.sortOrder, 100),
      isActive: body.isActive === undefined ? undefined : booleanValue(body.isActive, true)
    };
    if (data.isActive === false) {
      return this.prisma.$transaction(async (tx) => {
        await tx.cafe24CouponRule.updateMany({
          where: { productId: id },
          data: { isActive: false }
        });
        return tx.product.update({ where: { id }, data });
      });
    }
    return this.prisma.product.update({ where: { id }, data });
  }

  listCostRules(productId?: string) {
    return this.prisma.productCostRule.findMany({
      where: productId ? { productId } : undefined,
      orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      include: { product: true }
    });
  }

  async createCostRule(body: Record<string, unknown>) {
    const productId = requiredString(body.productId, "productId");
    return this.saveCostRuleSnapshot(productId, body);
  }

  async saveCostRuleSnapshot(productId: string, body: Record<string, unknown>) {
    assertServerManagedEffectiveTo(body, "PRODUCT_COST_RULE_EFFECTIVE_TO_MANAGED");
    assertAtLeastOneField(body, COST_SNAPSHOT_FIELDS, "PRODUCT_COST_RULE_SNAPSHOT_EMPTY");
    const effectiveFrom = asDateOnly(requiredString(body.effectiveFrom, "effectiveFrom"));

    return this.prisma.$transaction(async (tx) => {
      await this.assertActiveProductWithClient(tx, productId);
      await this.lockProductRuleWrites(tx, productId);
      const existingRules = await tx.productCostRule.findMany({
        where: { productId },
        orderBy: [{ effectiveFrom: "asc" }, { createdAt: "asc" }, { id: "asc" }]
      });
      assertNoDuplicateEffectiveDates(existingRules, "PRODUCT_COST_RULE_DUPLICATE_DATES");
      const sameDateRule = existingRules.find((rule) => sameDate(rule.effectiveFrom, effectiveFrom)) ?? null;
      const baseRule = sameDateRule ?? latestRuleAtOrBefore(existingRules, effectiveFrom);
      if (!baseRule) {
        assertRequiredFields(body, COST_REQUIRED_FIRST_SNAPSHOT_FIELDS, "PRODUCT_COST_RULE_BASE_REQUIRED");
      }

      const salePriceKrw = hasOwn(body, "salePriceKrw")
        ? decimal(body.salePriceKrw, "salePriceKrw")
        : baseRule!.salePriceKrw;
      const snapshot = {
        salePriceKrw,
        vatKrw: hasOwn(body, "salePriceKrw") || !baseRule ? salePriceKrw.mul(0.1) : baseRule.vatKrw,
        productCostKrw: hasOwn(body, "productCostKrw")
          ? decimal(body.productCostKrw, "productCostKrw")
          : baseRule!.productCostKrw,
        shippingKrw: hasOwn(body, "shippingKrw")
          ? decimal(body.shippingKrw, "shippingKrw")
          : baseRule!.shippingKrw,
        extraCostKrw: hasOwn(body, "extraCostKrw")
          ? decimal(body.extraCostKrw, "extraCostKrw")
          : baseRule!.extraCostKrw,
        fxRateKrwPerUsd: baseRule?.fxRateKrwPerUsd ?? await this.resolveLegacyFxRate(body.fxRateKrwPerUsd, tx),
        effectiveFrom,
        effectiveTo: null,
        note: hasOwn(body, "note") ? nullableString(body.note) : baseRule?.note ?? null
      };
      const saved = sameDateRule
        ? await tx.productCostRule.update({ where: { id: sameDateRule.id }, data: snapshot })
        : await tx.productCostRule.create({ data: { productId, ...snapshot } });
      await this.normalizeCostRuleRanges(tx, productId);
      return this.costRuleWriteResult(tx, productId, saved.id, sameDateRule ? "UPDATED_SAME_DATE" : "CREATED");
    }, PRODUCT_RULE_TRANSACTION_OPTIONS);
  }

  async correctCostRule(productId: string, ruleId: string, body: Record<string, unknown>) {
    assertServerManagedEffectiveTo(body, "PRODUCT_COST_RULE_EFFECTIVE_TO_MANAGED");
    assertAtLeastOneField(
      body,
      ["salePriceKrw", "productCostKrw", "shippingKrw", "extraCostKrw", "fxRateKrwPerUsd", "effectiveFrom", "note"],
      "PRODUCT_COST_RULE_CORRECTION_EMPTY"
    );

    return this.prisma.$transaction(async (tx) => {
      await this.assertProductWithClient(tx, productId);
      await this.lockProductRuleWrites(tx, productId);
      const existing = await tx.productCostRule.findUnique({ where: { id: ruleId } });
      if (!existing) {
        throw new NotFoundException({ code: "PRODUCT_COST_RULE_NOT_FOUND", message: "원가 규칙을 찾을 수 없습니다." });
      }
      if (existing.productId !== productId) {
        throw new BadRequestException({
          code: "PRODUCT_COST_RULE_PRODUCT_MISMATCH",
          message: "다른 제품의 원가 이력은 정정할 수 없습니다."
        });
      }

      const effectiveFrom = hasOwn(body, "effectiveFrom")
        ? asDateOnly(requiredString(body.effectiveFrom, "effectiveFrom"))
        : existing.effectiveFrom;
      const collision = await tx.productCostRule.findFirst({
        where: { productId, effectiveFrom, NOT: { id: ruleId } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }]
      });
      if (collision) {
        throw new BadRequestException({
          code: "PRODUCT_COST_RULE_DATE_EXISTS",
          message: "같은 적용 시작일의 원가 이력이 이미 있습니다. 해당 이력을 정정해주세요."
        });
      }

      const salePriceKrw = hasOwn(body, "salePriceKrw") ? decimal(body.salePriceKrw, "salePriceKrw") : undefined;
      await tx.productCostRule.update({
        where: { id: ruleId },
        data: {
          salePriceKrw,
          vatKrw: salePriceKrw?.mul(0.1),
          productCostKrw: decimalIfPresent(body, "productCostKrw"),
          shippingKrw: decimalIfPresent(body, "shippingKrw"),
          extraCostKrw: decimalIfPresent(body, "extraCostKrw"),
          fxRateKrwPerUsd: decimalIfPresent(body, "fxRateKrwPerUsd"),
          effectiveFrom: hasOwn(body, "effectiveFrom") ? effectiveFrom : undefined,
          note: hasOwn(body, "note") ? nullableString(body.note) : undefined
        }
      });
      await this.normalizeCostRuleRanges(tx, productId);
      return this.costRuleWriteResult(tx, productId, ruleId, "CORRECTED");
    }, PRODUCT_RULE_TRANSACTION_OPTIONS);
  }

  listCpaRules(productId?: string) {
    return this.prisma.productCpaRule.findMany({
      where: productId ? { productId } : undefined,
      orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      include: { product: true }
    });
  }

  async createCpaRule(body: Record<string, unknown>) {
    const productId = requiredString(body.productId, "productId");
    return this.saveCpaRuleSnapshot(productId, body);
  }

  async saveCpaRuleSnapshot(productId: string, body: Record<string, unknown>) {
    assertServerManagedEffectiveTo(body, "PRODUCT_CPA_RULE_EFFECTIVE_TO_MANAGED");
    assertAtLeastOneField(body, CPA_SNAPSHOT_FIELDS, "PRODUCT_CPA_RULE_SNAPSHOT_EMPTY");
    const effectiveFrom = asDateOnly(requiredString(body.effectiveFrom, "effectiveFrom"));

    return this.prisma.$transaction(async (tx) => {
      await this.assertActiveProductWithClient(tx, productId);
      await this.lockProductRuleWrites(tx, productId);
      const existingRules = await tx.productCpaRule.findMany({
        where: { productId },
        orderBy: [{ effectiveFrom: "asc" }, { createdAt: "asc" }, { id: "asc" }]
      });
      assertNoDuplicateEffectiveDates(existingRules, "PRODUCT_CPA_RULE_DUPLICATE_DATES");
      const sameDateRule = existingRules.find((rule) => sameDate(rule.effectiveFrom, effectiveFrom)) ?? null;
      const baseRule = sameDateRule ?? latestRuleAtOrBefore(existingRules, effectiveFrom);
      if (!baseRule) {
        assertRequiredFields(body, CPA_REQUIRED_FIRST_SNAPSHOT_FIELDS, "PRODUCT_CPA_RULE_BASE_REQUIRED");
      }

      const snapshot = {
        targetRatio: hasOwn(body, "targetRatio") ? decimal(body.targetRatio, "targetRatio") : baseRule!.targetRatio,
        watchRatio: hasOwn(body, "watchRatio") ? decimal(body.watchRatio, "watchRatio") : baseRule!.watchRatio,
        stopRatio: hasOwn(body, "stopRatio") ? decimal(body.stopRatio, "stopRatio") : baseRule!.stopRatio,
        effectiveFrom,
        effectiveTo: null,
        note: hasOwn(body, "note") ? nullableString(body.note) : baseRule?.note ?? null
      };
      const saved = sameDateRule
        ? await tx.productCpaRule.update({ where: { id: sameDateRule.id }, data: snapshot })
        : await tx.productCpaRule.create({ data: { productId, ...snapshot } });
      await this.normalizeCpaRuleRanges(tx, productId);
      return this.cpaRuleWriteResult(tx, productId, saved.id, sameDateRule ? "UPDATED_SAME_DATE" : "CREATED");
    }, PRODUCT_RULE_TRANSACTION_OPTIONS);
  }

  async correctCpaRule(productId: string, ruleId: string, body: Record<string, unknown>) {
    assertServerManagedEffectiveTo(body, "PRODUCT_CPA_RULE_EFFECTIVE_TO_MANAGED");
    assertAtLeastOneField(
      body,
      ["targetRatio", "watchRatio", "stopRatio", "effectiveFrom", "note"],
      "PRODUCT_CPA_RULE_CORRECTION_EMPTY"
    );

    return this.prisma.$transaction(async (tx) => {
      await this.assertProductWithClient(tx, productId);
      await this.lockProductRuleWrites(tx, productId);
      const existing = await tx.productCpaRule.findUnique({ where: { id: ruleId } });
      if (!existing) {
        throw new NotFoundException({ code: "PRODUCT_CPA_RULE_NOT_FOUND", message: "CPA 규칙을 찾을 수 없습니다." });
      }
      if (existing.productId !== productId) {
        throw new BadRequestException({
          code: "PRODUCT_CPA_RULE_PRODUCT_MISMATCH",
          message: "다른 제품의 CPA 이력은 정정할 수 없습니다."
        });
      }

      const effectiveFrom = hasOwn(body, "effectiveFrom")
        ? asDateOnly(requiredString(body.effectiveFrom, "effectiveFrom"))
        : existing.effectiveFrom;
      const collision = await tx.productCpaRule.findFirst({
        where: { productId, effectiveFrom, NOT: { id: ruleId } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }]
      });
      if (collision) {
        throw new BadRequestException({
          code: "PRODUCT_CPA_RULE_DATE_EXISTS",
          message: "같은 적용 시작일의 CPA 이력이 이미 있습니다. 해당 이력을 정정해주세요."
        });
      }

      await tx.productCpaRule.update({
        where: { id: ruleId },
        data: {
          targetRatio: decimalIfPresent(body, "targetRatio"),
          watchRatio: decimalIfPresent(body, "watchRatio"),
          stopRatio: decimalIfPresent(body, "stopRatio"),
          effectiveFrom: hasOwn(body, "effectiveFrom") ? effectiveFrom : undefined,
          note: hasOwn(body, "note") ? nullableString(body.note) : undefined
        }
      });
      await this.normalizeCpaRuleRanges(tx, productId);
      return this.cpaRuleWriteResult(tx, productId, ruleId, "CORRECTED");
    }, PRODUCT_RULE_TRANSACTION_OPTIONS);
  }

  async productRuleDuplicateDiagnostics() {
    const [costRules, cpaRules] = await Promise.all([
      this.prisma.productCostRule.findMany({
        orderBy: [{ productId: "asc" }, { effectiveFrom: "asc" }, { createdAt: "desc" }, { id: "desc" }]
      }),
      this.prisma.productCpaRule.findMany({
        orderBy: [{ productId: "asc" }, { effectiveFrom: "asc" }, { createdAt: "desc" }, { id: "desc" }]
      })
    ]);
    return {
      dryRun: true,
      costRules: duplicateRuleDiagnostics(costRules, [
        "salePriceKrw", "vatKrw", "productCostKrw", "shippingKrw", "extraCostKrw", "fxRateKrwPerUsd", "effectiveTo", "note"
      ]),
      cpaRules: duplicateRuleDiagnostics(cpaRules, ["targetRatio", "watchRatio", "stopRatio", "effectiveTo", "note"])
    };
  }

  listSettings() {
    return this.prisma.appSetting.findMany({ orderBy: { key: "asc" } });
  }

  updateSetting(key: string, body: { valueJson?: unknown; description?: string }) {
    if (body.valueJson === undefined) {
      throw new BadRequestException({ code: "VALUE_REQUIRED", message: "valueJson 값이 필요합니다." });
    }
    return this.prisma.appSetting.upsert({
      where: { key },
      update: { valueJson: body.valueJson as Prisma.InputJsonValue, description: body.description },
      create: { key, valueJson: body.valueJson as Prisma.InputJsonValue, description: body.description }
    });
  }

  async assertProduct(id: string) {
    const product = await this.prisma.product.findUnique({ where: { id } });
    if (!product) {
      throw new NotFoundException({ code: "PRODUCT_NOT_FOUND", message: "제품을 찾을 수 없습니다." });
    }
    return product;
  }

  private async assertProductWithClient(client: Pick<Prisma.TransactionClient, "product">, id: string) {
    const product = await client.product.findUnique({ where: { id } });
    if (!product) {
      throw new NotFoundException({ code: "PRODUCT_NOT_FOUND", message: "제품을 찾을 수 없습니다." });
    }
    return product;
  }

  private async assertActiveProductWithClient(client: Pick<Prisma.TransactionClient, "product">, id: string) {
    const product = await this.assertProductWithClient(client, id);
    if (!product.isActive) {
      throw new BadRequestException({
        code: "PRODUCT_INACTIVE",
        message: "비활성 제품에는 새 규칙 이력을 저장할 수 없습니다."
      });
    }
    return product;
  }

  private async lockProductRuleWrites(tx: Prisma.TransactionClient, productId: string) {
    await tx.$queryRaw(Prisma.sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`meta-product-rule:${productId}`}, 0)
      )::text AS lock_result
    `);
  }

  private async normalizeCostRuleRanges(tx: Prisma.TransactionClient, productId: string) {
    const rules = await tx.productCostRule.findMany({
      where: { productId },
      orderBy: [{ effectiveFrom: "asc" }, { createdAt: "asc" }, { id: "asc" }]
    });
    assertNoDuplicateEffectiveDates(rules, "PRODUCT_COST_RULE_DUPLICATE_DATES");
    for (let index = 0; index < rules.length; index += 1) {
      const effectiveTo = rules[index + 1] ? previousUtcDate(rules[index + 1].effectiveFrom) : null;
      if (dateValuesDiffer(rules[index].effectiveTo, effectiveTo)) {
        await tx.productCostRule.update({ where: { id: rules[index].id }, data: { effectiveTo } });
      }
    }
  }

  private async normalizeCpaRuleRanges(tx: Prisma.TransactionClient, productId: string) {
    const rules = await tx.productCpaRule.findMany({
      where: { productId },
      orderBy: [{ effectiveFrom: "asc" }, { createdAt: "asc" }, { id: "asc" }]
    });
    assertNoDuplicateEffectiveDates(rules, "PRODUCT_CPA_RULE_DUPLICATE_DATES");
    for (let index = 0; index < rules.length; index += 1) {
      const effectiveTo = rules[index + 1] ? previousUtcDate(rules[index + 1].effectiveFrom) : null;
      if (dateValuesDiffer(rules[index].effectiveTo, effectiveTo)) {
        await tx.productCpaRule.update({ where: { id: rules[index].id }, data: { effectiveTo } });
      }
    }
  }

  private async costRuleWriteResult(
    tx: Prisma.TransactionClient,
    productId: string,
    ruleId: string,
    operation: "CREATED" | "UPDATED_SAME_DATE" | "CORRECTED"
  ) {
    const rules = await tx.productCostRule.findMany({
      where: { productId },
      orderBy: [{ effectiveFrom: "asc" }, { createdAt: "asc" }, { id: "asc" }]
    });
    const index = rules.findIndex((rule) => rule.id === ruleId);
    const rule = rules[index];
    if (!rule) {
      throw new NotFoundException({ code: "PRODUCT_COST_RULE_NOT_FOUND", message: "저장된 원가 규칙을 찾을 수 없습니다." });
    }
    return ruleWriteResult(operation, rule, rules[index - 1] ?? null, rules[index + 1] ?? null);
  }

  private async cpaRuleWriteResult(
    tx: Prisma.TransactionClient,
    productId: string,
    ruleId: string,
    operation: "CREATED" | "UPDATED_SAME_DATE" | "CORRECTED"
  ) {
    const rules = await tx.productCpaRule.findMany({
      where: { productId },
      orderBy: [{ effectiveFrom: "asc" }, { createdAt: "asc" }, { id: "asc" }]
    });
    const index = rules.findIndex((rule) => rule.id === ruleId);
    const rule = rules[index];
    if (!rule) {
      throw new NotFoundException({ code: "PRODUCT_CPA_RULE_NOT_FOUND", message: "저장된 CPA 규칙을 찾을 수 없습니다." });
    }
    return ruleWriteResult(operation, rule, rules[index - 1] ?? null, rules[index + 1] ?? null);
  }

  private async resolveLegacyFxRate(
    value: unknown,
    client: Pick<Prisma.TransactionClient, "exchangeRate"> | PrismaService = this.prisma
  ) {
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return decimal(value, "fxRateKrwPerUsd");
    }

    const latestRate = await client.exchangeRate.findFirst({
      where: { baseCurrency: "USD", quoteCurrency: "KRW", provider: "KOREA_EXIM" },
      orderBy: [{ sourceDate: "desc" }, { rateDate: "desc" }]
    });
    return latestRate?.rate ?? new Prisma.Decimal(0);
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new BadRequestException({ code: "FIELD_REQUIRED", message: `${field} 값이 필요합니다.` });
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return undefined;
  }
  const text = String(value).trim();
  return text ? text : undefined;
}

function nullableString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return String(value).trim() || null;
}

function decimalIfPresent(body: Record<string, unknown>, field: string): Prisma.Decimal | undefined {
  return hasOwn(body, field) ? decimal(body[field], field) : undefined;
}

function hasOwn(body: Record<string, unknown>, field: string) {
  return Object.prototype.hasOwnProperty.call(body, field);
}

function assertServerManagedEffectiveTo(body: Record<string, unknown>, code: string) {
  if (hasOwn(body, "effectiveTo")) {
    throw new BadRequestException({
      code,
      message: "effectiveTo는 다음 규칙의 시작일을 기준으로 서버가 자동 계산합니다."
    });
  }
}

function assertAtLeastOneField(
  body: Record<string, unknown>,
  fields: readonly string[],
  code: string
) {
  if (!fields.some((field) => hasOwn(body, field))) {
    throw new BadRequestException({ code, message: "저장할 규칙 값을 하나 이상 입력해주세요." });
  }
}

function assertRequiredFields(
  body: Record<string, unknown>,
  fields: readonly string[],
  code: string
) {
  const missingFields = fields.filter((field) => !hasOwn(body, field));
  if (missingFields.length > 0) {
    throw new BadRequestException({
      code,
      message: `기준 규칙이 없는 첫 저장에는 ${missingFields.join(", ")} 값이 필요합니다.`,
      missingFields
    });
  }
}

function sameDate(left: Date, right: Date) {
  return left.getTime() === right.getTime();
}

function latestRuleAtOrBefore<T extends { id: string; effectiveFrom: Date; createdAt: Date }>(
  rules: readonly T[],
  date: Date
): T | null {
  return (
    rules
      .filter((rule) => rule.effectiveFrom <= date)
      .sort((left, right) =>
        right.effectiveFrom.getTime() - left.effectiveFrom.getTime() ||
        right.createdAt.getTime() - left.createdAt.getTime() ||
        right.id.localeCompare(left.id)
      )[0] ?? null
  );
}

function assertNoDuplicateEffectiveDates<T extends { effectiveFrom: Date }>(rules: readonly T[], code: string) {
  const counts = new Map<string, number>();
  for (const rule of rules) {
    const date = formatDateOnly(rule.effectiveFrom);
    counts.set(date, (counts.get(date) ?? 0) + 1);
  }
  const duplicateDates = [...counts.entries()].filter(([, count]) => count > 1).map(([date]) => date);
  if (duplicateDates.length > 0) {
    throw new BadRequestException({
      code,
      message: "같은 적용 시작일의 기존 중복 규칙이 있어 저장을 중단했습니다. 중복 진단 결과를 먼저 확인해주세요.",
      duplicateDates
    });
  }
}

function ruleWriteResult<
  T extends { effectiveFrom: Date; effectiveTo: Date | null },
  O extends "CREATED" | "UPDATED_SAME_DATE" | "CORRECTED"
>(operation: O, rule: T, previousRule: T | null, nextRule: T | null) {
  return {
    operation,
    rule,
    effectiveFrom: formatDateOnly(rule.effectiveFrom),
    effectiveTo: rule.effectiveTo ? formatDateOnly(rule.effectiveTo) : null,
    previousRuleEffectiveTo: previousRule?.effectiveTo ? formatDateOnly(previousRule.effectiveTo) : null,
    nextRuleEffectiveFrom: nextRule ? formatDateOnly(nextRule.effectiveFrom) : null
  };
}

function duplicateRuleDiagnostics<
  T extends { id: string; productId: string; effectiveFrom: Date; createdAt: Date }
>(rules: readonly T[], valueFields: readonly string[]) {
  const grouped = new Map<string, T[]>();
  for (const rule of rules) {
    const key = `${rule.productId}:${formatDateOnly(rule.effectiveFrom)}`;
    grouped.set(key, [...(grouped.get(key) ?? []), rule]);
  }
  const groups = [...grouped.values()]
    .filter((group) => group.length > 1)
    .map((group) => {
      const ordered = [...group].sort((left, right) =>
        right.createdAt.getTime() - left.createdAt.getTime() || right.id.localeCompare(left.id)
      );
      const fingerprints = ordered.map((rule) => ruleValueFingerprint(rule, valueFields));
      return {
        productId: ordered[0].productId,
        effectiveFrom: formatDateOnly(ordered[0].effectiveFrom),
        rowCount: ordered.length,
        keepCandidateId: ordered[0].id,
        duplicateRuleIds: ordered.slice(1).map((rule) => rule.id),
        identicalValues: fingerprints.every((fingerprint) => fingerprint === fingerprints[0]),
        candidates: ordered.map((rule) => ({ id: rule.id, createdAt: rule.createdAt.toISOString() }))
      };
    });
  return {
    duplicateGroupCount: groups.length,
    duplicateRowCount: groups.reduce((sum, group) => sum + group.rowCount, 0),
    groups
  };
}

function ruleValueFingerprint(rule: object, fields: readonly string[]) {
  const record = rule as Record<string, unknown>;
  return JSON.stringify(fields.map((field) => serializableRuleValue(record[field])));
}

function serializableRuleValue(value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value && typeof value === "object" && "toString" in value) {
    return String(value);
  }
  return value ?? null;
}

function numberOrDefault(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new BadRequestException({
      code: "INVALID_BOOLEAN",
      message: "isActive must be a boolean."
    });
  }
  return value;
}

function decimal(value: unknown, field: string): Prisma.Decimal {
  if (value === null || value === undefined || typeof value === "boolean" || String(value).trim() === "") {
    throw new BadRequestException({ code: "INVALID_NUMBER", message: `${field} 숫자 값이 올바르지 않습니다.` });
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new BadRequestException({ code: "INVALID_NUMBER", message: `${field} 숫자 값이 올바르지 않습니다.` });
  }
  return new Prisma.Decimal(parsed);
}
