import { IsString, MaxLength, MinLength } from "class-validator";

export class SetInitialPasswordDto {
  @IsString()
  @MinLength(7)
  @MaxLength(128)
  password!: string;
}
