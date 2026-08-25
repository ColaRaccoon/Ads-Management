import { Body, Controller, Get, Param, Post, Res } from "@nestjs/common";
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
  async download(@Param() params: ReportParamDto, @Res() response: Response) {
    const download = await this.reportsService.download(params.id);
    response.download(download.absolutePath, download.filename);
  }
}
