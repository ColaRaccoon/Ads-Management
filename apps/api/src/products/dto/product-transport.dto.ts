import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength
} from "class-validator";
import {
  IncludeInactiveQueryDto,
  IsBoundedJson,
  IsDateOnly,
  IsFiniteNumeric,
  IsOptionalUndefined,
  IsUuidV4,
  ProductIdQueryDto
} from "../../validation/transport-validation";

export class ProductListQueryDto extends IncludeInactiveQueryDto {}

export class ProductRulesQueryDto extends ProductIdQueryDto {}

export class ProductParamDto {
  @IsUuidV4()
  id!: string;
}

export class ProductRuleParamDto {
  @IsUuidV4()
  productId!: string;

  @IsUuidV4()
  ruleId!: string;
}

export class ProductIdParamDto {
  @IsUuidV4()
  productId!: string;
}

export class CreateProductDto {
  [key: string]: unknown;

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  @Matches(/^[^\u0000-\u001f\u007f]+$/)
  code!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsOptionalUndefined()
  @IsString()
  @MaxLength(200)
  displayName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  sku?: string | null;

  @IsOptionalUndefined()
  @IsInt()
  @Min(-1_000_000)
  @Max(1_000_000)
  sortOrder?: number;

  @IsOptionalUndefined()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateProductDto {
  [key: string]: unknown;

  @IsOptionalUndefined()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  @Matches(/^[^\u0000-\u001f\u007f]+$/)
  code?: string;

  @IsOptionalUndefined()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @IsOptionalUndefined()
  @IsString()
  @MaxLength(200)
  displayName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  sku?: string | null;

  @IsOptionalUndefined()
  @IsInt()
  @Min(-1_000_000)
  @Max(1_000_000)
  sortOrder?: number;

  @IsOptionalUndefined()
  @IsBoolean()
  isActive?: boolean;
}

export class ProductCostSnapshotDto {
  [key: string]: unknown;

  @IsDateOnly()
  effectiveFrom!: string;

  @IsOptionalUndefined()
  @IsFiniteNumeric({ min: 0, max: 999_999_999_999.99, maxDecimalPlaces: 2 })
  salePriceKrw?: number | string;

  @IsOptionalUndefined()
  @IsFiniteNumeric({ min: 0, max: 999_999_999_999.99, maxDecimalPlaces: 2 })
  productCostKrw?: number | string;

  @IsOptionalUndefined()
  @IsFiniteNumeric({ min: 0, max: 999_999_999_999.99, maxDecimalPlaces: 2 })
  shippingKrw?: number | string;

  @IsOptionalUndefined()
  @IsFiniteNumeric({ min: 0, max: 999_999_999_999.99, maxDecimalPlaces: 2 })
  extraCostKrw?: number | string;

  @IsOptionalUndefined()
  @IsFiniteNumeric({ min: 0.000001, max: 1_000_000, maxDecimalPlaces: 6 })
  fxRateKrwPerUsd?: number | string;

  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  note?: string | null;
}

export class CreateProductCostRuleDto extends ProductCostSnapshotDto {
  @IsUuidV4()
  productId!: string;
}

export class CorrectProductCostRuleDto {
  [key: string]: unknown;

  @IsOptionalUndefined()
  @IsDateOnly()
  effectiveFrom?: string;

  @IsOptionalUndefined()
  @IsFiniteNumeric({ min: 0, max: 999_999_999_999.99, maxDecimalPlaces: 2 })
  salePriceKrw?: number | string;

  @IsOptionalUndefined()
  @IsFiniteNumeric({ min: 0, max: 999_999_999_999.99, maxDecimalPlaces: 2 })
  productCostKrw?: number | string;

  @IsOptionalUndefined()
  @IsFiniteNumeric({ min: 0, max: 999_999_999_999.99, maxDecimalPlaces: 2 })
  shippingKrw?: number | string;

  @IsOptionalUndefined()
  @IsFiniteNumeric({ min: 0, max: 999_999_999_999.99, maxDecimalPlaces: 2 })
  extraCostKrw?: number | string;

  @IsOptionalUndefined()
  @IsFiniteNumeric({ min: 0.000001, max: 1_000_000, maxDecimalPlaces: 6 })
  fxRateKrwPerUsd?: number | string;

  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  note?: string | null;
}

export class ProductCpaSnapshotDto {
  [key: string]: unknown;

  @IsDateOnly()
  effectiveFrom!: string;

  @IsOptionalUndefined()
  @IsFiniteNumeric({ min: 0, max: 100, maxDecimalPlaces: 6 })
  targetRatio?: number | string;

  @IsOptionalUndefined()
  @IsFiniteNumeric({ min: 0, max: 100, maxDecimalPlaces: 6 })
  watchRatio?: number | string;

  @IsOptionalUndefined()
  @IsFiniteNumeric({ min: 0, max: 100, maxDecimalPlaces: 6 })
  stopRatio?: number | string;

  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  note?: string | null;
}

export class CreateProductCpaRuleDto extends ProductCpaSnapshotDto {
  @IsUuidV4()
  productId!: string;
}

export class CorrectProductCpaRuleDto {
  [key: string]: unknown;

  @IsOptionalUndefined()
  @IsDateOnly()
  effectiveFrom?: string;

  @IsOptionalUndefined()
  @IsFiniteNumeric({ min: 0, max: 100, maxDecimalPlaces: 6 })
  targetRatio?: number | string;

  @IsOptionalUndefined()
  @IsFiniteNumeric({ min: 0, max: 100, maxDecimalPlaces: 6 })
  watchRatio?: number | string;

  @IsOptionalUndefined()
  @IsFiniteNumeric({ min: 0, max: 100, maxDecimalPlaces: 6 })
  stopRatio?: number | string;

  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  note?: string | null;
}

export class SettingKeyParamDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
  key!: string;
}

export class UpdateSettingDto {
  @IsBoundedJson({ maxDepth: 6, maxNodes: 500, maxBytes: 32_768 })
  valueJson!: unknown;

  @IsOptionalUndefined()
  @IsString()
  @MaxLength(1_000)
  description?: string;
}
