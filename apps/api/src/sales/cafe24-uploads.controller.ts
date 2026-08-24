import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UploadedFile, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ConflictPolicy } from "@prisma/client";
import { Cafe24UploadsService } from "./cafe24-uploads.service";
import { CurrentUser, RequirePermissions } from "../auth/route-decorators";
import { AuthenticatedUser } from "../auth/auth.types";

@Controller("sales/cafe24")
export class Cafe24UploadsController {
  constructor(private readonly cafe24UploadsService: Cafe24UploadsService) {}

  @Post("uploads")
  @RequirePermissions("imports.manage")
  @UseInterceptors(FileInterceptor("file"))
  uploadCafe24Csv(
    @UploadedFile() file: Express.Multer.File,
    @Body("conflictPolicy") conflictPolicy: ConflictPolicy | undefined,
    @CurrentUser() actor: AuthenticatedUser
  ) {
    return this.cafe24UploadsService.importCafe24Csv(file, conflictPolicy ?? ConflictPolicy.SKIP, actor.id);
  }

  @Get("uploads")
  @RequirePermissions("data.read")
  listUploads(@Query("take") take?: string) {
    return this.cafe24UploadsService.listUploads(take ? Number(take) : 50);
  }

  @Get("uploads/:id/preview")
  @RequirePermissions("data.read")
  previewUpload(@Param("id") id: string, @Query("take") take?: string) {
    return this.cafe24UploadsService.previewUpload(id, take ? Number(take) : 50);
  }

  @Get("uploads/:id/errors")
  @RequirePermissions("data.read")
  uploadErrors(@Param("id") id: string) {
    return this.cafe24UploadsService.uploadErrors(id);
  }

  @Delete("uploads/:id")
  @RequirePermissions("imports.manage")
  deleteUpload(@Param("id") id: string) {
    return this.cafe24UploadsService.deleteUpload(id);
  }

  @Post("rematch")
  @RequirePermissions("mappings.manage")
  rematch(@Query("from") from?: string, @Query("to") to?: string, @Query("take") take?: string) {
    return this.cafe24UploadsService.rematchCafe24Lines({ from, to, take });
  }

  @Get("rules")
  @RequirePermissions("data.read")
  listRules(@Query("productId") productId?: string, @Query("includeInactive") includeInactive?: string) {
    return this.cafe24UploadsService.listRules({ productId, includeInactive: includeInactive === "true" });
  }

  @Post("rules")
  @RequirePermissions("mappings.manage")
  createRule(@Body() body: Record<string, unknown>) {
    return this.cafe24UploadsService.createRule(body);
  }

  @Patch("rules/:id")
  @RequirePermissions("mappings.manage")
  updateRule(@Param("id") id: string, @Body() body: Record<string, unknown>) {
    return this.cafe24UploadsService.updateRule(id, body);
  }

  @Delete("rules/:id")
  @RequirePermissions("mappings.manage")
  deleteRule(@Param("id") id: string) {
    return this.cafe24UploadsService.deleteRule(id);
  }
}
