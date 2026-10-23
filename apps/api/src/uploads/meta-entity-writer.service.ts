import { Injectable } from "@nestjs/common";
import { CreativeParseStatus, Prisma } from "@prisma/client";
import { PrismaService } from "../common/prisma.service";
import { AdsetNameNormalizer } from "../domain/adset-name-normalizer";
import { CreativeNameParser, CreativeNameParts } from "../domain/creative-name-parser";
import { ParsedMetaAdDailyRow } from "../domain/meta-ad-daily-csv";
import { ParsedMetaAdsetRow } from "../domain/meta-csv";
import { creativeOriginalKey, maxDate, minDate } from "./upload-keys";

@Injectable()
export class MetaEntityWriterService {
  private readonly creativeNameParser = new CreativeNameParser();

  constructor(private readonly prisma: PrismaService) {}

  /** API IDs are account scoped. Legacy name-only CSV entities are never rebound here. */
  async upsertApiEntities(input: {
    connectionId: string; metricDate: Date; campaignId: string; campaignName: string;
    adsetId: string; adsetName: string; adId: string; adName: string; creativeId: string;
  }, tx: Prisma.TransactionClient) {
    const campaignWhere = {
      connectionId: input.connectionId, platform: "META", externalCampaignId: input.campaignId
    };
    const existingCampaign = await tx.metaCampaign.findFirst({ where: campaignWhere });
    const campaign = existingCampaign
      ? await tx.metaCampaign.update({ where: { id: existingCampaign.id }, data: {
          ...(!existingCampaign.lastSeenOn || input.metricDate >= existingCampaign.lastSeenOn
            ? { campaignName: input.campaignName } : {}),
          firstSeenOn: minDate(existingCampaign.firstSeenOn, input.metricDate),
          lastSeenOn: maxDate(existingCampaign.lastSeenOn, input.metricDate)
        } })
      : await tx.metaCampaign.create({ data: { ...campaignWhere,
          campaignName: input.campaignName, firstSeenOn: input.metricDate, lastSeenOn: input.metricDate
        } });
    const adsetWhere = { connectionId: input.connectionId, platform: "META", externalAdsetId: input.adsetId };
    const existingAdset = await tx.metaAdset.findFirst({ where: adsetWhere });
    const adset = existingAdset
      ? await tx.metaAdset.update({ where: { id: existingAdset.id }, data: {
          ...(!existingAdset.lastSeenOn || input.metricDate >= existingAdset.lastSeenOn
            ? { campaignRefId: campaign.id, adsetName: input.adsetName,
                adsetNameKey: AdsetNameNormalizer.toKey(input.adsetName) } : {}),
          firstSeenOn: minDate(existingAdset.firstSeenOn, input.metricDate),
          lastSeenOn: maxDate(existingAdset.lastSeenOn, input.metricDate)
        } })
      : await tx.metaAdset.create({ data: { ...adsetWhere,
          campaignRefId: campaign.id, adsetName: input.adsetName,
          adsetNameKey: AdsetNameNormalizer.toKey(input.adsetName),
          firstSeenOn: input.metricDate, lastSeenOn: input.metricDate
        } });
    const adWhere = {
      connectionId: input.connectionId, platform: "META", metaCampaignId: input.campaignId,
      metaAdsetId: input.adsetId, adIdentityKey: input.adId
    };
    const existingAd = await tx.metaAd.findFirst({ where: adWhere });
    const ad = existingAd
      ? await tx.metaAd.update({ where: { id: existingAd.id }, data: {
          ...(!existingAd.lastSeenOn || input.metricDate >= existingAd.lastSeenOn
            ? { campaignRefId: campaign.id, metaAdsetRefId: adset.id,
                creativeId: input.creativeId, adName: input.adName } : {}),
          firstSeenOn: minDate(existingAd.firstSeenOn, input.metricDate),
          lastSeenOn: maxDate(existingAd.lastSeenOn, input.metricDate)
        } })
      : await tx.metaAd.create({ data: { ...adWhere, campaignRefId: campaign.id,
          metaAdsetRefId: adset.id, creativeId: input.creativeId, externalAdId: input.adId,
          syntheticAdKey: input.adId, adName: input.adName,
          firstSeenOn: input.metricDate, lastSeenOn: input.metricDate
        } });
    return { campaign, adset, ad };
  }

