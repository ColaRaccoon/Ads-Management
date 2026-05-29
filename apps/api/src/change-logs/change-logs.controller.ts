import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { ChangeLogsService } from "./change-logs.service";

@Controller("change-logs")
export class ChangeLogsController {
  constructor(private readonly changeLogsService: ChangeLogsService) {}

  @Get()
  list(@Query("from") from?: string, @Query("to") to?: string) {
    return this.changeLogsService.list(from, to);
  }

  @Post()
  create(@Body() body: Record<string, unknown>) {
    return this.changeLogsService.create(body);
  }
}
