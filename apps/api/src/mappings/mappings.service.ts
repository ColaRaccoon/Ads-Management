import { BadRequestException, Injectable } from "@nestjs/common";
import { AdStage, MatchSource, MatchType, RowValidationStatus } from "@prisma/client";
import { PrismaService } from "../common/prisma.service";
import { asDateOnly, parseDateRange } from "../common/date-range";
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

  async rematchCurrentMetrics(body: Record<string, unknown> = {}) {
    const range = dateRangeFromBody(body);
    const metrics = await this.prisma.metaAdsetDailyMetric.findMany({
      where: {
        isCurrent: true,
        productId: null,
        ...(range ? { metricDate: { gte: range.fromDate, lte: range.toDate } } : {})
      },
      select: {
        id: true,
        metricDate: true,
        adsetName: true,
        metaAdsetId: true,
        uploadRowId: true
      },
      orderBy: [{ metricDate: "asc" }, { adsetName: "asc" }]
    });

    if (metrics.length === 0) {
      return {
        scannedCount: 0,
        rematchedCount: 0,
        rematchedAdMetricCount: 0,
        rematchedByRuleCount: 0,
        rematchedByManualCount: 0,
        stillUnmatchedCount: 0,
        range: range ? { from: range.from, to: range.to } : null
      };
    }

    const metaAdsetIds = Array.from(new Set(metrics.map((metric) => metric.metaAdsetId)));
    const metricDates = Array.from(new Map(metrics.map((metric) => [formatDateOnly(metric.metricDate), metric.metricDate])).values());
    const [histories, rules, adMetrics] = await Promise.all([
      this.prisma.adsetProductHistory.findMany({ where: { metaAdsetId: { in: metaAdsetIds } } }),
      this.prisma.productMatchRule.findMany({
        where: { isActive: true, product: { is: { isActive: true } } },
        orderBy: { priority: "asc" }
      }),
      this.prisma.metaAdDailyMetric.findMany({
        where: {
          isCurrent: true,
          metaAdsetRefId: { in: metaAdsetIds },
          metricDate: { in: metricDates }
        },
        select: {
          id: true,
          uploadRowId: true,
          metaAdsetRefId: true,
          metricDate: true,
          adNameSnapshot: true,
          adsetNameSnapshot: true,
          campaignNameSnapshot: true,
          productId: true,
          productMatchSource: true,
          productMatchRuleId: true
        },
        orderBy: [{ metricDate: "asc" }, { adsetNameSnapshot: "asc" }, { adNameSnapshot: "asc" }]
      })
    ]);
    const historiesByAdset = new Map<string, typeof histories>();
    for (const history of histories) {
      historiesByAdset.set(history.metaAdsetId, [...(historiesByAdset.get(history.metaAdsetId) ?? []), history]);
    }
    const adMetricsByAdsetDate = new Map<string, typeof adMetrics>();
    for (const adMetric of adMetrics) {
      const key = adsetDateKey(adMetric.metaAdsetRefId, adMetric.metricDate);
      adMetricsByAdsetDate.set(key, [...(adMetricsByAdsetDate.get(key) ?? []), adMetric]);
    }
    const matcher = new AdsetProductMatcher();
    const activeRules = rules.map((rule) => ({
      id: rule.id,
      productId: rule.productId,
      matchType: rule.matchType,
      pattern: rule.pattern,
      patternKey: rule.patternKey,
      priority: rule.priority,
      validFrom: formatDateOnly(rule.validFrom),
      validTo: rule.validTo ? formatDateOnly(rule.validTo) : null,
      isActive: rule.isActive
    }));

    let rematchedCount = 0;
    let rematchedAdMetricCount = 0;
    let rematchedByRuleCount = 0;
    let rematchedByManualCount = 0;
    const affectedAdsetIds = new Set<string>();

    for (const metric of metrics) {
      const metricDate = formatDateOnly(metric.metricDate);
      const historiesForMetric = (historiesByAdset.get(metric.metaAdsetId) ?? []).map((history) => ({
        productId: history.productId,
        effectiveFrom: formatDateOnly(history.effectiveFrom),
        effectiveTo: history.effectiveTo ? formatDateOnly(history.effectiveTo) : null
      }));
      const sourceRows = adMetricsByAdsetDate.get(adsetDateKey(metric.metaAdsetId, metric.metricDate)) ?? [];

      if (sourceRows.length === 0) {
        const result = matcher.match(metric.adsetName, metricDate, historiesForMetric, activeRules);
        if (!result.productId) {
          continue;
        }

        await this.prisma.$transaction(async (tx) => {
          await tx.metaAdsetDailyMetric.update({
            where: { id: metric.id },
            data: {
              productId: result.productId,
              productMatchSource: result.source as MatchSource,
              productMatchRuleId: result.matchRuleId ?? null
            }
          });
          if (metric.uploadRowId) {
            await tx.uploadRow.update({
              where: { id: metric.uploadRowId },
              data: {
                productId: result.productId,
                productMatchSource: result.source as MatchSource,
                productMatchRuleId: result.matchRuleId ?? null,
                validationStatus: RowValidationStatus.VALID
              }
            });
          }
        });

        rematchedCount += 1;
        rematchedByRuleCount += result.source === "RULE" ? 1 : 0;
        rematchedByManualCount += result.source === "MANUAL" ? 1 : 0;
        affectedAdsetIds.add(metric.metaAdsetId);
        continue;
      }

      const sourceMatches = sourceRows.map((row) => {
        if (row.productId) {
          return {
            id: row.id,
            uploadRowId: row.uploadRowId,
            productId: row.productId,
            source: row.productMatchSource,
            matchRuleId: row.productMatchRuleId,
            shouldUpdate: false
          };
        }
        const result = matcher.match(
          sourceRowMatchText(row),
          metricDate,
          historiesForMetric,
          activeRules
        );
        return {
          id: row.id,
          uploadRowId: row.uploadRowId,
          productId: result.productId,
          source: result.source as MatchSource,
          matchRuleId: result.matchRuleId,
          shouldUpdate: Boolean(result.productId)
        };
      });

      const matchedSourceRows = sourceMatches.filter((row) => row.shouldUpdate && row.productId);
      const aggregateMatch = aggregateSourceProductMatch(sourceMatches);
      if (matchedSourceRows.length === 0 && !aggregateMatch) {
        continue;
      }

      await this.prisma.$transaction(async (tx) => {
        for (const sourceRow of matchedSourceRows) {
          await tx.metaAdDailyMetric.update({
            where: { id: sourceRow.id },
            data: {
              productId: sourceRow.productId,
              productMatchSource: sourceRow.source,
              productMatchRuleId: sourceRow.matchRuleId ?? null
            }
          });
          if (sourceRow.uploadRowId) {
            await tx.uploadRow.updateMany({
              where: { id: sourceRow.uploadRowId, productId: null },
              data: {
                productId: sourceRow.productId,
                productMatchSource: sourceRow.source,
                productMatchRuleId: sourceRow.matchRuleId ?? null,
                validationStatus: RowValidationStatus.VALID
              }
            });
          }
        }

        if (aggregateMatch) {
          await tx.metaAdsetDailyMetric.update({
            where: { id: metric.id },
            data: {
              productId: aggregateMatch.productId,
              productMatchSource: aggregateMatch.source,
              productMatchRuleId: aggregateMatch.matchRuleId
            }
          });
          if (metric.uploadRowId) {
            await tx.uploadRow.update({
              where: { id: metric.uploadRowId },
              data: {
                productId: aggregateMatch.productId,
                productMatchSource: aggregateMatch.source,
                productMatchRuleId: aggregateMatch.matchRuleId,
                validationStatus: RowValidationStatus.VALID
              }
            });
          }
        }
      });

      rematchedAdMetricCount += matchedSourceRows.length;
      rematchedByRuleCount += matchedSourceRows.filter((row) => row.source === MatchSource.RULE).length;
      rematchedByManualCount += matchedSourceRows.filter((row) => row.source === MatchSource.MANUAL).length;
      if (aggregateMatch) {
        rematchedCount += 1;
        if (matchedSourceRows.length === 0) {
          rematchedByRuleCount += aggregateMatch.source === MatchSource.RULE ? 1 : 0;
          rematchedByManualCount += aggregateMatch.source === MatchSource.MANUAL ? 1 : 0;
        }
        affectedAdsetIds.add(metric.metaAdsetId);
      }
    }

    for (const metaAdsetId of affectedAdsetIds) {
      const latest = await this.prisma.metaAdsetDailyMetric.findFirst({
        where: { metaAdsetId, isCurrent: true, productId: { not: null } },
        orderBy: { metricDate: "desc" },
        select: { productId: true }
      });
      if (latest?.productId) {
        await this.prisma.metaAdset.update({ where: { id: metaAdsetId }, data: { currentProductId: latest.productId } });
      }
    }

    return {
      scannedCount: metrics.length,
      rematchedCount,
      rematchedAdMetricCount,
      rematchedByRuleCount,
      rematchedByManualCount,
      stillUnmatchedCount: metrics.length - rematchedCount,
      range: range ? { from: range.from, to: range.to } : null
    };
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
    let rematchedAdMetricCount = 0;
    if (Boolean(body.applyCurrentMetrics)) {
      const result = await this.prisma.$transaction(async (tx) => {
        const adsetResult = await tx.metaAdsetDailyMetric.updateMany({
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
        const adResult = await tx.metaAdDailyMetric.updateMany({
          where: {
            metaAdsetRefId: metaAdset.id,
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
        await tx.uploadRow.updateMany({
          where: {
            metaAdsetId: metaAdset.id,
            dateStart: {
              gte: effectiveFrom,
              ...(effectiveTo ? { lte: effectiveTo } : {})
            }
          },
          data: {
            productId,
            productMatchSource: MatchSource.MANUAL,
            productMatchRuleId: null,
            validationStatus: RowValidationStatus.VALID
          }
        });
        return { adsetMetricCount: adsetResult.count, adMetricCount: adResult.count };
      });
      rematchedMetricCount = result.adsetMetricCount;
      rematchedAdMetricCount = result.adMetricCount;
    }

    return { history, rematchedMetricCount, rematchedAdMetricCount };
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
    let rematchedAdMetricCount = 0;
    if (Boolean(body.applyCurrentMetrics)) {
      const result = await this.prisma.$transaction(async (tx) => {
        const adsetResult = await tx.metaAdsetDailyMetric.updateMany({
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
        const adResult = await tx.metaAdDailyMetric.updateMany({
          where: {
            metaAdsetRefId: metaAdset.id,
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
        await tx.uploadRow.updateMany({
          where: {
            metaAdsetId: metaAdset.id,
            dateStart: {
              gte: effectiveFrom,
              ...(effectiveTo ? { lte: effectiveTo } : {})
            }
          },
          data: { stage }
        });
        return { adsetMetricCount: adsetResult.count, adMetricCount: adResult.count };
      });
      rematchedMetricCount = result.adsetMetricCount;
      rematchedAdMetricCount = result.adMetricCount;
    }

    return { history, rematchedMetricCount, rematchedAdMetricCount };
  }

  async matchProduct(metaAdsetId: string, adsetName: string, metricDate: Date) {
    const date = formatDateOnly(metricDate);
    const [histories, rules] = await Promise.all([
      this.prisma.adsetProductHistory.findMany({ where: { metaAdsetId } }),
      this.prisma.productMatchRule.findMany({
        where: { isActive: true, product: { is: { isActive: true } } },
        orderBy: { priority: "asc" }
      })
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

    const externalAdsetId = optionalString(body.externalAdsetId) ?? optionalString(body.metaAdsetExternalId);
    if (externalAdsetId) {
      const found = await this.prisma.metaAdset.findFirst({ where: { platform: "META", externalAdsetId } });
      if (found) {
        return found;
      }

      const adsetNameForExternalId = optionalString(body.adsetName);
      if (!adsetNameForExternalId) {
        throw new BadRequestException({ code: "ADSET_NOT_FOUND", message: "externalAdsetId에 해당하는 광고세트를 찾을 수 없습니다." });
      }

      const adsetNameKey = AdsetNameNormalizer.toKey(adsetNameForExternalId);
      const legacyCandidates = await this.prisma.metaAdset.findMany({
        where: { platform: "META", externalAdsetId: null, adsetNameKey },
        orderBy: [{ lastSeenOn: "desc" }, { createdAt: "desc" }]
      });
      const legacy = bestAdsetCandidate(legacyCandidates);
      if (legacy) {
        return this.prisma.metaAdset.update({
          where: { id: legacy.id },
          data: {
            externalAdsetId,
            adsetName: AdsetNameNormalizer.normalizeName(adsetNameForExternalId),
            adsetNameKey
          }
        });
      }

      return this.prisma.metaAdset.create({
        data: {
          platform: "META",
          externalAdsetId,
          adsetName: AdsetNameNormalizer.normalizeName(adsetNameForExternalId),
          adsetNameKey
        }
      });
    }

    const adsetName = requiredString(body.adsetName, "adsetName");
    const adsetNameKey = AdsetNameNormalizer.toKey(adsetName);
    const candidates = await this.prisma.metaAdset.findMany({
      where: { platform: "META", adsetNameKey },
      orderBy: [{ lastSeenOn: "desc" }, { createdAt: "desc" }]
    });
    const existing = bestAdsetCandidate(candidates);
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
    if (product && !product.isActive) {
      throw new BadRequestException({ code: "PRODUCT_INACTIVE", message: "Inactive products cannot be used for mappings." });
    }
    if (!product) {
      throw new BadRequestException({ code: "PRODUCT_NOT_FOUND", message: "제품을 찾을 수 없습니다." });
    }
  }
}

type RematchSourceProduct = {
  productId: string | null;
  source: MatchSource;
  matchRuleId: string | null;
};

function sourceRowMatchText(row: { adNameSnapshot: string; adsetNameSnapshot: string; campaignNameSnapshot: string }) {
  return `${row.adNameSnapshot} ${row.adsetNameSnapshot} ${row.campaignNameSnapshot}`;
}

function aggregateSourceProductMatch(rows: RematchSourceProduct[]) {
  if (rows.length === 0 || rows.some((row) => !row.productId)) {
    return null;
  }

  const productIds = Array.from(new Set(rows.map((row) => row.productId)));
  if (productIds.length !== 1 || !productIds[0]) {
    return null;
  }

  const sources = new Set(rows.map((row) => row.source).filter((source) => source !== MatchSource.UNMATCHED));
  const source =
    sources.size === 1
      ? Array.from(sources)[0]
      : sources.has(MatchSource.MANUAL)
        ? MatchSource.MANUAL
        : sources.has(MatchSource.RULE)
          ? MatchSource.RULE
          : MatchSource.INFERRED;
  const ruleIds = Array.from(new Set(rows.map((row) => row.matchRuleId).filter((id): id is string => Boolean(id))));

  return {
    productId: productIds[0],
    source,
    matchRuleId: source === MatchSource.RULE && ruleIds.length === 1 ? ruleIds[0] : null
  };
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

function bestAdsetCandidate<T extends { externalAdsetId: string | null; lastSeenOn: Date | null; createdAt: Date }>(candidates: T[]) {
  return [...candidates].sort((left, right) => {
    const externalRank = Number(Boolean(right.externalAdsetId)) - Number(Boolean(left.externalAdsetId));
    if (externalRank !== 0) {
      return externalRank;
    }
    return timestamp(right.lastSeenOn ?? right.createdAt) - timestamp(left.lastSeenOn ?? left.createdAt);
  })[0];
}

function timestamp(value: Date | null | undefined): number {
  return value ? value.getTime() : 0;
}

function adsetDateKey(metaAdsetId: string, metricDate: Date): string {
  return `${metaAdsetId}:${formatDateOnly(metricDate)}`;
}

function dateRangeFromBody(body: Record<string, unknown>) {
  const from = optionalString(body.from);
  const to = optionalString(body.to);
  if (!from && !to) {
    return null;
  }
  if (!from || !to) {
    throw new BadRequestException({ code: "DATE_RANGE_REQUIRED", message: "Both from and to dates are required." });
  }
  return parseDateRange(from, to);
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
