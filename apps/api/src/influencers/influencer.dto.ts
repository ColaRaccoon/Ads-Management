import { Type } from "class-transformer";
import { IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, ValidateIf } from "class-validator";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class InfluencerCollaborationQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100_000)
  page?: number;
}

export class InfluencerCollaborationId {
  @IsUUID("4")
  id!: string;
}

export class InfluencerCollaborationInput {
  @IsString()
  @MaxLength(100)
  @Matches(/^[^\u0000-\u001f\u007f]+$/)
  influencerName!: string;

  @IsInt()
  @Min(0)
  @Max(999_999_999_999)
  feeKrw!: number;

  @IsString()
  @Matches(DATE)
  startDate!: string;

  @ValidateIf((_input, value) => value !== null)
  @IsString()
  @Matches(DATE)
  endDate!: string | null;

  @ValidateIf((_input, value) => value !== null)
  @IsString()
  @MaxLength(1000)
  @Matches(/^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/)
  note!: string | null;
}

export class UpdateInfluencerCollaborationInput extends InfluencerCollaborationInput {
  @IsUUID("4")
  version!: string;
}
