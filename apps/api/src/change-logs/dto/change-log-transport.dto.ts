import { AdStage, CreativeLogActionType } from "@prisma/client";
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength
} from "class-validator";
import {
  DateQueryDto,
  DateRangeQueryDto,
  IsBoundedJson,
  IsDateOnly,
  IsOptionalUndefined,
  IsUuidV4
} from "../../validation/transport-validation";

const CHANGE_ACTION_TYPES = ["TURN_OFF", "BUDGET_CHANGE", "PROMOTE_STAGE", "DEMOTE_STAGE", "CREATIVE_EXCLUDE", "NOTE"] as const;
const CHANGE_TARGET_TYPES = ["PRODUCT", "ADSET", "STAGE"] as const;

export class ChangeLogRangeQueryDto extends DateRangeQueryDto {}
export class ChangeLogDateQueryDto extends DateQueryDto {}

export class CreativeParamDto {
  @IsUuidV4()
  creativeId!: string;
}

export class ProductChangeLogParamDto {
  @IsUuidV4()
  productId!: string;
}

export class CreateChangeLogDto {
  [key: string]: unknown;

  @IsOptionalUndefined()
  @IsDateOnly()
  actionDate?: string;

  @IsIn(CHANGE_ACTION_TYPES)
  actionType!: typeof CHANGE_ACTION_TYPES[number];

  @IsIn(CHANGE_TARGET_TYPES)
  targetType!: typeof CHANGE_TARGET_TYPES[number];

  @IsOptionalUndefined()
  @IsUuidV4()
  productId?: string;

  @IsOptionalUndefined()
  @IsUuidV4()
  metaAdsetId?: string;

  @IsOptional()
  @IsEnum(AdStage)
  stageFrom?: AdStage | null;

  @IsOptional()
  @IsEnum(AdStage)
  stageTo?: AdStage | null;

  @IsOptional()
  @IsBoundedJson({ maxDepth: 6, maxNodes: 500, maxBytes: 32_768 })
  previousValue?: unknown | null;

  @IsOptional()
  @IsBoundedJson({ maxDepth: 6, maxNodes: 500, maxBytes: 32_768 })
  newValue?: unknown | null;

  @IsString()
  @MinLength(1)
  @MaxLength(4_000)
  reason!: string;

  @IsOptionalUndefined()
  @IsUuidV4()
  relatedDecisionId?: string;

  @IsOptional()
  @IsDateOnly()
  nextCheckDate?: string | null;
}

export class CreateCreativeChangeLogDto {
  [key: string]: unknown;

  @IsOptionalUndefined()
  @IsDateOnly()
  actionDate?: string;

  @IsOptionalUndefined()
  @IsEnum(CreativeLogActionType)
  actionType?: CreativeLogActionType;

  @IsString()
  @MinLength(1)
  @MaxLength(4_000)
  reason!: string;

  @IsOptional()
  @IsString()
  @MaxLength(4_000)
  memo?: string | null;

  @IsOptionalUndefined()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(128, { each: true })
  relatedAdsetIds?: string[];

  @IsOptional()
  @IsDateOnly()
  nextCheckDate?: string | null;
}

export class CreateProductChangeLogDto {
  [key: string]: unknown;

  @IsOptionalUndefined()
  @IsDateOnly()
  actionDate?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(4_000)
  text!: string;
}
