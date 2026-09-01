import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UploadedFile, UseInterceptors } from "@nestjs/common";
import { ConflictPolicy } from "@prisma/client";
import { Cafe24UploadsService } from "./cafe24-uploads.service";
import { CurrentUser, RequirePermissions } from "../auth/route-decorators";
import { AuthenticatedUser } from "../auth/auth.types";
import { SecureUploadPipe } from "../file-security/secure-upload.pipe";
import { UPLOAD_PROFILES, uploadFileInterceptor } from "../file-security/upload-profiles";
import {
  Cafe24ParamDto,
  Cafe24RematchQueryDto,
  Cafe24RuleDto,
  Cafe24RulesQueryDto,
  Cafe24UploadFormDto,
  Cafe24UploadListQueryDto,
  Cafe24UploadPreviewQueryDto
} from "./dto/sales-transport.dto";
import { HeavyOperation } from "../common/heavy-operation";

@Controller("sales/cafe24")
export class Cafe24UploadsController {
  constructor(private readonly cafe24UploadsService: Cafe24UploadsService) {}

  @Post("uploads")
  @HeavyOperation()
  @RequirePermissions("imports.manage")
  @UseInterceptors(uploadFileInterceptor(UPLOAD_PROFILES.CAFE24_CSV))
  uploadCafe24Csv(
    @UploadedFile(new SecureUploadPipe(UPLOAD_PROFILES.CAFE24_CSV)) file: Express.Multer.File,
    @Body() body: Cafe24UploadFormDto,
    @CurrentUser() actor: AuthenticatedUser
  ) {
    return this.cafe24UploadsService.importCafe24Csv(file, body.conflictPolicy ?? ConflictPolicy.SKIP, actor.id);
  }

  @Get("uploads")
  @RequirePermissions("data.read")
  listUploads(@Query() query: Cafe24UploadListQueryDto) {
    return this.cafe24UploadsService.listUploads(query.take ?? 50);
  }

  @Get("uploads/:id/preview")
  @RequirePermissions("data.read")
  previewUpload(@Param() params: Cafe24ParamDto, @Query() query: Cafe24UploadPreviewQueryDto) {
    return this.cafe24UploadsService.previewUpload(params.id, query.take ?? 50);
  }

  @Get("uploads/:id/errors")
  @RequirePermissions("data.read")
  uploadErrors(@Param() params: Cafe24ParamDto) {
    return this.cafe24UploadsService.uploadErrors(params.id);
  }

  @Delete("uploads/:id")
  @RequirePermissions("imports.manage")
  deleteUpload(@Param() params: Cafe24ParamDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.cafe24UploadsService.deleteUpload(params.id, actor.id);
  }

  @Post("rematch")
  @RequirePermissions("mappings.manage")
  rematch(
    @CurrentUser() actor: AuthenticatedUser,
    @Query() query: Cafe24RematchQueryDto
  ) {
    return this.cafe24UploadsService.rematchCafe24Lines({
      from: query.from,
      to: query.to,
      take: query.take === undefined ? undefined : String(query.take)
    }, actor.id);
  }

  @Get("rules")
  @RequirePermissions("data.read")
  listRules(@Query() query: Cafe24RulesQueryDto) {
    return this.cafe24UploadsService.listRules({
      productId: query.productId,
      includeInactive: query.includeInactive === "true"
    });
  }

  @Post("rules")
  @RequirePermissions("mappings.manage")
  createRule(@Body() body: Cafe24RuleDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.cafe24UploadsService.createRule(body, actor.id);
  }

  @Patch("rules/:id")
  @RequirePermissions("mappings.manage")
  updateRule(
    @Param() params: Cafe24ParamDto,
    @Body() body: Cafe24RuleDto,
    @CurrentUser() actor: AuthenticatedUser
  ) {
    return this.cafe24UploadsService.updateRule(params.id, body, actor.id);
  }

  @Delete("rules/:id")
  @RequirePermissions("mappings.manage")
  deleteRule(@Param() params: Cafe24ParamDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.cafe24UploadsService.deleteRule(params.id, actor.id);
  }
}
