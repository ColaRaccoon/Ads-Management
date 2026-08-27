import { AppRole } from "@prisma/client";
import { Transform } from "class-transformer";
import { IsEmail, IsEnum, IsString, Matches, MaxLength, MinLength, ValidateIf } from "class-validator";
import { IsOptionalUndefined } from "../../validation/transport-validation";

export class InviteUserDto {
  @ValidateIf((body: InviteUserDto) => !body.username)
  @IsOptionalUndefined()
  @IsEmail()
  @Matches(/^[\x21-\x7e]+$/)
  @MaxLength(320)
  email?: string;

  @ValidateIf((body: InviteUserDto) => !body.email)
  @IsOptionalUndefined()
  @IsString()
  @Matches(/^[A-Za-z][A-Za-z0-9._-]{2,31}$/)
  username?: string;

  @IsString()
  @Transform(({ value }) => typeof value === "string" ? value.trim() : value)
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @IsEnum(AppRole)
  role!: AppRole;
}
