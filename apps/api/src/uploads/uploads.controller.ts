import { Body, Controller, Delete, Get, Param, Post, Query, UploadedFile, UseInterceptors } from "@nestjs/common";
import { ConflictPolicy } from "@prisma/client";
import { CurrentUser, RequirePermissions } from "../auth/route-decorators";
import { AuthenticatedUser } from "../auth/auth.types";
import { SecureUploadPipe } from "../file-security/secure-upload.pipe";
import { UPLOAD_PROFILES, uploadFileInterceptor } from "../file-security/upload-profiles";
import { UploadFormDto, UploadListQueryDto, UploadParamDto } from "./dto/upload-transport.dto";
import { UploadsService } from "./uploads.service";
import { HeavyOperation } from "../common/heavy-operation";

@Controller("uploads")
export class UploadsController {
  constructor(private readonly uploadsService: UploadsService) {}

  @Post("meta-ad-daily-csv")
  @HeavyOperation()
  @RequirePermissions("imports.manage")
  @UseInterceptors(uploadFileInterceptor(UPLOAD_PROFILES.META_CSV))
  uploadMetaAdDailyCsv(
    @UploadedFile(new SecureUploadPipe(UPLOAD_PROFILES.META_CSV)) file: Express.Multer.File,
    @Body() body: UploadFormDto,
    @CurrentUser() actor: AuthenticatedUser
  ) {
    return this.uploadsService.importMetaAdDailyCsv(file, body.conflictPolicy ?? ConflictPolicy.SKIP, actor.id);
  }

  @Post("meta-adset-csv")
  @HeavyOperation()
  @RequirePermissions("imports.manage")
  @UseInterceptors(uploadFileInterceptor(UPLOAD_PROFILES.META_CSV))
  uploadMetaAdsetCsv(
    @UploadedFile(new SecureUploadPipe(UPLOAD_PROFILES.META_CSV)) file: Express.Multer.File,
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

  @Post("storage-tombstones/:id/restore")
  @RequirePermissions("settings.manage")
  restoreStoredObject(@Param() params: UploadParamDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.uploadsService.restoreStoredObject(params.id, actor.id);
  }

  @Post("storage-tombstones/:id/purge")
  @RequirePermissions("settings.manage")
  purgeStoredObject(@Param() params: UploadParamDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.uploadsService.purgeStoredObject(params.id, actor.id);
  }

  @Delete(":id")
  @RequirePermissions("imports.manage")
  remove(@Param() params: UploadParamDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.uploadsService.deleteUpload(params.id, actor.id);
  }
}
