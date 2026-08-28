import { BadRequestException, ConflictException, Injectable } from "@nestjs/common";
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
    let rematchedCount = 0;
    let rematchedAdMetricCount = 0;
    let rematchedByRuleCount = 0;
    let rematchedByManualCount = 0;
    let rematchedStandaloneAdMetricCount = 0;
    let concurrentlyResolvedAdsetCount = 0;
    let concurrentlyResolvedStandaloneAdCount = 0;

    for (const metric of metrics) {
      const outcome = await this.prisma.$transaction(async (tx) => {
        await acquireMetaAdsetMappingFences(tx, [metric.metaAdsetId]);
        const currentMetric = await tx.metaAdsetDailyMetric.findUnique({
          where: { id: metric.id },
          select: {
            id: true, metricDate: true, adsetName: true, metaAdsetId: true,
            uploadRowId: true, isCurrent: true, productId: true
          }
        });
        if (!currentMetric?.isCurrent || currentMetric.productId) {
          return { ...emptyMetaRematchOutcome(), resolvedAdset: 1 };
        }
        const { matcher, histories, rules } = await this.freshProductMatchInputs(tx, currentMetric.metaAdsetId);
        const metricDate = formatDateOnly(currentMetric.metricDate);
        const sourceRows = await tx.metaAdDailyMetric.findMany({
          where: {
            isCurrent: true,
            metaAdsetRefId: currentMetric.metaAdsetId,
            metricDate: currentMetric.metricDate
          },
          select: {
            id: true, uploadRowId: true, metaAdsetRefId: true, metricDate: true,
            adNameSnapshot: true, adsetNameSnapshot: true, campaignNameSnapshot: true,
            productId: true, productMatchSource: true, productMatchRuleId: true
          },
          orderBy: [{ adsetNameSnapshot: "asc" }, { adNameSnapshot: "asc" }]
        });

        if (sourceRows.length === 0) {
          const result = matcher.match(currentMetric.adsetName, metricDate, histories, rules);
          if (!result.productId) return emptyMetaRematchOutcome();
          await tx.metaAdsetDailyMetric.update({
            where: { id: currentMetric.id },
            data: {
              productId: result.productId,
              productMatchSource: result.source as MatchSource,
              productMatchRuleId: result.matchRuleId ?? null
            }
          });
          if (currentMetric.uploadRowId) {
            await tx.uploadRow.update({
              where: { id: currentMetric.uploadRowId },
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
              targetId: currentMetric.id,
              result: SecurityAuditResult.SUCCESS,
              beforeJson: { matched: false },
              afterJson: { matched: true, source: result.source }
            });
          }
          await this.refreshCurrentAdsetProduct(tx, currentMetric.metaAdsetId, actorId);
          return {
            adset: 1, ad: 0,
            rule: result.source === MatchSource.RULE ? 1 : 0,
            manual: result.source === MatchSource.MANUAL ? 1 : 0,
            resolvedAdset: 0, resolvedAd: 0
          };
        }

        const sourceMatches = sourceRows.map((row) => {
          if (row.productId) {
            return {
              id: row.id, uploadRowId: row.uploadRowId, productId: row.productId,
              source: row.productMatchSource, matchRuleId: row.productMatchRuleId, shouldUpdate: false
            };
          }
          const result = matcher.match(sourceRowMatchText(row), metricDate, histories, rules);
          return {
            id: row.id, uploadRowId: row.uploadRowId, productId: result.productId,
            source: result.source as MatchSource, matchRuleId: result.matchRuleId,
            shouldUpdate: Boolean(result.productId)
          };
        });
        const matchedSourceRows = sourceMatches.filter((row) => row.shouldUpdate && row.productId);
        const aggregateMatch = aggregateSourceProductMatch(sourceMatches);
        if (matchedSourceRows.length === 0 && !aggregateMatch) return emptyMetaRematchOutcome();
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
            where: { id: currentMetric.id },
            data: {
              productId: aggregateMatch.productId,
              productMatchSource: aggregateMatch.source,
              productMatchRuleId: aggregateMatch.matchRuleId
            }
          });
          if (currentMetric.uploadRowId) {
            await tx.uploadRow.update({
              where: { id: currentMetric.uploadRowId },
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
            targetId: currentMetric.id,
            result: SecurityAuditResult.SUCCESS,
            beforeJson: { matchedAdMetricCount: 0, matchedAdset: false },
            afterJson: {
              matchedAdMetricCount: matchedSourceRows.length,
              matchedAdset: Boolean(aggregateMatch)
            }
          });
        }
        if (aggregateMatch) {
          await this.refreshCurrentAdsetProduct(tx, currentMetric.metaAdsetId, actorId);
        }
        return {
          adset: aggregateMatch ? 1 : 0,
          ad: matchedSourceRows.length,
          rule: matchedSourceRows.filter((row) => row.source === MatchSource.RULE).length +
            (aggregateMatch && matchedSourceRows.length === 0 && aggregateMatch.source === MatchSource.RULE ? 1 : 0),
          manual: matchedSourceRows.filter((row) => row.source === MatchSource.MANUAL).length +
            (aggregateMatch && matchedSourceRows.length === 0 && aggregateMatch.source === MatchSource.MANUAL ? 1 : 0),
          resolvedAdset: 0, resolvedAd: 0
        };
      });
      rematchedCount += outcome.adset;
      rematchedAdMetricCount += outcome.ad;
      rematchedByRuleCount += outcome.rule;
      rematchedByManualCount += outcome.manual;
      concurrentlyResolvedAdsetCount += outcome.resolvedAdset;
    }

    for (const adMetric of standaloneAdMetrics) {
      const outcome = await this.prisma.$transaction(async (tx) => {
        await acquireMetaAdsetMappingFences(tx, [adMetric.metaAdsetRefId]);
        const currentMetric = await tx.metaAdDailyMetric.findUnique({
          where: { id: adMetric.id },
          select: {
            id: true, uploadRowId: true, metaAdsetRefId: true, metricDate: true,
            adNameSnapshot: true, adsetNameSnapshot: true, campaignNameSnapshot: true,
            productId: true, isCurrent: true
          }
        });
        if (!currentMetric?.isCurrent || currentMetric.productId) {
          return { ...emptyMetaRematchOutcome(), resolvedAd: 1 };
        }
        const { matcher, histories, rules } = await this.freshProductMatchInputs(tx, currentMetric.metaAdsetRefId);
        const result = matcher.match(
          sourceRowMatchText(currentMetric), formatDateOnly(currentMetric.metricDate), histories, rules
        );
        if (!result.productId) return emptyMetaRematchOutcome();
        await tx.metaAdDailyMetric.update({
          where: { id: currentMetric.id },
          data: {
            productId: result.productId,
            productMatchSource: result.source as MatchSource,
            productMatchRuleId: result.matchRuleId ?? null
          }
        });
        if (currentMetric.uploadRowId) {
          await tx.uploadRow.updateMany({
            where: { id: currentMetric.uploadRowId, productId: null },
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
            targetId: currentMetric.id,
            result: SecurityAuditResult.SUCCESS,
            beforeJson: { matched: false },
            afterJson: { matched: true, source: result.source }
          });
        }
        return {
          adset: 0, ad: 1,
          rule: result.source === MatchSource.RULE ? 1 : 0,
          manual: result.source === MatchSource.MANUAL ? 1 : 0,
          resolvedAdset: 0, resolvedAd: 0
        };
      });
      rematchedAdMetricCount += outcome.ad;
      rematchedStandaloneAdMetricCount += outcome.ad;
      rematchedByRuleCount += outcome.rule;
      rematchedByManualCount += outcome.manual;
      concurrentlyResolvedStandaloneAdCount += outcome.resolvedAd;
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
        metrics.length - rematchedCount - concurrentlyResolvedAdsetCount +
        standaloneAdMetrics.length - rematchedStandaloneAdMetricCount - concurrentlyResolvedStandaloneAdCount,
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

  private async freshProductMatchInputs(tx: Prisma.TransactionClient, metaAdsetId: string) {
    const [histories, rules] = await Promise.all([
      tx.adsetProductHistory.findMany({ where: { metaAdsetId } }),
      tx.productMatchRule.findMany({
        where: { isActive: true, product: { is: { isActive: true } } },
        orderBy: { priority: "asc" }
      })
    ]);
    return {
      matcher: new AdsetProductMatcher(),
      histories: histories.map((history) => ({
        productId: history.productId,
        effectiveFrom: formatDateOnly(history.effectiveFrom),
        effectiveTo: history.effectiveTo ? formatDateOnly(history.effectiveTo) : null
      })),
      rules: rules.map((rule) => ({
        id: rule.id, productId: rule.productId, matchType: rule.matchType,
        pattern: rule.pattern, patternKey: rule.patternKey, priority: rule.priority,
        validFrom: formatDateOnly(rule.validFrom),
        validTo: rule.validTo ? formatDateOnly(rule.validTo) : null,
        isActive: rule.isActive
      }))
    };
  }

  private async refreshCurrentAdsetProduct(
    tx: Prisma.TransactionClient,
    metaAdsetId: string,
    actorId?: string
  ) {
    const latest = await tx.metaAdsetDailyMetric.findFirst({
      where: { metaAdsetId, isCurrent: true, productId: { not: null } },
      orderBy: { metricDate: "desc" },
      select: { productId: true }
    });
    if (!latest?.productId) return;
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
  }

  async matchProduct(
    metaAdsetId: string,
    adsetName: string,
    metricDate: Date,
    client: Prisma.TransactionClient | PrismaService = this.prisma
  ) {
    const date = formatDateOnly(metricDate);
    const [histories, rules] = await Promise.all([
      client.adsetProductHistory.findMany({ where: { metaAdsetId } }),
      client.productMatchRule.findMany({
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

  async matchStage(
    metaAdsetId: string,
    adsetName: string,
    metricDate: Date,
    client: Prisma.TransactionClient | PrismaService = this.prisma
  ) {
    const date = formatDateOnly(metricDate);
    const histories = await client.adsetStageHistory.findMany({ where: { metaAdsetId } });
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
    client: Prisma.TransactionClient
  ) {
    const metaAdsetId = optionalString(body.metaAdsetId);
    if (metaAdsetId) {
      const found = await client.metaAdset.findUnique({ where: { id: metaAdsetId } });
      if (!found) {
        throw new BadRequestException({ code: "ADSET_NOT_FOUND", message: "광고세트를 찾을 수 없습니다." });
      }
      await acquireMetaAdsetMappingFences(client, [found.id]);
      const fresh = await client.metaAdset.findUnique({ where: { id: found.id } });
      if (!fresh) throw adsetIdentityChanged();
      return fresh;
    }

    const externalAdsetId = optionalString(body.externalAdsetId) ?? optionalString(body.metaAdsetExternalId);
    if (externalAdsetId) {
      const found = await client.metaAdset.findFirst({ where: { platform: "META", externalAdsetId } });
      if (found) {
        await acquireMetaAdsetMappingFences(client, [found.id]);
        const fresh = await client.metaAdset.findUnique({ where: { id: found.id } });
        if (!fresh || fresh.platform !== "META" || fresh.externalAdsetId !== externalAdsetId) {
          throw adsetIdentityChanged();
        }
        return fresh;
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
        // resolveAdset used to update this row before taking the mapping fence.
        // Rematch takes the opposite order (fence, then row), which allowed an
        // exact row-lock/advisory-lock deadlock. Always fence the read-only
        // candidate first, then re-read and mutate it under that fence.
        await acquireMetaAdsetMappingFences(client, [legacy.id]);
        const fresh = await client.metaAdset.findUnique({ where: { id: legacy.id } });
        if (!fresh || fresh.platform !== "META") throw adsetIdentityChanged();
        if (fresh.externalAdsetId === externalAdsetId) return fresh;
        if (fresh.externalAdsetId !== null || fresh.adsetNameKey !== adsetNameKey) {
          throw adsetIdentityChanged();
        }
        return client.metaAdset.update({
          where: { id: fresh.id },
          data: {
            externalAdsetId,
            adsetName: AdsetNameNormalizer.normalizeName(adsetNameForExternalId),
            adsetNameKey
          }
        });
      }

      const created = await client.metaAdset.create({
        data: {
          platform: "META",
          externalAdsetId,
          adsetName: AdsetNameNormalizer.normalizeName(adsetNameForExternalId),
          adsetNameKey
        }
      });
      await acquireMetaAdsetMappingFences(client, [created.id]);
      return created;
    }

    const adsetName = requiredString(body.adsetName, "adsetName");
    const adsetNameKey = AdsetNameNormalizer.toKey(adsetName);
    const candidates = await client.metaAdset.findMany({
      where: { platform: "META", adsetNameKey },
      orderBy: [{ lastSeenOn: "desc" }, { createdAt: "desc" }]
    });
    const existing = bestAdsetCandidate(candidates);
    if (existing) {
      await acquireMetaAdsetMappingFences(client, [existing.id]);
      const fresh = await client.metaAdset.findUnique({ where: { id: existing.id } });
      if (!fresh || fresh.platform !== "META" || fresh.adsetNameKey !== adsetNameKey) {
        throw adsetIdentityChanged();
      }
      return fresh;
    }
    const created = await client.metaAdset.create({
      data: {
        platform: "META",
        adsetName: AdsetNameNormalizer.normalizeName(adsetName),
        adsetNameKey
      }
    });
    await acquireMetaAdsetMappingFences(client, [created.id]);
    return created;
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

export async function acquireMetaAdsetMappingFences(
  tx: Pick<Prisma.TransactionClient, "$queryRaw">,
  metaAdsetIds: readonly string[]
) {
  for (const metaAdsetId of Array.from(new Set(metaAdsetIds)).sort()) {
    await tx.$queryRaw(Prisma.sql`
      SELECT pg_advisory_xact_lock(hashtextextended(${`meta-adset-mapping:${metaAdsetId}`}, 0))::text AS lock_result
    `);
  }
}

function adsetIdentityChanged() {
  return new ConflictException({
    code: "ADSET_IDENTITY_CHANGED_RETRY_REQUIRED",
    message: "The Meta adset identity changed concurrently. Retry the mapping operation."
  });
}

function emptyMetaRematchOutcome() {
  return { adset: 0, ad: 0, rule: 0, manual: 0, resolvedAdset: 0, resolvedAd: 0 };
}

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
