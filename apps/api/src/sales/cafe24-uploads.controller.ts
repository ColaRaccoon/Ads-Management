import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UploadedFile, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ConflictPolicy } from "@prisma/client";
import { Cafe24UploadsService } from "./cafe24-uploads.service";

@Controller("sales/cafe24")
export class Cafe24UploadsController {
  constructor(private readonly cafe24UploadsService: Cafe24UploadsService) {}

  @Post("uploads")
  @UseInterceptors(FileInterceptor("file"))
  uploadCafe24Csv(@UploadedFile() file: Express.Multer.File, @Body("conflictPolicy") conflictPolicy?: ConflictPolicy) {
    return this.cafe24UploadsService.importCafe24Csv(file, conflictPolicy ?? ConflictPolicy.SKIP);
  }

  @Get("uploads")
  listUploads(@Query("take") take?: string) {
    return this.cafe24UploadsService.listUploads(take ? Number(take) : 50);
  }

  @Get("uploads/:id/preview")
  previewUpload(@Param("id") id: string, @Query("take") take?: string) {
    return this.cafe24UploadsService.previewUpload(id, take ? Number(take) : 50);
  }

  @Get("uploads/:id/errors")
  uploadErrors(@Param("id") id: string) {
    return this.cafe24UploadsService.uploadErrors(id);
  }

  @Delete("uploads/:id")
  deleteUpload(@Param("id") id: string) {
    return this.cafe24UploadsService.deleteUpload(id);
  }

  @Post("rematch")
  rematch(@Query("from") from?: string, @Query("to") to?: string, @Query("take") take?: string) {
    return this.cafe24UploadsService.rematchCafe24Lines({ from, to, take });
  }

  @Get("rules")
  listRules(@Query("productId") productId?: string, @Query("includeInactive") includeInactive?: string) {
    return this.cafe24UploadsService.listRules({ productId, includeInactive: includeInactive === "true" });
  }

  @Post("rules")
  createRule(@Body() body: Record<string, unknown>) {
    return this.cafe24UploadsService.createRule(body);
  }

  @Patch("rules/:id")
  updateRule(@Param("id") id: string, @Body() body: Record<string, unknown>) {
    return this.cafe24UploadsService.updateRule(id, body);
  }

  @Delete("rules/:id")
  deleteRule(@Param("id") id: string) {
    return this.cafe24UploadsService.deleteRule(id);
  }
}
