import { Body, Controller, Get, Header, HttpCode, Param, Post, Query } from "@nestjs/common";
import type { AuthenticatedUser } from "../auth/auth.types";
import { CurrentUser, RequirePermissions } from "../auth/route-decorators";
import { UnifiedReportService } from "./report.service";
import { ReportQueryDto, RebuildInputDto } from "./report.dto";

@Controller("unified-performance")
export class UnifiedReportController {
  constructor(private readonly service: UnifiedReportService) {}
  @Get("options") @Header("Cache-Control", "no-store") @RequirePermissions("data.read")
  options(@Query() query: ReportQueryDto, @CurrentUser() actor: AuthenticatedUser) { return this.service.read("options", { ...query }, actor); }
  @Get("summary") @Header("Cache-Control", "no-store") @RequirePermissions("data.read")
  summary(@Query() query: ReportQueryDto, @CurrentUser() actor: AuthenticatedUser) { return this.service.read("summary", { ...query }, actor); }
  @Get("timeseries") @Header("Cache-Control", "no-store") @RequirePermissions("data.read")
  timeseries(@Query() query: ReportQueryDto, @CurrentUser() actor: AuthenticatedUser) { return this.service.read("timeseries", { ...query }, actor); }
  @Get("diagnostics") @Header("Cache-Control", "no-store") @RequirePermissions("data.read")
  diagnostics(@Query() query: ReportQueryDto, @CurrentUser() actor: AuthenticatedUser) { return this.service.read("diagnostics", { ...query }, actor); }
  @Post("rebuild") @HttpCode(202) @Header("Cache-Control", "no-store") @RequirePermissions("operations.run")
  rebuild(@Body() input: RebuildInputDto, @CurrentUser() actor: AuthenticatedUser) { return this.service.rebuild({ ...input }, actor); }
  @Get("rebuild/:jobId") @Header("Cache-Control", "no-store") @RequirePermissions("operations.run")
  job(@Param("jobId") jobId: string, @CurrentUser() actor: AuthenticatedUser) { return this.service.job(jobId, actor); }
}
