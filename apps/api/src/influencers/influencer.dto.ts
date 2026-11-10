import { Type } from "class-transformer";
import { ArrayMaxSize, ArrayUnique, IsArray, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, ValidateIf } from "class-validator";

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

export class InfluencerDailyQuery extends InfluencerCollaborationQuery {
  @IsString()
  @Matches(DATE)
  date!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  managerName?: string;
}

export class InfluencerMaterialQuery {
  @IsOptional()
  @IsString()
  @Matches(/^\d{1,16}$/)
  number?: string;
}

export class UpdateInfluencerNumberingInput {
  @IsUUID("4")
  version!: string;

  @IsArray()
  @ArrayMaxSize(30)
  @ArrayUnique()
  @IsUUID("4", { each: true })
  creativeIds!: string[];
}

export class InfluencerCollaborationInput {
  @IsString()
  @MaxLength(100)
  @Matches(/^[^\u0000-\u001f\u007f]+$/)
  nickname!: string;

  @IsString()
  @MaxLength(100)
  @Matches(/^[^\u0000-\u001f\u007f]+$/)
  managerName!: string;

  @IsUUID("4")
  productId!: string;

  @IsInt()
  @Min(0)
  @Max(999_999_999_999)
  feeKrw!: number;

  @IsString()
  @Matches(DATE)
  startDate!: string;

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
