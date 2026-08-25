import { ConflictPolicy } from "@prisma/client";
import { IsEnum } from "class-validator";
import { IsOptionalUndefined, IsUuidV4, TakeQueryDto } from "../../validation/transport-validation";

export class UploadFormDto {
  @IsOptionalUndefined()
  @IsEnum(ConflictPolicy)
  conflictPolicy?: ConflictPolicy;
}

export class UploadListQueryDto extends TakeQueryDto {}

export class UploadParamDto {
  @IsUuidV4()
  id!: string;
}
