import { Cafe24CouponScope } from "@prisma/client";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min
} from "class-validator";
import {
  DateRangeQueryDto,
  DateRangeTakeQueryDto,
  IncludeInactiveQueryDto,
  IsDateOnly,
  IsFiniteNumeric,
  IsOnOrAfter,
  IsOptionalUndefined,
  IsUuidV4,
  ProductIdQueryDto,
  StrictPositiveInteger,
  TakeQueryDto
} from "../../validation/transport-validation";
import { UploadFormDto } from "../../uploads/dto/upload-transport.dto";

export class Cafe24UploadFormDto extends UploadFormDto {}
export class Cafe24UploadListQueryDto extends TakeQueryDto {}

export class Cafe24UploadPreviewQueryDto {
  @IsOptionalUndefined()
  @StrictPositiveInteger(500)
  take?: number;
}

export class Cafe24ParamDto {
  @IsUuidV4()
  id!: string;
}

export class Cafe24RematchQueryDto extends DateRangeTakeQueryDto {}

export class Cafe24RulesQueryDto extends ProductIdQueryDto {
  @IsOptionalUndefined()
  @Matches(/^(true|false)$/)
  includeInactive?: string;
}

export class Cafe24RuleDto {
  [key: string]: unknown;

  @IsOptionalUndefined()
  @IsUuidV4()
  productId?: string;

  @IsOptionalUndefined()
  @IsString()
  @MaxLength(200)
  displayName?: string;

  @IsOptionalUndefined()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  productNumbers?: string[];

  @IsOptionalUndefined()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  productNameAliases?: string[];

  @IsOptionalUndefined()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  optionIncludeKeywords?: string[];

  @IsOptionalUndefined()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  optionExcludeKeywords?: string[];

  @IsOptional()
  @IsUuidV4()
  adCostSourceProductId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  roasGroup?: string | null;

  @IsOptional()
  @IsFiniteNumeric({ min: 0, max: 999_999_999_999.99, maxDecimalPlaces: 2 })
  salePriceKrwOverride?: number | string | null;

  @IsOptional()
  @IsFiniteNumeric({ min: 0, max: 999_999_999_999.99, maxDecimalPlaces: 2 })
  productCostKrwOverride?: number | string | null;

  @IsOptional()
  @IsFiniteNumeric({ min: 0, max: 999_999_999_999.99, maxDecimalPlaces: 2 })
  shippingKrwOverride?: number | string | null;

  @IsOptional()
  @IsFiniteNumeric({ min: 0, max: 999_999_999_999.99, maxDecimalPlaces: 2 })
  extraCostKrwOverride?: number | string | null;

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

export class CouponRulesQueryDto extends IncludeInactiveQueryDto {
  @IsOptionalUndefined()
  @IsUuidV4()
  productId?: string;

  @IsOptionalUndefined()
  @IsEnum(Cafe24CouponScope)
  scope?: Cafe24CouponScope;
}

export class Cafe24CouponRuleDto {
  [key: string]: unknown;

  @IsOptionalUndefined()
  @IsString()
  @MaxLength(200)
  name?: string;

  @IsOptionalUndefined()
  @IsEnum(Cafe24CouponScope)
  scope?: Cafe24CouponScope;

  @IsOptional()
  @IsUuidV4()
  productId?: string | null;

  @IsOptionalUndefined()
  @IsFiniteNumeric({ min: 1, max: 999_999_999_999.99, maxDecimalPlaces: 2 })
  discountKrw?: number | string;

  @IsOptionalUndefined()
  @IsInt()
  @Min(-1_000_000)
  @Max(1_000_000)
  priority?: number;

  @IsOptionalUndefined()
  @IsDateOnly()
  validFrom?: string;

  @IsOptional()
  @IsDateOnly()
  @IsOnOrAfter("validFrom")
  validTo?: string | null;

  @IsOptionalUndefined()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  note?: string | null;
}

export class ProductPerformanceQueryDto extends DateRangeQueryDto {
  @IsOptionalUndefined()
  @Matches(/^(active|inactive|all)$/i)
  deliveryStatus?: string;
}

export class CouponMatchesQueryDto extends DateRangeQueryDto {
  @IsOptionalUndefined()
  @Matches(/^(EXACT|ESTIMATED|UNMATCHED)$/i)
  status?: string;
}

export class Cafe24UnmatchedQueryDto extends DateRangeQueryDto {
  @IsOptionalUndefined()
  @StrictPositiveInteger(500)
  take?: number;
}
