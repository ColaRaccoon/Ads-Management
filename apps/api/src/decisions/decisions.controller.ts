import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { DecisionsService } from "./decisions.service";

@Controller("decisions")
export class DecisionsController {
  constructor(private readonly decisionsService: DecisionsService) {}

  @Post("run")
  run(@Body() body: { from?: string; to?: string; compareType?: string; filters?: Record<string, unknown> }) {
    return this.decisionsService.run(body);
  }

  @Get()
  list(@Query("from") from?: string, @Query("to") to?: string) {
    return this.decisionsService.list(from, to);
  }
}
