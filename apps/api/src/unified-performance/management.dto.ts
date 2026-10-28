import { Type } from "class-transformer";
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from "class-validator";
import { IsBoundedJson, IsDateOnly, IsOnOrAfter } from "../validation/transport-validation";

export const RULE_KINDS = ["NAME", "SALE_UNIT", "ALLOCATION", "SCOPE_POLICY"] as const;
export type RuleKind = (typeof RULE_KINDS)[number];
export const CONFIG_PLATFORMS = ["META", "GOOGLE", "NAVER", "COUPANG", "CAFE24"] as const;
export class UnifiedIdParam { @IsUUID() id!: string; }
export class ConfigurationQuery {
  @IsOptional() @IsIn(RULE_KINDS) kind?: RuleKind;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;
}
export class ProductInput {
  @IsString() @MinLength(1) @MaxLength(256) canonicalName!: string;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsInt() @Min(1) expectedVersion?: number;
  @IsString() @MinLength(1) @MaxLength(1024) reason!: string;
}
export class ProductPreviewInput extends ProductInput { @IsOptional() @IsUUID() id?: string; }
export class RuleInput {
  @IsIn(RULE_KINDS) kind!: RuleKind;
  @IsOptional() @IsUUID() productId?: string | null;
  @IsOptional() @IsIn(CONFIG_PLATFORMS) platform?: (typeof CONFIG_PLATFORMS)[number] | null;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(256) scopeKey?: string | null;
  @IsObject() @IsBoundedJson({ maxDepth: 5, maxNodes: 600, maxBytes: 32768 }) payload!: Record<string, unknown>;
  @IsDateOnly() validFrom!: string;
  @IsOptional() @IsDateOnly() @IsOnOrAfter("validFrom") validTo?: string | null;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsInt() @Min(1) expectedVersion?: number;
  @IsString() @MinLength(1) @MaxLength(1024) reason!: string;
}
export class DeleteConfigurationInput {
  @IsInt() @Min(1) expectedVersion!: number;
  @IsString() @MinLength(1) @MaxLength(1024) reason!: string;
}
export class RulePreviewInput extends RuleInput {
  @IsOptional() @IsUUID() id?: string;
  // Synthetic or deliberately selected name fields only; no raw source payloads.
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsObject({ each: true })
  @IsBoundedJson({ maxDepth: 4, maxNodes: 1500, maxBytes: 131072 }) samples?: Record<string, unknown>[];
}
