import { Body, Controller, Get, Post } from "@nestjs/common";
import { MappingsService } from "./mappings.service";
import { CurrentUser, RequirePermissions } from "../auth/route-decorators";
import { AuthenticatedUser } from "../auth/auth.types";

@Controller("mappings")
export class MappingsController {
  constructor(private readonly mappingsService: MappingsService) {}

  @Get("product-rules")
  @RequirePermissions("data.read")
  listProductRules() {
    return this.mappingsService.listProductRules();
  }

  @Post("product-rules")
  @RequirePermissions("mappings.manage")
  createProductRule(@Body() body: Record<string, unknown>, @CurrentUser() actor: AuthenticatedUser) {
    return this.mappingsService.createProductRule(body, actor.id);
  }

  @Post("rematch")
  @RequirePermissions("mappings.manage")
  rematchCurrentMetrics(@Body() body: Record<string, unknown>) {
    return this.mappingsService.rematchCurrentMetrics(body);
  }

  @Post("product/manual")
  @RequirePermissions("mappings.manage")
  createManualProductMapping(@Body() body: Record<string, unknown>, @CurrentUser() actor: AuthenticatedUser) {
    return this.mappingsService.createManualProductMapping(body, actor.id);
  }

  @Post("stage/manual")
  @RequirePermissions("mappings.manage")
  createManualStageMapping(@Body() body: Record<string, unknown>, @CurrentUser() actor: AuthenticatedUser) {
    return this.mappingsService.createManualStageMapping(body, actor.id);
  }
}
