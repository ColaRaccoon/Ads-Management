import { Body, Controller, Get, Param, Post, Res, StreamableFile } from "@nestjs/common";
import { Response } from "express";
import { ReportsService } from "./reports.service";
import { CurrentUser, RequirePermissions } from "../auth/route-decorators";
import { AuthenticatedUser } from "../auth/auth.types";
import { ExportReportDto, ReportParamDto } from "./dto/report-transport.dto";

@Controller("reports")
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Post("export")
  @RequirePermissions("reports.generate")
  export(
    @Body() body: ExportReportDto,
    @CurrentUser() actor: AuthenticatedUser
  ) {
    return this.reportsService.export(body, actor.id);
  }

  @Get()
  @RequirePermissions("data.read")
  list() {
    return this.reportsService.list();
  }

  @Get(":id/download")
  @RequirePermissions("data.read")
  async download(@Param() params: ReportParamDto, @Res({ passthrough: true }) response: Response) {
    const download = await this.reportsService.download(params.id);
    response.setHeader("Content-Type", download.contentType);
    response.setHeader("Content-Length", String(download.size));
    response.setHeader("Content-Disposition", contentDisposition(download.filename));
    response.setHeader("X-Content-Type-Options", "nosniff");
    return new StreamableFile(download.stream);
  }
}

function contentDisposition(filename: string) {
  const ascii = filename.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 180) || "report";
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
