import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { DecisionsService } from "./decisions.service";
import { CurrentUser, RequirePermissions } from "../auth/route-decorators";
import { AuthenticatedUser } from "../auth/auth.types";
import { DateRangeQueryDto } from "../validation/transport-validation";
import { RunDecisionDto } from "./dto/decision-transport.dto";

@Controller("decisions")
export class DecisionsController {
  constructor(private readonly decisionsService: DecisionsService) {}

  @Post("run")
  @RequirePermissions("operations.run")
  run(
    @Body() body: RunDecisionDto,
    @CurrentUser() actor: AuthenticatedUser
  ) {
    return this.decisionsService.run(body, actor.id);
  }

  @Get()
  @RequirePermissions("data.read")
  list(@Query() query: DateRangeQueryDto) {
    return this.decisionsService.list(query.from, query.to);
  }
}
