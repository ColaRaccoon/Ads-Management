import { BadRequestException, Injectable } from "@nestjs/common";
import {
  AdStage,
  MatchSource,
  MatchType,
  Prisma,
  RowValidationStatus,
  SecurityAuditActorType,
  SecurityAuditResult
} from "@prisma/client";
import { PrismaService } from "../common/prisma.service";
import { asDateOnly, parseDateRange } from "../common/date-range";
import { AdsetNameNormalizer } from "../domain/adset-name-normalizer";
import { formatDateOnly } from "../domain/date-number";
import { AdsetProductMatcher, AdsetStageMatcher } from "../domain/matching";
import { writeSecurityAudit } from "../security-audit/security-audit.types";

@Injectable()
export class MappingsService {
  constructor(private readonly prisma: PrismaService) {}

  listProductRules() {
    return this.prisma.productMatchRule.findMany({
      orderBy: [{ isActive: "desc" }, { priority: "asc" }, { createdAt: "desc" }],
      include: { product: true }
    });
  }

  async createProductRule(body: Record<string, unknown>, actorId: string) {
    const productId = requiredString(body.productId, "productId");
    const matchType = parseMatchType(body.matchType);
    const pattern = requiredString(body.pattern, "pattern");
    await this.ensureProduct(productId);
    return this.prisma.$transaction(async (tx) => {
      const created = await tx.productMatchRule.create({ data: {
        productId,
        matchType,
        pattern,
        patternKey: matchType === MatchType.REGEX ? null : AdsetNameNormalizer.toKey(pattern),
        priority: numberOrDefault(body.priority, 100),
        isActive: body.isActive === undefined ? true : Boolean(body.isActive),
        validFrom: body.validFrom ? asDateOnly(String(body.validFrom)) : asDateOnly(formatDateOnly(new Date())),
        validTo: body.validTo ? asDateOnly(String(body.validTo)) : null,
        note: optionalString(body.note),
        createdBy: actorId
      },
      include: { product: true }
      });
      await writeSecurityAudit(tx, {
        actorUserId: actorId,
        actorType: SecurityAuditActorType.USER,
        action: "META_MAPPING_RULE_CREATED",
        targetType: "PRODUCT_MATCH_RULE",
        targetId: created.id,
        result: SecurityAuditResult.SUCCESS,
        afterJson: metaRuleAuditSnapshot(created)
      });
      return created;
    });
  }

