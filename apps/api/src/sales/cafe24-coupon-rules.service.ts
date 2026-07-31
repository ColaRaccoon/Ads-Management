import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Cafe24CouponScope, Prisma } from "@prisma/client";
import { PrismaService } from "../common/prisma.service";
import { toDateOnly } from "../domain/date-number";

@Injectable()
export class Cafe24CouponRulesService {
  constructor(private readonly prisma: PrismaService) {}

  listCouponRules(input: {
    productId?: string;
    scope?: string;
    includeInactive?: boolean;
  } = {}) {
    const scope = input.scope === undefined ? undefined : couponScope(input.scope);
    const productId = input.productId?.trim() || undefined;
    return this.prisma.cafe24CouponRule.findMany({
      where: {
        ...(input.includeInactive ? {} : { isActive: true }),
        ...(productId ? { productId } : {}),
        ...(scope ? { scope } : {})
      },
      orderBy: [
        { isActive: "desc" },
        { scope: "asc" },
        { product: { sortOrder: "asc" } },
        { priority: "asc" },
        { validFrom: "desc" },
        { createdAt: "desc" }
      ],
      include: { product: true }
    });
  }

  async createCouponRule(body: Record<string, unknown>) {
    const name = requiredString(body.name, "name");
    const scope = couponScope(body.scope);
    const productId = couponProductId(scope, body.productId);
    const discountKrw = couponAmount(body.discountKrw);
    const priority = integerValue(body.priority ?? 100, "priority");
    const validFrom = requiredDateOnly(body.validFrom, "validFrom");
    const validTo = optionalDateOnly(body.validTo, "validTo");
    const isActive = booleanValue(body.isActive, true);
    assertValidDateRange(validFrom, validTo);
    if (productId) {
      await this.assertActiveProduct(productId);
    }

    return this.prisma.cafe24CouponRule.create({
      data: {
        name,
        scope,
        productId,
        discountKrw: new Prisma.Decimal(discountKrw),
        priority,
        validFrom,
        validTo,
        isActive,
        note: nullableString(body.note)
      },
      include: { product: true }
    });
  }

  async updateCouponRule(id: string, body: Record<string, unknown>) {
    const existing = await this.prisma.cafe24CouponRule.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException({
        code: "COUPON_RULE_NOT_FOUND",
        message: "Cafe24 coupon rule was not found."
      });
    }

    const scope = body.scope === undefined ? existing.scope : couponScope(body.scope);
    const requestedProductId = Object.prototype.hasOwnProperty.call(body, "productId")
      ? body.productId
      : existing.productId;
    const productId = couponProductId(scope, requestedProductId);
    const name = body.name === undefined ? existing.name : requiredString(body.name, "name");
    const discountKrw =
      body.discountKrw === undefined ? Number(existing.discountKrw) : couponAmount(body.discountKrw);
    const priority =
      body.priority === undefined ? existing.priority : integerValue(body.priority, "priority");
    const validFrom =
      body.validFrom === undefined ? existing.validFrom : requiredDateOnly(body.validFrom, "validFrom");
    const validTo =
      body.validTo === undefined ? existing.validTo : optionalDateOnly(body.validTo, "validTo");
    const isActive = booleanValue(body.isActive, existing.isActive);
    assertValidDateRange(validFrom, validTo);
    if (productId && isActive) {
      await this.assertActiveProduct(productId);
    }

    return this.prisma.cafe24CouponRule.update({
      where: { id },
      data: {
        name,
        scope,
        productId,
        discountKrw: new Prisma.Decimal(discountKrw),
        priority,
        validFrom,
        validTo,
        isActive,
        note: body.note === undefined ? existing.note : nullableString(body.note)
      },
      include: { product: true }
    });
  }

  private async assertActiveProduct(id: string) {
    const product = await this.prisma.product.findUnique({ where: { id } });
    if (!product) {
      throw new NotFoundException({ code: "PRODUCT_NOT_FOUND", message: "Product was not found." });
    }
    if (!product.isActive) {
      throw new BadRequestException({
        code: "PRODUCT_INACTIVE",
        message: "Inactive products cannot be used for Cafe24 coupon rules."
      });
    }
    return product;
  }
}

function couponScope(value: unknown): Cafe24CouponScope {
  if (value === Cafe24CouponScope.GLOBAL || value === Cafe24CouponScope.PRODUCT) {
    return value;
  }
  throw new BadRequestException({
    code: "INVALID_COUPON_SCOPE",
    message: "scope must be GLOBAL or PRODUCT."
  });
}

function couponProductId(scope: Cafe24CouponScope, value: unknown): string | null {
  const productId = typeof value === "string" ? value.trim() : "";
  if (scope === Cafe24CouponScope.GLOBAL) {
    if (value !== undefined && value !== null && productId !== "") {
      throw new BadRequestException({
        code: "GLOBAL_COUPON_PRODUCT_FORBIDDEN",
        message: "Global coupon rules cannot reference a product."
      });
    }
    return null;
  }
  if (!productId) {
    throw new BadRequestException({
      code: "COUPON_PRODUCT_REQUIRED",
      message: "productId is required for product coupon rules."
    });
  }
  return productId;
}

function couponAmount(value: unknown): number {
  const amount = Number(value);
  if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount < 1) {
    throw new BadRequestException({
      code: "INVALID_COUPON_AMOUNT",
      message: "discountKrw must be an integer of at least 1 KRW."
    });
  }
  return amount;
}

function integerValue(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new BadRequestException({
      code: "INVALID_NUMBER",
      message: `${field} must be an integer.`
    });
  }
  return parsed;
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

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new BadRequestException({ code: "FIELD_REQUIRED", message: `${field} is required.` });
  }
  return value.trim();
}

function nullableString(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const text = String(value).trim();
  return text || null;
}

function requiredDateOnly(value: unknown, field: string): Date {
  if (typeof value !== "string" || value.trim() === "") {
    throw new BadRequestException({ code: "FIELD_REQUIRED", message: `${field} is required.` });
  }
  const parsed = toDateOnly(value.trim());
  if (!parsed) {
    throw invalidDateRange(`${field} must be YYYY-MM-DD.`);
  }
  return parsed;
}

function optionalDateOnly(value: unknown, field: string): Date | null {
  if (value === undefined || value === null || String(value).trim() === "") {
    return null;
  }
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value;
  }
  const parsed = toDateOnly(String(value).trim());
  if (!parsed) {
    throw invalidDateRange(`${field} must be YYYY-MM-DD or null.`);
  }
  return parsed;
}

function assertValidDateRange(validFrom: Date, validTo: Date | null) {
  if (validTo && validTo < validFrom) {
    throw invalidDateRange("validTo must be on or after validFrom.");
  }
}

function invalidDateRange(message: string) {
  return new BadRequestException({ code: "INVALID_COUPON_DATE_RANGE", message });
}