  async upsertAdset(parsedRow: ParsedMetaAdsetRow, client: Prisma.TransactionClient | PrismaService = this.prisma,
    connectionId: string | null = null) {
    const existingCandidates = await client.metaAdset.findMany({
      where: { platform: "META", connectionId, adsetNameKey: parsedRow.adsetNameKey },
      orderBy: [{ lastSeenOn: "desc" }, { createdAt: "desc" }]
    });
    const existing = existingCandidates.find((candidate) => candidate.externalAdsetId) ?? existingCandidates[0] ?? null;
    if (existing) {
      return client.metaAdset.update({
        where: { id: existing.id },
        data: {
          adsetName: parsedRow.adsetName,
          firstSeenOn: existing.firstSeenOn ?? parsedRow.metricDate,
          lastSeenOn: parsedRow.metricDate
        }
      });
    }
    return client.metaAdset.create({
      data: {
        platform: "META",
        connectionId,
        adsetName: parsedRow.adsetName,
        adsetNameKey: parsedRow.adsetNameKey,
        firstSeenOn: parsedRow.metricDate,
        lastSeenOn: parsedRow.metricDate
      }
    });
  }

  async upsertCampaign(parsedRow: ParsedMetaAdDailyRow, client: Prisma.TransactionClient | PrismaService = this.prisma,
    connectionId: string | null = null) {
    const existing = await client.metaCampaign.findFirst({
      where: { platform: "META", connectionId, externalCampaignId: parsedRow.metaCampaignId }
    });
    if (existing) {
      return client.metaCampaign.update({
        where: { id: existing.id },
        data: {
          campaignName: parsedRow.campaignName,
          firstSeenOn: existing.firstSeenOn ?? parsedRow.metricDate,
          lastSeenOn: parsedRow.metricDate
        }
      });
    }
    return client.metaCampaign.create({
      data: {
        platform: "META",
        connectionId,
        externalCampaignId: parsedRow.metaCampaignId,
        campaignName: parsedRow.campaignName,
        firstSeenOn: parsedRow.metricDate,
        lastSeenOn: parsedRow.metricDate
      }
    });
  }

  async upsertAdsetFromAdDaily(
    parsedRow: ParsedMetaAdDailyRow,
    campaignRefId: string,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
    connectionId: string | null = null
  ) {
    const adsetNameKey = AdsetNameNormalizer.toKey(parsedRow.adsetName);
    const existing = await client.metaAdset.findFirst({
      where: { platform: "META", connectionId, externalAdsetId: parsedRow.metaAdsetExternalId }
    });
    if (existing) {
      return client.metaAdset.update({
        where: { id: existing.id },
        data: {
          campaignRefId,
          adsetName: parsedRow.adsetName,
          adsetNameKey,
          firstSeenOn: existing.firstSeenOn ?? parsedRow.metricDate,
          lastSeenOn: parsedRow.metricDate
        }
      });
    }
    const legacyByName = await client.metaAdset.findFirst({
      where: { platform: "META", connectionId, externalAdsetId: null, adsetNameKey },
      orderBy: [{ lastSeenOn: "desc" }, { createdAt: "desc" }]
    });
    if (legacyByName) {
      return client.metaAdset.update({
        where: { id: legacyByName.id },
        data: {
          externalAdsetId: parsedRow.metaAdsetExternalId,
          campaignRefId,
          adsetName: parsedRow.adsetName,
          adsetNameKey,
          firstSeenOn: legacyByName.firstSeenOn ?? parsedRow.metricDate,
          lastSeenOn: parsedRow.metricDate
        }
      });
    }
    return client.metaAdset.create({
      data: {
        platform: "META",
        connectionId,
        externalAdsetId: parsedRow.metaAdsetExternalId,
        campaignRefId,
        adsetName: parsedRow.adsetName,
        adsetNameKey,
        firstSeenOn: parsedRow.metricDate,
        lastSeenOn: parsedRow.metricDate
      }
    });
  }

