import { Body, Controller, Delete, Get, Param, Post, Query, UploadedFile, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ConflictPolicy } from "@prisma/client";
import { CurrentUser, RequirePermissions } from "../auth/route-decorators";
import { AuthenticatedUser } from "../auth/auth.types";
import { UploadsService } from "./uploads.service";

@Controller("uploads")
export class UploadsController {
  constructor(private readonly uploadsService: UploadsService) {}

  @Post("meta-ad-daily-csv")
  @RequirePermissions("imports.manage")
  @UseInterceptors(FileInterceptor("file"))
  uploadMetaAdDailyCsv(
    @UploadedFile() file: Express.Multer.File,
    @Body("conflictPolicy") conflictPolicy: ConflictPolicy | undefined,
    @CurrentUser() actor: AuthenticatedUser
  ) {
    return this.uploadsService.importMetaAdDailyCsv(file, conflictPolicy ?? ConflictPolicy.SKIP, actor.id);
  }

  @Post("meta-adset-csv")
  @RequirePermissions("imports.manage")
  @UseInterceptors(FileInterceptor("file"))
  uploadMetaAdsetCsv(
    @UploadedFile() file: Express.Multer.File,
    @Body("conflictPolicy") conflictPolicy: ConflictPolicy | undefined,
    @CurrentUser() actor: AuthenticatedUser
  ) {
    return this.uploadsService.importMetaAdsetCsv(file, conflictPolicy ?? ConflictPolicy.SKIP, actor.id);
  }

  @Get()
  @RequirePermissions("data.read")
  list(@Query("take") take?: string) {
    return this.uploadsService.listUploads(take ? Number(take) : 50);
  }

  @Get(":id/preview")
  @RequirePermissions("data.read")
  preview(@Param("id") id: string) {
    return this.uploadsService.previewUpload(id);
  }

  @Get(":id/errors")
  @RequirePermissions("data.read")
  errors(@Param("id") id: string) {
    return this.uploadsService.uploadErrors(id);
  }

  @Delete(":id")
  @RequirePermissions("imports.manage")
  remove(@Param("id") id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.uploadsService.deleteUpload(id, actor.id);
  }
}
