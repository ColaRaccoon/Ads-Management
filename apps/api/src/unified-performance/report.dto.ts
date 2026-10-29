import { Type } from "class-transformer";
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from "class-validator";
import { IsDateOnly } from "../validation/transport-validation";

export class ReportQueryDto {
  @IsOptional() @IsDateOnly() from?: string;
  @IsOptional() @IsDateOnly() to?: string;
  @IsOptional() @IsDateOnly() compareFrom?: string;
  @IsOptional() @IsDateOnly() compareTo?: string;
  @IsOptional() @IsString() @MaxLength(2048) platforms?: string;
  @IsOptional() @IsString() @MaxLength(16384) scopeKeys?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(256) productName?: string;
  @IsOptional() @IsIn(["day", "week", "month"]) grain?: "day" | "week" | "month";
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
  @IsOptional() @IsString() @MaxLength(512) cursor?: string;
}
export class RebuildInputDto {
  @IsDateOnly() from!: string;
  @IsDateOnly() to!: string;
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsString({ each: true }) platforms?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) @MaxLength(256, { each: true }) scopeKeys?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsString({ each: true }) @MaxLength(256, { each: true }) productNames?: string[];
  @IsString() @MinLength(1) @MaxLength(1024) reason!: string;
  @IsString() @MaxLength(64) expectedContractVersion!: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(128) idempotencyKey?: string;
}
export class RelationshipQueryDto extends ReportQueryDto {
  @IsOptional() @IsString() @MaxLength(2048) analysisMedia?: string;
  @IsOptional() @IsDateOnly() changeDate?: string;
}
