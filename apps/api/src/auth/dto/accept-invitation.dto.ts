import { IsIn, IsString, Matches, MaxLength, MinLength } from "class-validator";
import { IsOptionalUndefined } from "../../validation/transport-validation";

export class AcceptInvitationDto {
  @IsString()
  @MinLength(32)
  @MaxLength(512)
  @Matches(/^[A-Za-z0-9_-]+$/)
  tokenHash!: string;

  @IsOptionalUndefined()
  @IsIn(["invite", "recovery"])
  tokenType?: "invite" | "recovery";
}
