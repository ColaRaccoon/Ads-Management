import { BadRequestException, Injectable } from "@nestjs/common";
import { AdStage, MatchSource, MatchType } from "@prisma/client";
import { PrismaService } from "../common/prisma.service";
import { asDateOnly } from "../common/date-range";
import { AdsetNameNormalizer } from "../domain/adset-name-normalizer";
import { formatDateOnly } from "../domain/date-number";
import { AdsetProductMatcher, AdsetStageMatcher } from "../domain/matching";

@Injectable()
export class MappingsService {
  constructor(private readonly prisma: PrismaService) {}

  listProductRules() {
    return this.prisma.productMatchRule.findMany({
      orderBy: [{ isActive: "desc" }, { priority: "asc" }, { createdAt: "desc" }],
      include: { product: true }
    });
  }

  async createProductRule(body: Record<string, unknown>) {
    const productId = requiredString(body.productId, "productId");
    const matchType = parseMatchType(body.matchType);
    const pattern = requiredString(body.pattern, "pattern");
    await this.ensureProduct(productId);
    return this.prisma.productMatchRule.create({
      data: {
        productId,
        matchType,
        pattern,
        patternKey: matchType === MatchType.REGEX ? null : AdsetNameNormalizer.toKey(pattern),
        priority: numberOrDefault(body.priority, 100),
        isActive: body.isActive === undefined ? true : Boolean(body.isActive),
        validFrom: body.validFrom ? asDateOnly(String(body.validFrom)) : asDateOnly(formatDateOnly(new Date())),
        validTo: body.validTo ? asDateOnly(String(body.validTo)) : null,
        note: optionalString(body.note)
      },
      include: { product: true }
    });
  }

  async createManualProductMapping(body: Record<string, unknown>) {
    const productId = requiredString(body.productId, "productId");
    const effectiveFrom = asDateOnly(requiredString(body.effectiveFrom, "effectiveFrom"));
    const effectiveTo = body.effectiveTo ? asDateOnly(String(body.effectiveTo)) : null;
    const metaAdset = await this.resolveAdset(body);
    await this.ensureProduct(productId);

    const history = await this.prisma.adsetProductHistory.create({
      data: {
        metaAdsetId: metaAdset.id,
        productId,
        effectiveFrom,
        effectiveTo,
        source: MatchSource.MANUAL,
        note: optionalString(body.note)
      }
    });

    await this.prisma.metaAdset.update({
      where: { id: metaAdset.id },
      data: { currentProductId: productId }
    });

    let rematchedMetricCount = 0;
    if (Boolean(body.applyCurrentMetrics)) {
      const result = await this.prisma.metaAdsetDailyMetric.updateMany({
        where: {
          metaAdsetId: metaAdset.id,
          isCurrent: true,
          metricDate: {
            gte: effectiveFrom,
            ...(effectiveTo ? { lte: effectiveTo } : {})
          }
        },
        data: {
          productId,
          productMatchSource: MatchSource.MANUAL,
          productMatchRuleId: null
        }
      });
      rematchedMetricCount = result.count;
    }

    return { history, rematchedMetricCount };
  }

  async createManualStageMapping(body: Record<string, unknown>) {
    const stage = parseStage(body.stage);
    const effectiveFrom = asDateOnly(requiredString(body.effectiveFrom, "effectiveFrom"));
    const effectiveTo = body.effectiveTo ? asDateOnly(String(body.effectiveTo)) : null;
    const metaAdset = await this.resolveAdset(body);

    const history = await this.prisma.adsetStageHistory.create({
      data: {
        metaAdsetId: metaAdset.id,
        stage,
        effectiveFrom,
        effectiveTo,
        source: MatchSource.MANUAL,
        note: optionalString(body.note)
      }
    });

    await this.prisma.metaAdset.update({ where: { id: metaAdset.id }, data: { currentStage: stage } });

    let rematchedMetricCount = 0;
    if (Boolean(body.applyCurrentMetrics)) {
      const result = await this.prisma.metaAdsetDailyMetric.updateMany({
        where: {
          metaAdsetId: metaAdset.id,
          isCurrent: true,
          metricDate: {
            gte: effectiveFrom,
            ...(effectiveTo ? { lte: effectiveTo } : {})
          }
        },
        data: {
          stage,
          stageMatchSource: MatchSource.MANUAL
        }
      });
      rematchedMetricCount = result.count;
    }

    return { history, rematchedMetricCount };
  }

