import { Body, Controller, Get, Header, Param, Patch, Query } from "@nestjs/common";
import { CurrentUser, RequirePermissions } from "../auth/route-decorators";
import { AuthenticatedUser } from "../auth/auth.types";
import { ConnectionListQuery, IdParam } from "../daily-sync/daily-sync.dto";
import { StorefrontEnabledInput, StorefrontQuery } from "./storefront.dto";
import { StorefrontReadService } from "./storefront-read.service";
import { StorefrontControlService } from "./storefront-control.service";

@Controller("storefront")
export class StorefrontController {
  constructor(private readonly read: StorefrontReadService, private readonly control: StorefrontControlService) {}
  @Get("summary")
  @Header("Cache-Control", "no-store")
  @RequirePermissions("data.read")
  summary(@Query() query: StorefrontQuery) { return this.read.summary(query.from, query.to); }

  @Get("ad-spend")
  @Header("Cache-Control", "no-store")
  @RequirePermissions("data.read")
  adSpend(@Query() query: StorefrontQuery) { return this.read.summary(query.from, query.to); }

  @Get("connections/:id/runs")
  @Header("Cache-Control", "no-store")
  @RequirePermissions("imports.manage")
  runs(@Param() params: IdParam, @Query() query: ConnectionListQuery) { return this.control.runs(params.id, query.page ?? 1); }

  @Patch("connections/:id/enabled")
  @RequirePermissions("settings.manage")
  enabled(@Param() params: IdParam, @Body() body: StorefrontEnabledInput, @CurrentUser() actor: AuthenticatedUser) {
    return this.control.setEnabled(params.id, body, actor.id);
  }
}
