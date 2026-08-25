import { SecurityAuditActorType, SecurityAuditResult } from "@prisma/client";
import { IsEnum, IsString, Matches, MaxLength } from "class-validator";
import {
  IsDateOnly,
  IsOnOrAfter,
  IsOptionalUndefined,
  IsUuidV4,
  StrictPositiveInteger
} from "../../validation/transport-validation";

export class ListSecurityAuditDto {
  @IsOptionalUndefined()
  @StrictPositiveInteger(100)
  limit = 50;

  @IsOptionalUndefined()
  @IsString()
  @MaxLength(512)
  cursor?: string;

  @IsOptionalUndefined()
  @IsString()
  @MaxLength(96)
  @Matches(/^[A-Z][A-Z0-9_]*$/)
  action?: string;

  @IsOptionalUndefined()
  @IsString()
  @MaxLength(64)
  @Matches(/^[A-Z][A-Z0-9_]*$/)
  targetType?: string;

  @IsOptionalUndefined()
  @IsEnum(SecurityAuditResult)
  result?: SecurityAuditResult;

  @IsOptionalUndefined()
  @IsEnum(SecurityAuditActorType)
  actorType?: SecurityAuditActorType;

  @IsOptionalUndefined()
  @IsUuidV4()
  actorUserId?: string;

  @IsOptionalUndefined()
  @IsDateOnly()
  from?: string;

  @IsOptionalUndefined()
  @IsDateOnly()
  @IsOnOrAfter("from")
  to?: string;
}
