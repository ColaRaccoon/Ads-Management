import { Body, Controller, Delete, Get, Header, Param, Patch, Post, Query } from "@nestjs/common";
import { AuthenticatedUser } from "../auth/auth.types";
import { CurrentUser, RequirePermissions } from "../auth/route-decorators";
import { ConfigurationQuery, DeleteConfigurationInput, ProductInput, ProductPreviewInput, RuleInput, RulePreviewInput, UnifiedIdParam } from "./management.dto";
import { UnifiedManagementService } from "./management.service";

@Controller("unified-products")
export class UnifiedProductsController {
  constructor(private readonly service: UnifiedManagementService) {}
  @Get() @Header("Cache-Control", "no-store") @RequirePermissions("data.read")
  list(@Query() query: ConfigurationQuery) { return this.service.listProducts(query); }
  @Post("preview") @Header("Cache-Control", "no-store") @RequirePermissions("data.read")
  preview(@Body() input: ProductPreviewInput) { return this.service.previewProduct(input, input.id); }
  @Get(":id/audit") @Header("Cache-Control", "no-store") @RequirePermissions("data.read")
  audit(@Param() params: UnifiedIdParam) { return this.service.audit(params.id); }
  @Post() @RequirePermissions("products.manage")
  create(@Body() input: ProductInput, @CurrentUser() actor: AuthenticatedUser) { return this.service.saveProduct(input, actor); }
  @Patch(":id") @RequirePermissions("products.manage")
  update(@Param() params: UnifiedIdParam, @Body() input: ProductInput, @CurrentUser() actor: AuthenticatedUser) { return this.service.saveProduct(input, actor, params.id); }
  @Delete(":id") @RequirePermissions("products.manage")
  remove(@Param() params: UnifiedIdParam, @Body() input: DeleteConfigurationInput, @CurrentUser() actor: AuthenticatedUser) { return this.service.deleteProduct(params.id, input, actor); }
}

@Controller("unified-rules")
export class UnifiedRulesController {
  constructor(private readonly service: UnifiedManagementService) {}
  @Get() @Header("Cache-Control", "no-store") @RequirePermissions("data.read")
  list(@Query() query: ConfigurationQuery) { return this.service.listRules(query); }
  @Post("preview") @Header("Cache-Control", "no-store") @RequirePermissions("data.read")
  preview(@Body() input: RulePreviewInput) { return this.service.previewRule(input); }
  @Get(":id/audit") @Header("Cache-Control", "no-store") @RequirePermissions("data.read")
  audit(@Param() params: UnifiedIdParam) { return this.service.audit(params.id); }
  @Post() @RequirePermissions("mappings.manage")
  create(@Body() input: RuleInput, @CurrentUser() actor: AuthenticatedUser) { return this.service.saveRule(input, actor); }
  @Patch(":id") @RequirePermissions("mappings.manage")
  update(@Param() params: UnifiedIdParam, @Body() input: RuleInput, @CurrentUser() actor: AuthenticatedUser) { return this.service.saveRule(input, actor, params.id); }
  @Delete(":id") @RequirePermissions("mappings.manage")
  remove(@Param() params: UnifiedIdParam, @Body() input: DeleteConfigurationInput, @CurrentUser() actor: AuthenticatedUser) { return this.service.deleteRule(params.id, input, actor); }
}
