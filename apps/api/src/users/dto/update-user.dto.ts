import { AppRole } from "@prisma/client";
import { Transform } from "class-transformer";
import { IsBoolean, IsEnum, IsString, MaxLength, MinLength } from "class-validator";
import { IsOptionalUndefined } from "../../validation/transport-validation";

export class UpdateUserDto {
  @IsOptionalUndefined()
  @IsString()
  @Transform(({ value }) => typeof value === "string" ? value.trim() : value)
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptionalUndefined()
  @IsEnum(AppRole)
  role?: AppRole;

  @IsOptionalUndefined()
  @IsBoolean()
  isActive?: boolean;
}
