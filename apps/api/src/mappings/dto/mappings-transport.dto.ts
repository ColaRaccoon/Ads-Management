import { AdStage, MatchType } from "@prisma/client";
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength
} from "class-validator";
import { IsDateOnly, IsOnOrAfter, IsOptionalUndefined, IsUuidV4 } from "../../validation/transport-validation";

export class CreateProductMappingRuleDto {
  [key: string]: unknown;

  @IsUuidV4()
  productId!: string;

  @IsEnum(MatchType)
  matchType!: MatchType;

  @IsString()
  @MinLength(1)
  @MaxLength(512)
  pattern!: string;

  @IsOptionalUndefined()
  @IsInt()
  @Min(-1_000_000)
  @Max(1_000_000)
  priority?: number;

  @IsOptionalUndefined()
  @IsBoolean()
  isActive?: boolean;

  @IsOptionalUndefined()
  @IsDateOnly()
  validFrom?: string;

  @IsOptional()
  @IsDateOnly()
  @IsOnOrAfter("validFrom")
  validTo?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  note?: string | null;
}

export class RematchMetricsDto {
  [key: string]: unknown;

  @IsOptionalUndefined()
  @IsDateOnly()
  from?: string;

  @IsOptionalUndefined()
  @IsDateOnly()
  @IsOnOrAfter("from")
  to?: string;
}

class ManualMappingTargetDto {
  [key: string]: unknown;

  @IsOptionalUndefined()
  @IsUuidV4()
  metaAdsetId?: string;

  @IsOptionalUndefined()
  @IsString()
  @MaxLength(128)
  externalAdsetId?: string;

  @IsOptionalUndefined()
  @IsString()
  @MaxLength(128)
  metaAdsetExternalId?: string;

  @IsOptionalUndefined()
  @IsString()
  @MaxLength(500)
  adsetName?: string;

  @IsDateOnly()
  effectiveFrom!: string;

  @IsOptional()
  @IsDateOnly()
  @IsOnOrAfter("effectiveFrom")
  effectiveTo?: string | null;

  @IsOptionalUndefined()
  @IsBoolean()
  applyCurrentMetrics?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  note?: string | null;
}

export class CreateManualProductMappingDto extends ManualMappingTargetDto {
  @IsUuidV4()
  productId!: string;
}

export class CreateManualStageMappingDto extends ManualMappingTargetDto {
  @IsEnum(AdStage)
  stage!: AdStage;
}
