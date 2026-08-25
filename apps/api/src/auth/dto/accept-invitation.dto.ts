import { IsString, Matches, MaxLength, MinLength } from "class-validator";

export class AcceptInvitationDto {
  @IsString()
  @MinLength(32)
  @MaxLength(512)
  @Matches(/^[A-Za-z0-9_-]+$/)
  tokenHash!: string;
}
