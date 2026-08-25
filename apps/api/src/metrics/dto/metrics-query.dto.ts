import { AdStage, DecisionType } from "@prisma/client";
import { IsEnum, IsIn, IsString, Matches, MaxLength } from "class-validator";
import { DateRangeQueryDto, IsOptionalUndefined, IsUuidV4 } from "../../validation/transport-validation";

const DELIVERY_STATUS_PATTERN = /^(active|inactive|all)$/i;
const META_IDENTIFIER_PATTERN = /^[A-Za-z0-9_.:-]{1,200}$/;

export class MetricDateRangeQueryDto extends DateRangeQueryDto {
  @IsOptionalUndefined()
  @Matches(DELIVERY_STATUS_PATTERN)
  deliveryStatus?: string;
}

export class DashboardSummaryQueryDto extends MetricDateRangeQueryDto {
  @IsOptionalUndefined()
  @IsIn(["previousDay", "previousSamePeriod"])
  compare?: string;
}

export class DashboardTrendsQueryDto extends MetricDateRangeQueryDto {
  @IsOptionalUndefined()
  @IsIn(["date", "stage", "product"])
  groupBy?: string;
}

export class CampaignMetricsQueryDto extends MetricDateRangeQueryDto {
  @IsOptionalUndefined()
  @IsUuidV4()
  productId?: string;

  @IsOptionalUndefined()
  @IsEnum(AdStage)
  stage?: AdStage;
}

export class AdsetMetricsQueryDto extends CampaignMetricsQueryDto {
  @IsOptionalUndefined()
  @Matches(META_IDENTIFIER_PATTERN)
  campaignId?: string;

  @IsOptionalUndefined()
  @IsEnum(DecisionType)
  decision?: DecisionType;
}

export class AdMetricsQueryDto extends CampaignMetricsQueryDto {
  @IsOptionalUndefined()
  @Matches(META_IDENTIFIER_PATTERN)
  campaignId?: string;

  @IsOptionalUndefined()
  @Matches(META_IDENTIFIER_PATTERN)
  adsetId?: string;
}

export class CreativeMetricsQueryDto extends AdMetricsQueryDto {
  @IsOptionalUndefined()
  @IsString()
  @MaxLength(200)
  q?: string;
}

export class CreativeVideoTrendsQueryDto extends MetricDateRangeQueryDto {
  @IsOptionalUndefined()
  @IsUuidV4()
  productId?: string;
}

export class CompareAdsQueryDto extends MetricDateRangeQueryDto {
  @IsString()
  @MaxLength(500)
  adName!: string;
}

export class MetaAdsetParamDto {
  @Matches(META_IDENTIFIER_PATTERN)
  metaAdsetId!: string;
}

export class MetaCampaignParamDto {
  @Matches(META_IDENTIFIER_PATTERN)
  metaCampaignId!: string;
}
