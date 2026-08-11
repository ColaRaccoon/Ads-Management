import { Injectable } from "@nestjs/common";
import { CreativeParseStatus } from "@prisma/client";
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

  async upsertAdset(parsedRow: ParsedMetaAdsetRow) {
    const existingCandidates = await this.prisma.metaAdset.findMany({
      where: { platform: "META", adsetNameKey: parsedRow.adsetNameKey },
      orderBy: [{ lastSeenOn: "desc" }, { createdAt: "desc" }]
    });
    const existing = existingCandidates.find((candidate) => candidate.externalAdsetId) ?? existingCandidates[0] ?? null;
    if (existing) {
      return this.prisma.metaAdset.update({
        where: { id: existing.id },
        data: {
          adsetName: parsedRow.adsetName,
          firstSeenOn: existing.firstSeenOn ?? parsedRow.metricDate,
          lastSeenOn: parsedRow.metricDate
        }
      });
    }
    return this.prisma.metaAdset.create({
      data: {
        platform: "META",
        adsetName: parsedRow.adsetName,
        adsetNameKey: parsedRow.adsetNameKey,
        firstSeenOn: parsedRow.metricDate,
        lastSeenOn: parsedRow.metricDate
      }
    });
  }

  async upsertCampaign(parsedRow: ParsedMetaAdDailyRow) {
    const existing = await this.prisma.metaCampaign.findUnique({
      where: {
        platform_externalCampaignId: {
          platform: "META",
          externalCampaignId: parsedRow.metaCampaignId
        }
      }
    });
    if (existing) {
      return this.prisma.metaCampaign.update({
        where: { id: existing.id },
        data: {
          campaignName: parsedRow.campaignName,
          firstSeenOn: existing.firstSeenOn ?? parsedRow.metricDate,
          lastSeenOn: parsedRow.metricDate
        }
      });
    }
    return this.prisma.metaCampaign.create({
      data: {
        platform: "META",
        externalCampaignId: parsedRow.metaCampaignId,
        campaignName: parsedRow.campaignName,
        firstSeenOn: parsedRow.metricDate,
        lastSeenOn: parsedRow.metricDate
      }
    });
  }

  async upsertAdsetFromAdDaily(parsedRow: ParsedMetaAdDailyRow, campaignRefId: string) {
    const adsetNameKey = AdsetNameNormalizer.toKey(parsedRow.adsetName);
    const existing = await this.prisma.metaAdset.findFirst({
      where: { platform: "META", externalAdsetId: parsedRow.metaAdsetExternalId }
    });
    if (existing) {
      return this.prisma.metaAdset.update({
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
    const legacyByName = await this.prisma.metaAdset.findFirst({
      where: { platform: "META", externalAdsetId: null, adsetNameKey },
      orderBy: [{ lastSeenOn: "desc" }, { createdAt: "desc" }]
    });
    if (legacyByName) {
      return this.prisma.metaAdset.update({
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
    return this.prisma.metaAdset.create({
      data: {
        platform: "META",
        externalAdsetId: parsedRow.metaAdsetExternalId,
        campaignRefId,
        adsetName: parsedRow.adsetName,
        adsetNameKey,
        firstSeenOn: parsedRow.metricDate,
        lastSeenOn: parsedRow.metricDate
      }
    });
  }

  async upsertCreativeFromAdDaily(parsedRow: ParsedMetaAdDailyRow) {
    const parsedName = this.creativeNameParser.parse(parsedRow.adName);
    const existing = await this.prisma.creative.findUnique({
      where: {
        platform_creativeKey: {
          platform: "META",
          creativeKey: parsedName.creativeKey
        }
      }
    });
    if (existing) {
      const creative = await this.prisma.creative.update({
        where: { id: existing.id },
        data: {
          displayName: parsedName.displayName,
          productName: parsedName.productName,
          materialNo: parsedName.materialNo,
          firstSeenOn: minDate(existing.firstSeenOn, parsedRow.metricDate),
          lastSeenOn: maxDate(existing.lastSeenOn, parsedRow.metricDate),
          isActive: true
        }
      });
      return { creative, parsedName };
    }
    const creative = await this.prisma.creative.create({
      data: {
        platform: "META",
        creativeKey: parsedName.creativeKey,
        displayName: parsedName.displayName,
        productName: parsedName.productName,
        materialNo: parsedName.materialNo,
        firstSeenOn: parsedRow.metricDate,
        lastSeenOn: parsedRow.metricDate,
        isActive: true
      }
    });
    return { creative, parsedName };
  }

  async upsertCreativeAlias(creativeId: string, parsedName: CreativeNameParts, seenOn: Date) {
    const originalKey = creativeOriginalKey(parsedName.originalName);
    const existing = await this.prisma.creativeAlias.findUnique({
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
      return this.prisma.creativeAlias.update({
        where: { id: existing.id },
        data: {
          ...data,
          firstSeenOn: minDate(existing.firstSeenOn, seenOn),
          lastSeenOn: maxDate(existing.lastSeenOn, seenOn)
        }
      });
    }
    return this.prisma.creativeAlias.create({
      data: {
        creativeId,
        originalKey,
        firstSeenOn: seenOn,
        ...data
      }
    });
  }

  async upsertCreativePlacement(input: {
    creativeId: string;
    parsedRow: ParsedMetaAdDailyRow;
    parsedName: CreativeNameParts;
    campaignRefId: string;
    metaAdsetRefId: string;
    metaAdRefId: string;
  }) {
    const existing = await this.prisma.creativePlacement.findUnique({
      where: {
        creativeId_metaCampaignId_metaAdsetId_originalAdName: {
          creativeId: input.creativeId,
          metaCampaignId: input.parsedRow.metaCampaignId,
          metaAdsetId: input.parsedRow.metaAdsetExternalId,
          originalAdName: input.parsedRow.adName
        }
      }
    });
    const data = {
      campaignRefId: input.campaignRefId,
      metaAdsetRefId: input.metaAdsetRefId,
      metaAdRefId: input.metaAdRefId,
      campaignName: input.parsedRow.campaignName,
      adsetName: input.parsedRow.adsetName,
      setting: input.parsedName.setting,
      lastSeenOn: input.parsedRow.metricDate,
      lastStatus: input.parsedRow.adDeliveryStatus
    };
    if (existing) {
      const isLatestObservation = !existing.lastSeenOn || input.parsedRow.metricDate >= existing.lastSeenOn;
      return this.prisma.creativePlacement.update({
        where: { id: existing.id },
        data: {
          ...(isLatestObservation ? data : {}),
          firstSeenOn: minDate(existing.firstSeenOn, input.parsedRow.metricDate),
          lastSeenOn: maxDate(existing.lastSeenOn, input.parsedRow.metricDate)
        }
      });
    }
    return this.prisma.creativePlacement.create({
      data: {
        creativeId: input.creativeId,
        metaCampaignId: input.parsedRow.metaCampaignId,
        metaAdsetId: input.parsedRow.metaAdsetExternalId,
        originalAdName: input.parsedRow.adName,
        firstSeenOn: input.parsedRow.metricDate,
        ...data
      }
    });
  }

  async upsertAd(parsedRow: ParsedMetaAdDailyRow, campaignRefId: string, metaAdsetRefId: string, creativeId: string) {
    const existing = await this.prisma.metaAd.findUnique({
      where: {
        platform_metaCampaignId_metaAdsetId_adIdentityKey: {
          platform: "META",
          metaCampaignId: parsedRow.metaCampaignId,
          metaAdsetId: parsedRow.metaAdsetExternalId,
          adIdentityKey: parsedRow.adIdentityKey
        }
      }
    });
    if (existing) {
      return this.prisma.metaAd.update({
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
    return this.prisma.metaAd.create({
      data: {
        platform: "META",
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