  async rematchCurrentMetrics(body: Record<string, unknown> = {}, actorId?: string) {
    const range = dateRangeFromBody(body);
    const [metrics, unmatchedAdMetrics] = await Promise.all([
      this.prisma.metaAdsetDailyMetric.findMany({
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
      }),
      this.prisma.metaAdDailyMetric.findMany({
        where: {
          isCurrent: true,
          productId: null,
          ...(range ? { metricDate: { gte: range.fromDate, lte: range.toDate } } : {})
        },
        select: {
          id: true,
          uploadRowId: true,
          metaAdsetRefId: true,
          metricDate: true,
          adNameSnapshot: true,
          adsetNameSnapshot: true,
          campaignNameSnapshot: true
        },
        orderBy: [{ metricDate: "asc" }, { adsetNameSnapshot: "asc" }, { adNameSnapshot: "asc" }]
      })
    ]);

    if (metrics.length === 0 && unmatchedAdMetrics.length === 0) {
      if (actorId) {
        await this.prisma.$transaction((tx) => writeSecurityAudit(tx, {
          actorUserId: actorId,
          actorType: SecurityAuditActorType.USER,
          action: "META_MAPPING_REMATCH",
          targetType: "META_MAPPING",
          result: SecurityAuditResult.SUCCESS,
          afterJson: { scannedCount: 0, rematchedCount: 0 }
        }));
      }
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

    const adsetMetricKeys = new Set(metrics.map((metric) => adsetDateKey(metric.metaAdsetId, metric.metricDate)));
    const standaloneAdMetrics = unmatchedAdMetrics.filter(
      (metric) => !adsetMetricKeys.has(adsetDateKey(metric.metaAdsetRefId, metric.metricDate))
    );
    const metaAdsetIds = Array.from(new Set([
      ...metrics.map((metric) => metric.metaAdsetId),
      ...standaloneAdMetrics.map((metric) => metric.metaAdsetRefId)
    ]));
    const sourceMetaAdsetIds = Array.from(new Set(metrics.map((metric) => metric.metaAdsetId)));
    const sourceMetricDates = Array.from(
      new Map(metrics.map((metric) => [formatDateOnly(metric.metricDate), metric.metricDate])).values()
    );
    const [histories, rules, adMetrics] = await Promise.all([
      this.prisma.adsetProductHistory.findMany({ where: { metaAdsetId: { in: metaAdsetIds } } }),
      this.prisma.productMatchRule.findMany({
        where: { isActive: true, product: { is: { isActive: true } } },
        orderBy: { priority: "asc" }
      }),
      this.prisma.metaAdDailyMetric.findMany({
        where: {
          isCurrent: true,
          metaAdsetRefId: { in: sourceMetaAdsetIds },
          metricDate: { in: sourceMetricDates }
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
    let rematchedStandaloneAdMetricCount = 0;
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
          if (actorId) {
            await writeSecurityAudit(tx, {
              actorUserId: actorId,
              actorType: SecurityAuditActorType.USER,
              action: "META_MAPPING_REMATCH",
              targetType: "META_ADSET_DAILY_METRIC",
              targetId: metric.id,
              result: SecurityAuditResult.SUCCESS,
              beforeJson: { matched: false },
              afterJson: { matched: true, source: result.source }
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
        if (actorId) {
          await writeSecurityAudit(tx, {
            actorUserId: actorId,
            actorType: SecurityAuditActorType.USER,
            action: "META_MAPPING_REMATCH",
            targetType: "META_ADSET_DAILY_METRIC",
            targetId: metric.id,
            result: SecurityAuditResult.SUCCESS,
            beforeJson: { matchedAdMetricCount: 0, matchedAdset: false },
            afterJson: {
              matchedAdMetricCount: matchedSourceRows.length,
              matchedAdset: Boolean(aggregateMatch)
            }
          });
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

    for (const adMetric of standaloneAdMetrics) {
      const metricDate = formatDateOnly(adMetric.metricDate);
      const historiesForMetric = (historiesByAdset.get(adMetric.metaAdsetRefId) ?? []).map((history) => ({
        productId: history.productId,
        effectiveFrom: formatDateOnly(history.effectiveFrom),
        effectiveTo: history.effectiveTo ? formatDateOnly(history.effectiveTo) : null
      }));
      const result = matcher.match(sourceRowMatchText(adMetric), metricDate, historiesForMetric, activeRules);
      if (!result.productId) {
        continue;
      }

      await this.prisma.$transaction(async (tx) => {
        await tx.metaAdDailyMetric.update({
          where: { id: adMetric.id },
          data: {
            productId: result.productId,
            productMatchSource: result.source as MatchSource,
            productMatchRuleId: result.matchRuleId ?? null
          }
        });
        if (adMetric.uploadRowId) {
          await tx.uploadRow.updateMany({
            where: { id: adMetric.uploadRowId, productId: null },
            data: {
              productId: result.productId,
              productMatchSource: result.source as MatchSource,
              productMatchRuleId: result.matchRuleId ?? null,
              validationStatus: RowValidationStatus.VALID
            }
          });
        }
        if (actorId) {
          await writeSecurityAudit(tx, {
            actorUserId: actorId,
            actorType: SecurityAuditActorType.USER,
            action: "META_MAPPING_REMATCH",
            targetType: "META_AD_DAILY_METRIC",
            targetId: adMetric.id,
            result: SecurityAuditResult.SUCCESS,
            beforeJson: { matched: false },
            afterJson: { matched: true, source: result.source }
          });
        }
      });

      rematchedAdMetricCount += 1;
      rematchedStandaloneAdMetricCount += 1;
      rematchedByRuleCount += result.source === "RULE" ? 1 : 0;
      rematchedByManualCount += result.source === "MANUAL" ? 1 : 0;
    }

    for (const metaAdsetId of affectedAdsetIds) {
      const latest = await this.prisma.metaAdsetDailyMetric.findFirst({
        where: { metaAdsetId, isCurrent: true, productId: { not: null } },
        orderBy: { metricDate: "desc" },
        select: { productId: true }
      });
      if (latest?.productId) {
        await this.prisma.$transaction(async (tx) => {
          await tx.metaAdset.update({ where: { id: metaAdsetId }, data: { currentProductId: latest.productId } });
          if (actorId) {
            await writeSecurityAudit(tx, {
              actorUserId: actorId,
              actorType: SecurityAuditActorType.USER,
              action: "META_MAPPING_REMATCH_CURRENT_PRODUCT",
              targetType: "META_ADSET",
              targetId: metaAdsetId,
              result: SecurityAuditResult.SUCCESS,
              afterJson: { productId: latest.productId }
            });
          }
        });
      }
    }

    if (actorId && rematchedCount === 0 && rematchedAdMetricCount === 0) {
      await this.prisma.$transaction((tx) => writeSecurityAudit(tx, {
        actorUserId: actorId,
        actorType: SecurityAuditActorType.USER,
        action: "META_MAPPING_REMATCH",
        targetType: "META_MAPPING",
        result: SecurityAuditResult.SUCCESS,
        afterJson: { scannedCount: metrics.length + standaloneAdMetrics.length, rematchedCount: 0 }
      }));
    }

    return {
      scannedCount: metrics.length + standaloneAdMetrics.length,
      rematchedCount,
      rematchedAdMetricCount,
      rematchedByRuleCount,
      rematchedByManualCount,
      stillUnmatchedCount:
        metrics.length - rematchedCount + standaloneAdMetrics.length - rematchedStandaloneAdMetricCount,
      range: range ? { from: range.from, to: range.to } : null
    };
  }

  async createManualProductMapping(body: Record<string, unknown>, actorId: string) {
    const productId = requiredString(body.productId, "productId");
    const effectiveFrom = asDateOnly(requiredString(body.effectiveFrom, "effectiveFrom"));
    const effectiveTo = body.effectiveTo ? asDateOnly(String(body.effectiveTo)) : null;
    return this.prisma.$transaction(async (tx) => {
    const metaAdset = await this.resolveAdset(body, tx);
    await this.ensureProduct(productId, tx);

    const history = await tx.adsetProductHistory.create({
      data: {
        metaAdsetId: metaAdset.id,
        productId,
        effectiveFrom,
        effectiveTo,
        source: MatchSource.MANUAL,
        note: optionalString(body.note),
        createdBy: actorId
      }
    });

    await tx.metaAdset.update({
      where: { id: metaAdset.id },
      data: { currentProductId: productId }
    });

    let rematchedMetricCount = 0;
    let rematchedAdMetricCount = 0;
    if (Boolean(body.applyCurrentMetrics)) {
      const result = await (async () => {
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
      })();
      rematchedMetricCount = result.adsetMetricCount;
      rematchedAdMetricCount = result.adMetricCount;
    }

    await writeSecurityAudit(tx, {
      actorUserId: actorId,
      actorType: SecurityAuditActorType.USER,
      action: "META_MANUAL_PRODUCT_MAPPING_CREATED",
      targetType: "ADSET_PRODUCT_HISTORY",
      targetId: history.id,
      result: SecurityAuditResult.SUCCESS,
      afterJson: {
        metaAdsetId: metaAdset.id,
        productId,
        rematchedMetricCount,
        rematchedAdMetricCount
      }
    });
    return { history, rematchedMetricCount, rematchedAdMetricCount };
    });
  }

  async createManualStageMapping(body: Record<string, unknown>, actorId: string) {
    const stage = parseStage(body.stage);
    const effectiveFrom = asDateOnly(requiredString(body.effectiveFrom, "effectiveFrom"));
    const effectiveTo = body.effectiveTo ? asDateOnly(String(body.effectiveTo)) : null;
    return this.prisma.$transaction(async (tx) => {
    const metaAdset = await this.resolveAdset(body, tx);

    const history = await tx.adsetStageHistory.create({
      data: {
        metaAdsetId: metaAdset.id,
        stage,
        effectiveFrom,
        effectiveTo,
        source: MatchSource.MANUAL,
        note: optionalString(body.note),
        createdBy: actorId
      }
    });

    await tx.metaAdset.update({ where: { id: metaAdset.id }, data: { currentStage: stage } });

    let rematchedMetricCount = 0;
    let rematchedAdMetricCount = 0;
    if (Boolean(body.applyCurrentMetrics)) {
      const result = await (async () => {
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
      })();
      rematchedMetricCount = result.adsetMetricCount;
      rematchedAdMetricCount = result.adMetricCount;
    }

    await writeSecurityAudit(tx, {
      actorUserId: actorId,
      actorType: SecurityAuditActorType.USER,
      action: "META_MANUAL_STAGE_MAPPING_CREATED",
      targetType: "ADSET_STAGE_HISTORY",
      targetId: history.id,
      result: SecurityAuditResult.SUCCESS,
      afterJson: { metaAdsetId: metaAdset.id, stage, rematchedMetricCount, rematchedAdMetricCount }
    });
    return { history, rematchedMetricCount, rematchedAdMetricCount };
    });
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

  private async resolveAdset(
    body: Record<string, unknown>,
    client: Pick<Prisma.TransactionClient, "metaAdset"> = this.prisma
  ) {
    const metaAdsetId = optionalString(body.metaAdsetId);
    if (metaAdsetId) {
      const found = await client.metaAdset.findUnique({ where: { id: metaAdsetId } });
      if (!found) {
        throw new BadRequestException({ code: "ADSET_NOT_FOUND", message: "광고세트를 찾을 수 없습니다." });
      }
      return found;
    }

    const externalAdsetId = optionalString(body.externalAdsetId) ?? optionalString(body.metaAdsetExternalId);
    if (externalAdsetId) {
      const found = await client.metaAdset.findFirst({ where: { platform: "META", externalAdsetId } });
      if (found) {
        return found;
      }

      const adsetNameForExternalId = optionalString(body.adsetName);
      if (!adsetNameForExternalId) {
        throw new BadRequestException({ code: "ADSET_NOT_FOUND", message: "externalAdsetId에 해당하는 광고세트를 찾을 수 없습니다." });
      }

      const adsetNameKey = AdsetNameNormalizer.toKey(adsetNameForExternalId);
      const legacyCandidates = await client.metaAdset.findMany({
        where: { platform: "META", externalAdsetId: null, adsetNameKey },
        orderBy: [{ lastSeenOn: "desc" }, { createdAt: "desc" }]
      });
      const legacy = bestAdsetCandidate(legacyCandidates);
      if (legacy) {
        return client.metaAdset.update({
          where: { id: legacy.id },
          data: {
            externalAdsetId,
            adsetName: AdsetNameNormalizer.normalizeName(adsetNameForExternalId),
            adsetNameKey
          }
        });
      }

      return client.metaAdset.create({
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
    const candidates = await client.metaAdset.findMany({
      where: { platform: "META", adsetNameKey },
      orderBy: [{ lastSeenOn: "desc" }, { createdAt: "desc" }]
    });
    const existing = bestAdsetCandidate(candidates);
    if (existing) {
      return existing;
    }
    return client.metaAdset.create({
      data: {
        platform: "META",
        adsetName: AdsetNameNormalizer.normalizeName(adsetName),
        adsetNameKey
      }
    });
  }

  private async ensureProduct(
    productId: string,
    client: Pick<Prisma.TransactionClient, "product"> = this.prisma
  ) {
    const product = await client.product.findUnique({ where: { id: productId } });
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

function metaRuleAuditSnapshot(rule: {
  id: string;
  productId: string;
  matchType: MatchType;
  priority: number;
  isActive: boolean;
}) {
  return {
    id: rule.id,
    productId: rule.productId,
    matchType: rule.matchType,
    priority: rule.priority,
    isActive: rule.isActive
  } satisfies Prisma.InputJsonObject;
}

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
