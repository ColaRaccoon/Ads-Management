import { Type } from "class-transformer";
import { ConflictPolicy } from "@prisma/client";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested
} from "class-validator";
import {
  DateQueryDto,
  DateRangeQueryDto,
  DateRangeTakeQueryDto,
  IncludeInactiveQueryDto,
  IsDateOnly,
  IsFiniteNumeric,
  IsOptionalUndefined,
  IsUuidV4,
  StrictPositiveInteger,
  TakeQueryDto
} from "../../validation/transport-validation";

const CSV_UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?:,[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})*$/i;

export class CoupangUploadFormDto {
  [key: string]: unknown;

  @IsOptionalUndefined()
  @IsEnum(ConflictPolicy)
  conflictPolicy?: ConflictPolicy;
}

export class CoupangSalesUploadFormDto extends CoupangUploadFormDto {
  @IsOptionalUndefined()
  @IsDateOnly()
  reportDate?: string;

  @IsOptionalUndefined()
  @IsIn(["SALES_IS_NET", "NEGATIVE_ADD", "POSITIVE_SUBTRACT"])
  cancelAmountMode?: string;
}

export class CoupangMarginUploadFormDto extends CoupangUploadFormDto {
  @IsOptionalUndefined()
  @IsDateOnly()
  effectiveFrom?: string;
}

export class CoupangBundleUploadFormDto extends CoupangSalesUploadFormDto {
  @IsOptionalUndefined()
  @IsDateOnly()
  effectiveFrom?: string;
}

export class CoupangUploadListQueryDto extends TakeQueryDto {}

export class CoupangUploadPreviewQueryDto {
  @IsOptionalUndefined()
  @StrictPositiveInteger(500)
  take?: number;
}

export class CoupangIdParamDto {
  @IsUuidV4()
  id!: string;
}

export class CoupangProductCostParamDto {
  @IsUuidV4()
  productId!: string;

  @IsUuidV4()
  costRuleId!: string;
}

export class CoupangProductSettingsQueryDto extends IncludeInactiveQueryDto {
  @IsOptionalUndefined()
  @IsDateOnly()
  date?: string;
}

export class CoupangIncludeInactiveQueryDto extends IncludeInactiveQueryDto {}

class CoupangCostFieldsDto {
  [key: string]: unknown;

  @IsOptionalUndefined()
  @IsFiniteNumeric({ min: 0, max: 999_999_999_999.99, maxDecimalPlaces: 2 })
  salePriceKrw?: number | string;

  @IsOptionalUndefined()
  @IsFiniteNumeric({ min: 0, max: 999_999_999_999.99, maxDecimalPlaces: 2 })
  supplyPriceKrw?: number | string;

  @IsOptionalUndefined()
  @IsFiniteNumeric({ min: 0, max: 999_999_999_999.99, maxDecimalPlaces: 2 })
  productCostKrw?: number | string;

  @IsOptional()
  @IsFiniteNumeric({ min: 0, max: 999_999_999_999.99, maxDecimalPlaces: 2 })
  sellerShippingFeeKrw?: number | string | null;

  @IsOptional()
  @IsFiniteNumeric({ min: 0, max: 999_999_999_999.99, maxDecimalPlaces: 2 })
  hanaroShippingFeeKrw?: number | string | null;

  @IsOptionalUndefined()
  @IsFiniteNumeric({ min: 0, max: 999_999_999_999.99, maxDecimalPlaces: 2 })
  growthInboundFeeKrw?: number | string;

  @IsOptionalUndefined()
  @IsFiniteNumeric({ min: 0, max: 999_999_999_999.99, maxDecimalPlaces: 2 })
  growthShippingFeeKrw?: number | string;

  @IsOptionalUndefined()
  @IsFiniteNumeric({ min: 0, max: 1, maxDecimalPlaces: 6 })
  returnRate?: number | string;

  @IsOptionalUndefined()
  @IsFiniteNumeric({ min: 0, max: 999_999_999_999.99, maxDecimalPlaces: 2 })
  returnCostPerUnitKrw?: number | string;

  @IsOptionalUndefined()
  @IsFiniteNumeric({ min: 0, max: 999_999_999_999.99, maxDecimalPlaces: 2 })
  extraCostKrw?: number | string;

  @IsOptionalUndefined()
  @IsDateOnly()
  effectiveFrom?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  note?: string | null;
}

export class CoupangCreateProductSettingDto extends CoupangCostFieldsDto {
  @IsOptionalUndefined()
  @IsString()
  @MaxLength(200)
  displayName?: string;

  @IsOptionalUndefined()
  @IsString()
  @MaxLength(200)
  standardName?: string;

  @IsOptional()
  @IsUuidV4()
  groupId?: string | null;

  @IsOptionalUndefined()
  @IsInt()
  @Min(-1_000_000)
  @Max(1_000_000)
  sortOrder?: number;

  @IsOptionalUndefined()
  @IsBoolean()
  isActive?: boolean;
}

export class CoupangProductSettingDto extends CoupangCreateProductSettingDto {
  @IsOptionalUndefined()
  @IsUuidV4()
  mappingRuleId?: string;

  @IsOptionalUndefined()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  includeKeywords?: string[];

  @IsOptionalUndefined()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  excludeKeywords?: string[];

  @IsOptionalUndefined()
  @IsInt()
  @Min(-1_000_000)
  @Max(1_000_000)
  priority?: number;
}

