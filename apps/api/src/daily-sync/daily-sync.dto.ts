import { SourceDataKind, SourceKind, SourceProvider } from "@prisma/client";
import { Type } from "class-transformer";
import { IsEnum, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from "class-validator";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

export class ConnectionInput {
  @IsEnum(SourceProvider) provider!: SourceProvider;
  @IsString() @Matches(KEY) externalAccountId!: string;
  @IsString() @Matches(KEY) shopKey!: string;
  @IsString() @MaxLength(256) displayName!: string;
  @IsString() @Matches(/^[A-Z]{3}$/) currencyCode!: string;
  @IsString() @MaxLength(128) timeZone!: string;
}

export class PolicyInput {
  @IsEnum(SourceDataKind) dataKind!: SourceDataKind;
  @IsString() @Matches(DATE) fromDate!: string;
  @IsEnum(SourceKind) primarySource!: SourceKind;
  @IsInt() @Min(0) @Max(2_147_483_647) expectedVersion!: number;
  @IsString() @Matches(/^[A-Z][A-Z0-9_]{2,63}$/) reason!: string;
}

export class GoogleVerificationInput {
  @IsString() @Matches(DATE) verificationDay!: string;
  @IsString() @Matches(/^(0|[1-9]\d{0,14})$/) observedAccountCostKrw!: string;
  @IsString() @Matches(DATE) fromDate!: string;
}
export class Cafe24ScheduledBootstrapInput {
  @IsString() @Matches(DATE) fromDate!: string;
  @IsString() @Matches(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/) expectedUpdatedAt!: string;
  @IsString() @Matches(/^[a-f0-9]{64}$/) expectedConfigurationDigest!: string;
  @IsIn(["UNKNOWN","API_ACTUAL_PRODUCT_PLUS_SHIPPING"]) couponInputSource!: "UNKNOWN"|"API_ACTUAL_PRODUCT_PLUS_SHIPPING";
  @IsIn(["ENABLE_CAFE24_SCHEDULED_API_ONLY_WITHOUT_CSV"]) acknowledgement!: string;
}
export class MetaVerificationInput {
  @IsString() @Matches(DATE) verificationDay!: string;
  @IsString() @Matches(DATE) fromDate!: string;
  @IsString() @Matches(/^(0|[1-9]\d{0,9})(\.\d{1,4})?$/) observedAccountSpendUsd!: string;
  @IsIn(["REQUIRE_VERIFIED_CONDITIONALS", "ALLOW_UNAVAILABLE_WITH_REASONS"])
  conditionalReviewDecision!: "REQUIRE_VERIFIED_CONDITIONALS" | "ALLOW_UNAVAILABLE_WITH_REASONS";
}

export class RunInput {
  @IsUUID() connectionId!: string;
  @IsString() @Matches(DATE) fromDate!: string;
  @IsString() @Matches(DATE) toDate!: string;
  @IsIn(["MANUAL", "BACKFILL"]) mode!: "MANUAL" | "BACKFILL";
  @IsString() @Matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$/) requestKey!: string;
  @IsOptional() @IsString() @Matches(/^[A-Z][A-Z0-9_]{2,63}$/) reason?: string;
}

export class MachineRunInput {
  @IsString() @Matches(/^[a-z][a-z0-9-]{2,63}$/) scheduleKey!: string;
  @IsString() @Matches(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/) scheduledFor!: string;
}

export class CoverageQuery {
  @IsUUID() connectionId!: string;
  @IsString() @Matches(DATE) from!: string;
  @IsString() @Matches(DATE) to!: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1_000) page?: number;
}

export class ConnectionListQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1_000) page?: number;
}

export class IdParam {
  @IsUUID() id!: string;
}
