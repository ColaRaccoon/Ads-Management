import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { DecisionsService } from "./decisions.service";
import { CurrentUser, RequirePermissions } from "../auth/route-decorators";
import { AuthenticatedUser } from "../auth/auth.types";

@Controller("decisions")
export class DecisionsController {
  constructor(private readonly decisionsService: DecisionsService) {}

  @Post("run")
  @RequirePermissions("operations.run")
  run(
    @Body() body: { from?: string; to?: string; compareType?: string; filters?: Record<string, unknown> },
    @CurrentUser() actor: AuthenticatedUser
  ) {
    return this.decisionsService.run(body, actor.id);
  }

  @Get()
  @RequirePermissions("data.read")
  list(@Query("from") from?: string, @Query("to") to?: string) {
    return this.decisionsService.list(from, to);
  }
}
