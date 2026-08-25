import { Type } from "class-transformer";
import { IsIn, Matches, ValidateNested } from "class-validator";
import { IsOptionalUndefined, RequiredDateRangeDto } from "../../validation/transport-validation";

export class DecisionFiltersDto {
  [key: string]: unknown;

  @IsOptionalUndefined()
  @Matches(/^(active|inactive|all)$/i)
  deliveryStatus?: string;
}

export class RunDecisionDto extends RequiredDateRangeDto {
  @IsOptionalUndefined()
  @IsIn(["previousDay", "previousSamePeriod"])
  compareType?: string;

  @IsOptionalUndefined()
  @ValidateNested()
  @Type(() => DecisionFiltersDto)
  filters?: DecisionFiltersDto;
}
