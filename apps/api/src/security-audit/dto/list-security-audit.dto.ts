import { Transform } from "class-transformer";
import { SecurityAuditActorType, SecurityAuditResult } from "@prisma/client";
import { IsDateString, IsEnum, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from "class-validator";

export class ListSecurityAuditDto {
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 50;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;

  @IsOptional()
  @IsString()
  @MaxLength(96)
  @Matches(/^[A-Z][A-Z0-9_]*$/)
  action?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(/^[A-Z][A-Z0-9_]*$/)
  targetType?: string;

  @IsOptional()
  @IsEnum(SecurityAuditResult)
  result?: SecurityAuditResult;

  @IsOptional()
  @IsEnum(SecurityAuditActorType)
  actorType?: SecurityAuditActorType;

  @IsOptional()
  @IsUUID()
  actorUserId?: string;

  @IsOptional()
  @IsDateString({ strict: true })
  from?: string;

  @IsOptional()
  @IsDateString({ strict: true })
  to?: string;
}