export class CoupangCostRuleCorrectionDto extends CoupangCostFieldsDto {
  @IsOptionalUndefined()
  @IsFiniteNumeric({ min: 0, max: 1, maxDecimalPlaces: 6 })
  salesFeeRate?: number | string;

  @IsOptionalUndefined()
  @IsFiniteNumeric({ min: 0, max: 999_999_999_999.99, maxDecimalPlaces: 2 })
  salesFeeKrw?: number | string;
}

export class CoupangSalesFeeRuleDto {
  [key: string]: unknown;

  @IsOptionalUndefined()
  @IsFiniteNumeric({ min: 0, max: 100, maxDecimalPlaces: 6 })
  salesFeePercent?: number | string;

  @IsOptionalUndefined()
  @IsDateOnly()
  effectiveFrom?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  note?: string | null;
}

export class CoupangProductGroupDto {
  [key: string]: unknown;

  @IsOptionalUndefined()
  @IsString()
  @MaxLength(200)
  displayName?: string;

  @IsOptionalUndefined()
  @IsString()
  @MaxLength(200)
  standardName?: string;

  @IsOptionalUndefined()
  @IsInt()
  @Min(-1_000_000)
  @Max(1_000_000)
  sortOrder?: number;

  @IsOptionalUndefined()
  @IsBoolean()
  isActive?: boolean;
}

export class CoupangMappingRuleDto {
  [key: string]: unknown;

  @IsOptionalUndefined()
  @IsUuidV4()
  coupangProductId?: string;

  @IsOptionalUndefined()
  @IsUuidV4()
  productId?: string;

  @IsOptionalUndefined()
  @IsString()
  @MaxLength(200)
  displayName?: string;

  @IsOptionalUndefined()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  includeKeywords?: string[];

  @IsOptionalUndefined()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  excludeKeywords?: string[];

  @IsOptionalUndefined()
  @IsInt()
  @Min(-1_000_000)
  @Max(1_000_000)
  priority?: number;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  saleMethod?: string | null;

  @IsOptionalUndefined()
  @IsBoolean()
  adEnabled?: boolean;

  @IsOptionalUndefined()
  @IsBoolean()
  isActive?: boolean;

  @IsOptionalUndefined()
  @IsDateOnly()
  validFrom?: string;

  @IsOptional()
  @IsDateOnly()
  validTo?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  note?: string | null;
}

export class CoupangManualPurchaseOptionsQueryDto extends DateQueryDto {}
export class CoupangManualPurchasesQueryDto extends DateRangeQueryDto {}

export class CoupangManualPurchaseDateParamDto {
  @IsDateOnly()
  date!: string;
}

export class CoupangManualPurchaseEntryDto {
  @IsUuidV4()
  coupangProductId!: string;

  @IsOptional()
  @IsUuidV4()
  coupangProductRuleId?: string | null;

  @IsInt()
  @Min(0)
  @Max(2_147_483_647)
  quantity!: number;

  @IsOptionalUndefined()
  @IsString()
  @MaxLength(2_000)
  memo?: string;
}

export class CoupangManualPurchasesBodyDto {
  [key: string]: unknown;

  @IsArray()
  @ArrayMaxSize(5_000)
  @ValidateNested({ each: true })
  @Type(() => CoupangManualPurchaseEntryDto)
  entries!: CoupangManualPurchaseEntryDto[];

  @IsOptionalUndefined()
  @IsFiniteNumeric({ min: 0, max: 999_999_999_999.99, maxDecimalPlaces: 2 })
  vendorFeePerUnitKrw?: number | string;
}

export class CoupangRematchQueryDto extends DateRangeTakeQueryDto {}

export class CoupangGroupQueryDto extends DateRangeQueryDto {
  @IsOptionalUndefined()
  @IsIn(["product", "group"])
  groupBy?: string;
}

export class CoupangUnmatchedQueryDto extends DateRangeQueryDto {
  @IsOptionalUndefined()
  @StrictPositiveInteger(2_000)
  take?: number;
}

export class CoupangDailyReportQueryDto extends DateRangeQueryDto {
  @IsOptionalUndefined()
  @IsDateOnly()
  date?: string;

  @IsOptionalUndefined()
  @IsString()
  @MaxLength(4_000)
  @Matches(CSV_UUID_V4_PATTERN)
  categoryIds?: string;

  @IsOptionalUndefined()
  @Matches(/^(true|false)$/)
  includeUncategorized?: string;

  @IsOptionalUndefined()
  @IsString()
  @MaxLength(200)
  q?: string;
}

class CoupangDailyReportCategoryMetadataDto {
  [key: string]: unknown;

  @IsOptionalUndefined()
  @IsString()
  @MaxLength(80)
  displayName?: string;

  @IsOptionalUndefined()
  @IsInt()
  @Min(-1_000_000)
  @Max(1_000_000)
  sortOrder?: number;

}

export class CreateCoupangDailyReportCategoryDto extends CoupangDailyReportCategoryMetadataDto {
  @IsOptionalUndefined()
  @IsArray()
  @ArrayMaxSize(5_000)
  @IsUuidV4({ each: true })
  productIds?: string[];
}

export class UpdateCoupangDailyReportCategoryDto extends CoupangDailyReportCategoryMetadataDto {
  @IsOptionalUndefined()
  @IsBoolean()
  isActive?: boolean;
}

export class ReplaceCoupangDailyReportCategoryProductsDto extends CreateCoupangDailyReportCategoryDto {
  @IsISO8601({ strict: true })
  expectedUpdatedAt!: string;
}
