import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../common/prisma.service";
import { asDateOnly } from "../common/date-range";

@Injectable()
export class ProductsService {
  constructor(private readonly prisma: PrismaService) {}

  async listProducts(includeInactive = false) {
    return this.prisma.product.findMany({
      where: includeInactive ? undefined : { isActive: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      include: {
        costRules: { orderBy: { effectiveFrom: "desc" }, take: 3 },
        cpaRules: { orderBy: { effectiveFrom: "desc" }, take: 3 }
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
      changeLogCount
    ] = await Promise.all([
      this.prisma.metaAdset.count({ where: { currentProductId: id } }),
      this.prisma.adsetProductHistory.count({ where: { productId: id } }),
      this.prisma.uploadRow.count({ where: { productId: id } }),
      this.prisma.metaAdsetDailyMetric.count({ where: { productId: id } }),
      this.prisma.decisionLog.count({ where: { productId: id } }),
      this.prisma.changeLog.count({ where: { productId: id } })
    ]);
    const hasOperationalData =
      currentAdsetCount +
        adsetHistoryCount +
        uploadRowCount +
        dailyMetricCount +
        decisionLogCount +
        changeLogCount >
      0;

    if (hasOperationalData) {
      const deletedCode = `${product.code}__deleted__${Date.now()}`;
      const updated = await this.prisma.$transaction(async (tx) => {
        await tx.productMatchRule.updateMany({ where: { productId: id }, data: { isActive: false } });
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
        isActive: body.isActive === undefined ? true : Boolean(body.isActive)
      }
    });
  }

  async updateProduct(id: string, body: Record<string, unknown>) {
    await this.assertProduct(id);
    return this.prisma.product.update({
      where: { id },
      data: {
        code: optionalString(body.code),
        name: optionalString(body.name),
        displayName: optionalString(body.displayName),
        sku: body.sku === null ? null : optionalString(body.sku),
        sortOrder: body.sortOrder === undefined ? undefined : numberOrDefault(body.sortOrder, 100),
        isActive: body.isActive === undefined ? undefined : Boolean(body.isActive)
      }
    });
  }

  listCostRules(productId?: string) {
    return this.prisma.productCostRule.findMany({
      where: productId ? { productId } : undefined,
      orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }],
      include: { product: true }
    });
  }

  async createCostRule(body: Record<string, unknown>) {
    const productId = requiredString(body.productId, "productId");
    await this.assertProduct(productId);
    const legacyFxRate = await this.resolveLegacyFxRate(body.fxRateKrwPerUsd);
    const salePriceKrw = decimal(body.salePriceKrw, "salePriceKrw");
    return this.prisma.productCostRule.create({
      data: {
        productId,
        salePriceKrw,
        vatKrw: salePriceKrw.mul(0.1),
        productCostKrw: decimal(body.productCostKrw ?? 0, "productCostKrw"),
        shippingKrw: decimal(body.shippingKrw ?? 0, "shippingKrw"),
        extraCostKrw: decimal(body.extraCostKrw ?? 0, "extraCostKrw"),
        fxRateKrwPerUsd: legacyFxRate,
        effectiveFrom: asDateOnly(requiredString(body.effectiveFrom, "effectiveFrom")),
        effectiveTo: body.effectiveTo ? asDateOnly(String(body.effectiveTo)) : null,
        note: optionalString(body.note)
      }
    });
  }

  listCpaRules(productId?: string) {
    return this.prisma.productCpaRule.findMany({
      where: productId ? { productId } : undefined,
      orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }],
      include: { product: true }
    });
  }

  async createCpaRule(body: Record<string, unknown>) {
    const productId = requiredString(body.productId, "productId");
    await this.assertProduct(productId);
    return this.prisma.productCpaRule.create({
      data: {
        productId,
        targetRatio: decimal(body.targetRatio ?? 0.8, "targetRatio"),
        watchRatio: decimal(body.watchRatio ?? 1.1, "watchRatio"),
        stopRatio: decimal(body.stopRatio ?? 1.25, "stopRatio"),
        effectiveFrom: asDateOnly(requiredString(body.effectiveFrom, "effectiveFrom")),
        effectiveTo: body.effectiveTo ? asDateOnly(String(body.effectiveTo)) : null,
        note: optionalString(body.note)
      }
    });
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

  private async resolveLegacyFxRate(value: unknown) {
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return decimal(value, "fxRateKrwPerUsd");
    }

    const latestRate = await this.prisma.exchangeRate.findFirst({
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

function numberOrDefault(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function decimal(value: unknown, field: string): Prisma.Decimal {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new BadRequestException({ code: "INVALID_NUMBER", message: `${field} 숫자 값이 올바르지 않습니다.` });
  }
  return new Prisma.Decimal(parsed);
}
