import { Body, Controller, Delete, Get, Param, Post, Query, UploadedFile, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ConflictPolicy } from "@prisma/client";
import { CurrentUser, RequirePermissions } from "../auth/route-decorators";
import { AuthenticatedUser } from "../auth/auth.types";
import { UploadFormDto, UploadListQueryDto, UploadParamDto } from "./dto/upload-transport.dto";
import { UploadsService } from "./uploads.service";

@Controller("uploads")
export class UploadsController {
  constructor(private readonly uploadsService: UploadsService) {}

  @Post("meta-ad-daily-csv")
  @RequirePermissions("imports.manage")
  @UseInterceptors(FileInterceptor("file"))
  uploadMetaAdDailyCsv(
    @UploadedFile() file: Express.Multer.File,
    @Body() body: UploadFormDto,
    @CurrentUser() actor: AuthenticatedUser
  ) {
    return this.uploadsService.importMetaAdDailyCsv(file, body.conflictPolicy ?? ConflictPolicy.SKIP, actor.id);
  }

  @Post("meta-adset-csv")
  @RequirePermissions("imports.manage")
  @UseInterceptors(FileInterceptor("file"))
  uploadMetaAdsetCsv(
    @UploadedFile() file: Express.Multer.File,
    @Body() body: UploadFormDto,
    @CurrentUser() actor: AuthenticatedUser
  ) {
    return this.uploadsService.importMetaAdsetCsv(file, body.conflictPolicy ?? ConflictPolicy.SKIP, actor.id);
  }

  @Get()
  @RequirePermissions("data.read")
  list(@Query() query: UploadListQueryDto) {
    return this.uploadsService.listUploads(query.take ?? 50);
  }

  @Get(":id/preview")
  @RequirePermissions("data.read")
  preview(@Param() params: UploadParamDto) {
    return this.uploadsService.previewUpload(params.id);
  }

  @Get(":id/errors")
  @RequirePermissions("data.read")
  errors(@Param() params: UploadParamDto) {
    return this.uploadsService.uploadErrors(params.id);
  }

  @Delete(":id")
  @RequirePermissions("imports.manage")
  remove(@Param() params: UploadParamDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.uploadsService.deleteUpload(params.id, actor.id);
  }
}