  async upsertCreativeFromAdDaily(
    parsedRow: ParsedMetaAdDailyRow,
    client: Prisma.TransactionClient | PrismaService = this.prisma
  ) {
    const parsedName = this.creativeNameParser.parse(parsedRow.adName);
    const creative = await this.upsertCreativeParts(parsedName, parsedRow.metricDate, client);
    return { creative, parsedName };
  }

  /** Shared name-derived canonical creative for CSV and normalized API observations. */
  async upsertCreativeParts(parsedName: CreativeNameParts, seenOn: Date,
    client: Prisma.TransactionClient | PrismaService = this.prisma) {
    const existing = await client.creative.findUnique({
      where: {
        platform_creativeKey: {
          platform: "META",
          creativeKey: parsedName.creativeKey
        }
      }
    });
    if (existing) {
      const creative = await client.creative.update({
        where: { id: existing.id },
        data: {
          ...(!existing.lastSeenOn || seenOn >= existing.lastSeenOn
            ? { displayName: parsedName.displayName,
                productName: parsedName.productName,
                materialNo: parsedName.materialNo } : {}),
          firstSeenOn: minDate(existing.firstSeenOn, seenOn),
          lastSeenOn: maxDate(existing.lastSeenOn, seenOn),
          isActive: true
        }
      });
      return creative;
    }
    const creative = await client.creative.create({
      data: {
        platform: "META",
        creativeKey: parsedName.creativeKey,
        displayName: parsedName.displayName,
        productName: parsedName.productName,
        materialNo: parsedName.materialNo,
        firstSeenOn: seenOn,
        lastSeenOn: seenOn,
        isActive: true
      }
    });
    return creative;
  }

  async upsertCreativeAlias(
    creativeId: string,
    parsedName: CreativeNameParts,
    seenOn: Date,
    client: Prisma.TransactionClient | PrismaService = this.prisma
  ) {
    const originalKey = creativeOriginalKey(parsedName.originalName);
    const existing = await client.creativeAlias.findUnique({
      where: {
        creativeId_originalKey: {
          creativeId,
          originalKey
        }
      }
    });
    const data = {
      originalName: parsedName.originalName,
      dateCode: parsedName.dateCode,
      setting: parsedName.setting,
      parseStatus: parsedName.parseStatus as CreativeParseStatus,
      lastSeenOn: seenOn
    };
    if (existing) {
      return client.creativeAlias.update({
        where: { id: existing.id },
        data: {
          ...(!existing.lastSeenOn || seenOn >= existing.lastSeenOn ? data : {}),
          firstSeenOn: minDate(existing.firstSeenOn, seenOn),
          lastSeenOn: maxDate(existing.lastSeenOn, seenOn)
        }
      });
    }
    return client.creativeAlias.create({
      data: {
        creativeId,
        originalKey,
        firstSeenOn: seenOn,
        ...data
      }
    });
  }

  async upsertCreativePlacement(input: {
    connectionId?: string | null;
    creativeId: string;
    parsedRow: ParsedMetaAdDailyRow;
    parsedName: CreativeNameParts;
    campaignRefId: string;
    metaAdsetRefId: string;
    metaAdRefId: string;
  }, client: Prisma.TransactionClient | PrismaService = this.prisma) {
    return this.upsertCreativePlacementRecord({
      connectionId: input.connectionId ?? null,
      creativeId: input.creativeId,
      campaignRefId: input.campaignRefId,
      metaAdsetRefId: input.metaAdsetRefId,
      metaAdRefId: input.metaAdRefId,
      metaCampaignId: input.parsedRow.metaCampaignId,
      metaAdsetId: input.parsedRow.metaAdsetExternalId,
      originalAdName: input.parsedRow.adName,
      campaignName: input.parsedRow.campaignName,
      adsetName: input.parsedRow.adsetName,
      setting: input.parsedName.setting,
      metricDate: input.parsedRow.metricDate,
      lastStatus: input.parsedRow.adDeliveryStatus
    }, client);
  }

