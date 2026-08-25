import { AppRole } from "@prisma/client";
import { Transform } from "class-transformer";
import { IsBoolean, IsEnum, IsOptional, IsString, MaxLength, MinLength } from "class-validator";

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  @Transform(({ value }) => typeof value === "string" ? value.trim() : value)
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsEnum(AppRole)
  role?: AppRole;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
