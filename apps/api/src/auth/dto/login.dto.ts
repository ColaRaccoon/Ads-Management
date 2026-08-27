import { IsEmail, IsString, Matches, MaxLength, MinLength, ValidateIf } from "class-validator";
import { IsOptionalUndefined } from "../../validation/transport-validation";

export class LoginDto {
  @ValidateIf((body: LoginDto) => !body.username)
  @IsOptionalUndefined()
  @IsEmail()
  @MaxLength(320)
  email?: string;

  @ValidateIf((body: LoginDto) => !body.email)
  @IsOptionalUndefined()
  @IsString()
  @Matches(/^[A-Za-z][A-Za-z0-9._-]{2,31}$/)
  username?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(1024)
  password!: string;
}