  /** Placement fields are canonical, so API callers never construct a parsed CSV row. */
  async upsertCreativePlacementRecord(input: {
    connectionId: string | null; creativeId: string;
    campaignRefId: string; metaAdsetRefId: string; metaAdRefId: string;
    metaCampaignId: string; metaAdsetId: string; originalAdName: string;
    campaignName: string; adsetName: string; setting: string | null;
    metricDate: Date; lastStatus: string | null;
  }, client: Prisma.TransactionClient | PrismaService = this.prisma) {
    const existing = await client.creativePlacement.findFirst({
      where: { connectionId: input.connectionId,
        creativeId: input.creativeId,
        metaCampaignId: input.metaCampaignId,
        metaAdsetId: input.metaAdsetId,
        originalAdName: input.originalAdName }
    });
    const data = {
      campaignRefId: input.campaignRefId,
      metaAdsetRefId: input.metaAdsetRefId,
      metaAdRefId: input.metaAdRefId,
      campaignName: input.campaignName,
      adsetName: input.adsetName,
      setting: input.setting,
      lastSeenOn: input.metricDate,
      lastStatus: input.lastStatus
    };
    if (existing) {
      const isLatestObservation = !existing.lastSeenOn || input.metricDate >= existing.lastSeenOn;
      return client.creativePlacement.update({
        where: { id: existing.id },
        data: {
          ...(isLatestObservation ? data : {}),
          firstSeenOn: minDate(existing.firstSeenOn, input.metricDate),
          lastSeenOn: maxDate(existing.lastSeenOn, input.metricDate)
        }
      });
    }
    return client.creativePlacement.create({
      data: {
        connectionId: input.connectionId,
        creativeId: input.creativeId,
        metaCampaignId: input.metaCampaignId,
        metaAdsetId: input.metaAdsetId,
        originalAdName: input.originalAdName,
        firstSeenOn: input.metricDate,
        ...data
      }
    });
  }

  async upsertAd(
    parsedRow: ParsedMetaAdDailyRow,
    campaignRefId: string,
    metaAdsetRefId: string,
    creativeId: string,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
    connectionId: string | null = null
  ) {
    const existing = await client.metaAd.findFirst({
      where: {
        platform: "META", connectionId,
        metaCampaignId: parsedRow.metaCampaignId,
        metaAdsetId: parsedRow.metaAdsetExternalId,
        adIdentityKey: parsedRow.adIdentityKey
      }
    });
    if (existing) {
      return client.metaAd.update({
        where: { id: existing.id },
        data: {
          campaignRefId,
          metaAdsetRefId,
          creativeId,
          externalAdId: parsedRow.metaAdId,
          syntheticAdKey: parsedRow.syntheticAdKey,
          adName: parsedRow.adName,
          firstSeenOn: minDate(existing.firstSeenOn, parsedRow.metricDate),
          lastSeenOn: maxDate(existing.lastSeenOn, parsedRow.metricDate)
        }
      });
    }
    return client.metaAd.create({
      data: {
        platform: "META",
        connectionId,
        campaignRefId,
        metaAdsetRefId,
        creativeId,
        metaCampaignId: parsedRow.metaCampaignId,
        metaAdsetId: parsedRow.metaAdsetExternalId,
        externalAdId: parsedRow.metaAdId,
        syntheticAdKey: parsedRow.syntheticAdKey,
        adIdentityKey: parsedRow.adIdentityKey,
        adName: parsedRow.adName,
        firstSeenOn: parsedRow.metricDate,
        lastSeenOn: parsedRow.metricDate
      }
    });
  }
}