  async matchProduct(metaAdsetId: string, adsetName: string, metricDate: Date) {
    const date = formatDateOnly(metricDate);
    const [histories, rules] = await Promise.all([
      this.prisma.adsetProductHistory.findMany({ where: { metaAdsetId } }),
      this.prisma.productMatchRule.findMany({ where: { isActive: true }, orderBy: { priority: "asc" } })
    ]);
    return new AdsetProductMatcher().match(
      adsetName,
      date,
      histories.map((history) => ({
        productId: history.productId,
        effectiveFrom: formatDateOnly(history.effectiveFrom),
        effectiveTo: history.effectiveTo ? formatDateOnly(history.effectiveTo) : null
      })),
      rules.map((rule) => ({
        id: rule.id,
        productId: rule.productId,
        matchType: rule.matchType,
        pattern: rule.pattern,
        patternKey: rule.patternKey,
        priority: rule.priority,
        validFrom: formatDateOnly(rule.validFrom),
        validTo: rule.validTo ? formatDateOnly(rule.validTo) : null,
        isActive: rule.isActive
      }))
    );
  }

  async matchStage(metaAdsetId: string, adsetName: string, metricDate: Date) {
    const date = formatDateOnly(metricDate);
    const histories = await this.prisma.adsetStageHistory.findMany({ where: { metaAdsetId } });
    return new AdsetStageMatcher().match(
      adsetName,
      date,
      histories.map((history) => ({
        stage: history.stage,
        effectiveFrom: formatDateOnly(history.effectiveFrom),
        effectiveTo: history.effectiveTo ? formatDateOnly(history.effectiveTo) : null
      }))
    );
  }

  private async resolveAdset(body: Record<string, unknown>) {
    const metaAdsetId = optionalString(body.metaAdsetId);
    if (metaAdsetId) {
      const found = await this.prisma.metaAdset.findUnique({ where: { id: metaAdsetId } });
      if (!found) {
        throw new BadRequestException({ code: "ADSET_NOT_FOUND", message: "광고세트를 찾을 수 없습니다." });
      }
      return found;
    }

    const adsetName = requiredString(body.adsetName, "adsetName");
    const adsetNameKey = AdsetNameNormalizer.toKey(adsetName);
    const existing = await this.prisma.metaAdset.findFirst({
      where: { platform: "META", externalAdsetId: null, adsetNameKey }
    });
    if (existing) {
      return existing;
    }
    return this.prisma.metaAdset.create({
      data: {
        platform: "META",
        adsetName: AdsetNameNormalizer.normalizeName(adsetName),
        adsetNameKey
      }
    });
  }

  private async ensureProduct(productId: string) {
    const product = await this.prisma.product.findUnique({ where: { id: productId } });
    if (!product) {
      throw new BadRequestException({ code: "PRODUCT_NOT_FOUND", message: "제품을 찾을 수 없습니다." });
    }
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new BadRequestException({ code: "FIELD_REQUIRED", message: `${field} 값이 필요합니다.` });
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const text = String(value).trim();
  return text ? text : undefined;
}

function numberOrDefault(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseMatchType(value: unknown): MatchType {
  const text = String(value ?? "CONTAINS").toUpperCase();
  if (text in MatchType) {
    return MatchType[text as keyof typeof MatchType];
  }
  throw new BadRequestException({ code: "INVALID_MATCH_TYPE", message: "matchType 값이 올바르지 않습니다." });
}

function parseStage(value: unknown): AdStage {
  const text = String(value ?? "").toUpperCase();
  if (text in AdStage) {
    return AdStage[text as keyof typeof AdStage];
  }
  throw new BadRequestException({ code: "INVALID_STAGE", message: "stage 값이 올바르지 않습니다." });
}
