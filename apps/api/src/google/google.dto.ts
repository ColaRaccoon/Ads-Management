import { Type } from "class-transformer";
import { IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from "class-validator";

export class GoogleQuery {
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) from?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) to?: string;
  @IsOptional() @IsUUID() connectionId?: string;
  @IsOptional() @IsUUID() cafe24ConnectionId?: string;
  @IsOptional() @IsUUID() productId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100000) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;
}

export class GoogleMappingInput {
  @IsOptional() @IsUUID() id?: string;
  @IsIn(["CAMPAIGN", "SALE"]) kind!: "CAMPAIGN" | "SALE";
  @IsUUID() connectionId!: string;
  @IsOptional() @IsString() @MaxLength(256) campaignId?: string;
  @IsOptional() @IsString() @MaxLength(256) productNo?: string;
  @IsOptional() @IsString() @MaxLength(1024) optionName?: string;
  @IsOptional() @IsIn(["EXACT", "PRODUCT"]) optionScope?: "EXACT" | "PRODUCT";
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(999999999999.99) salePriceKrwOverride?: number | null;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(999999999999.99) productCostKrwOverride?: number | null;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(999999999999.99) shippingKrwOverride?: number | null;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(999999999999.99) extraCostKrwOverride?: number | null;
  @IsOptional() @IsString() @MaxLength(64) saleUnitLabel?: string | null;
  @IsOptional() @IsUUID() productId!: string | null;
  @Matches(/^\d{4}-\d{2}-\d{2}$/) startDate!: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) endDate?: string | null;
  @IsOptional() @Matches(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/) expectedUpdatedAt?: string;
}
