import { ReportType } from "@prisma/client";
import { IsEnum } from "class-validator";
import {
  IsBoundedJson,
  IsPlainRecord,
  IsOptionalUndefined,
  IsUuidV4,
  RequiredDateRangeDto
} from "../../validation/transport-validation";

export class ExportReportDto extends RequiredDateRangeDto {
  @IsOptionalUndefined()
  @IsEnum(ReportType)
  reportType?: ReportType;

  @IsOptionalUndefined()
  @IsPlainRecord()
  @IsBoundedJson({ maxDepth: 6, maxNodes: 500, maxBytes: 32_768 })
  parameters?: Record<string, unknown>;
}

export class ReportParamDto {
  @IsUuidV4()
  id!: string;
}
