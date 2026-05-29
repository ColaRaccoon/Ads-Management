import { Body, Controller, Get, Param, Post, Res } from "@nestjs/common";
import { Response } from "express";
import { ReportsService } from "./reports.service";

@Controller("reports")
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Post("export")
  export(@Body() body: { reportType?: string; from?: string; to?: string; parameters?: Record<string, unknown> }) {
    return this.reportsService.export(body);
  }

  @Get()
  list() {
    return this.reportsService.list();
  }

  @Get(":id/download")
  async download(@Param("id") id: string, @Res() response: Response) {
    const download = await this.reportsService.download(id);
    response.download(download.absolutePath, download.filename);
  }
}
