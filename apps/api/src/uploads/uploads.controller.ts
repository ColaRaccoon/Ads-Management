import { Body, Controller, Get, Param, Post, Query, UploadedFile, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ConflictPolicy } from "@prisma/client";
import { UploadsService } from "./uploads.service";

@Controller("uploads")
export class UploadsController {
  constructor(private readonly uploadsService: UploadsService) {}

  @Post("meta-adset-csv")
  @UseInterceptors(FileInterceptor("file"))
  uploadMetaAdsetCsv(
    @UploadedFile() file: Express.Multer.File,
    @Body("conflictPolicy") conflictPolicy?: ConflictPolicy
  ) {
    return this.uploadsService.importMetaAdsetCsv(file, conflictPolicy ?? ConflictPolicy.SKIP);
  }

  @Get()
  list(@Query("take") take?: string) {
    return this.uploadsService.listUploads(take ? Number(take) : 50);
  }

  @Get(":id/preview")
  preview(@Param("id") id: string) {
    return this.uploadsService.previewUpload(id);
  }

  @Get(":id/errors")
  errors(@Param("id") id: string) {
    return this.uploadsService.uploadErrors(id);
  }
}
