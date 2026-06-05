import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { ChangeLogsService } from "./change-logs.service";

@Controller("change-logs")
export class ChangeLogsController {
  constructor(private readonly changeLogsService: ChangeLogsService) {}

  @Get("creatives")
  listCreatives(@Query("from") from?: string, @Query("to") to?: string) {
    return this.changeLogsService.listCreatives(from, to);
  }

  @Get("creatives/:creativeId")
  getCreativeDetail(@Param("creativeId") creativeId: string, @Query("from") from?: string, @Query("to") to?: string) {
    return this.changeLogsService.getCreativeDetail(creativeId, from, to);
  }

  @Post("creatives/:creativeId/logs")
  createCreativeLog(@Param("creativeId") creativeId: string, @Body() body: Record<string, unknown>) {
    return this.changeLogsService.createCreativeLog(creativeId, body);
  }

  @Get()
  list(@Query("from") from?: string, @Query("to") to?: string) {
    return this.changeLogsService.list(from, to);
  }

  @Post()
  create(@Body() body: Record<string, unknown>) {
    return this.changeLogsService.create(body);
  }
}
