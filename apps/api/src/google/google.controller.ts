import { Body, Controller, Get, Header, Param, Patch, Post, Query } from "@nestjs/common";
import { CurrentUser, RequirePermissions } from "../auth/route-decorators";
import { AuthenticatedUser } from "../auth/auth.types";
import { IdParam } from "../daily-sync/daily-sync.dto";
import { GoogleQuery, GoogleMappingInput } from "./google.dto";
import { GoogleReadService } from "./google-read.service";
import { GoogleMappingsService } from "./google-mappings.service";

@Controller("google")
export class GoogleController {
  constructor(private readonly read: GoogleReadService, private readonly mappings: GoogleMappingsService) {}
  @Get("options") @Header("Cache-Control", "no-store") @RequirePermissions("data.read")
  options() { return this.read.options(); }
  @Get("summary") @Header("Cache-Control", "no-store") @RequirePermissions("data.read")
  summary(@Query() query: GoogleQuery) { return this.read.report(query, "summary"); }
  @Get("profit") @Header("Cache-Control", "no-store") @RequirePermissions("data.read")
  profit(@Query() query: GoogleQuery) { return this.read.report(query, "profit"); }
  @Get("campaigns") @Header("Cache-Control", "no-store") @RequirePermissions("data.read")
  campaigns(@Query() query: GoogleQuery) { return this.read.report(query, "campaigns"); }
  @Get("mappings") @Header("Cache-Control", "no-store") @RequirePermissions("data.read")
  list(@Query() query: GoogleQuery) { return this.mappings.list(query); }
  @Post("mappings/preview") @RequirePermissions("mappings.manage")
  preview(@Body() input: GoogleMappingInput) { return this.mappings.preview(input); }
  @Post("mappings") @RequirePermissions("mappings.manage")
  create(@Body() input: GoogleMappingInput, @CurrentUser() actor: AuthenticatedUser) { return this.mappings.save(input, actor.id); }
  @Patch("mappings/:id") @RequirePermissions("mappings.manage")
  update(@Param() params: IdParam, @Body() input: GoogleMappingInput, @CurrentUser() actor: AuthenticatedUser) {
    return this.mappings.save(input, actor.id, params.id);
  }
}
