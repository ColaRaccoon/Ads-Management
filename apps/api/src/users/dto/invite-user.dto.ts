import { AppRole } from "@prisma/client";
import { Transform } from "class-transformer";
import { IsEmail, IsEnum, IsString, Matches, MaxLength, MinLength } from "class-validator";

export class InviteUserDto {
  @IsEmail()
  @Matches(/^[\x21-\x7e]+$/)
  @MaxLength(320)
  email!: string;

  @IsString()
  @Transform(({ value }) => typeof value === "string" ? value.trim() : value)
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @IsEnum(AppRole)
  role!: AppRole;
}
