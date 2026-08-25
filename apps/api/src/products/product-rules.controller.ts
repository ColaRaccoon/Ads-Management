import { Body, Controller, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { ProductsService } from "./products.service";
import { CurrentUser, RequirePermissions } from "../auth/route-decorators";
import { AuthenticatedUser } from "../auth/auth.types";

@Controller()
export class ProductRulesController {
  constructor(private readonly productsService: ProductsService) {}

  @Get("product-cost-rules")
  @RequirePermissions("data.read")
  listCostRules(@Query("productId") productId?: string) {
    return this.productsService.listCostRules(productId);
  }

  @Post("product-cost-rules")
  @RequirePermissions("products.manage")
  createCostRule(@Body() body: Record<string, unknown>, @CurrentUser() actor: AuthenticatedUser) {
    return this.productsService.createCostRule(body, actor.id);
  }

  @Post("products/:productId/cost-rule-snapshots")
  @RequirePermissions("products.manage")
  saveCostRuleSnapshot(
    @Param("productId") productId: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() actor: AuthenticatedUser
  ) {
    return this.productsService.saveCostRuleSnapshot(productId, body, actor.id);
  }

  @Patch("products/:productId/cost-rules/:ruleId/correction")
  @RequirePermissions("products.manage")
  correctCostRule(
    @Param("productId") productId: string,
    @Param("ruleId") ruleId: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() actor: AuthenticatedUser
  ) {
    return this.productsService.correctCostRule(productId, ruleId, body, actor.id);
  }

  @Get("product-cpa-rules")
  @RequirePermissions("data.read")
  listCpaRules(@Query("productId") productId?: string) {
    return this.productsService.listCpaRules(productId);
  }

  @Post("product-cpa-rules")
  @RequirePermissions("products.manage")
  createCpaRule(@Body() body: Record<string, unknown>, @CurrentUser() actor: AuthenticatedUser) {
    return this.productsService.createCpaRule(body, actor.id);
  }

  @Post("products/:productId/cpa-rule-snapshots")
  @RequirePermissions("products.manage")
  saveCpaRuleSnapshot(
    @Param("productId") productId: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() actor: AuthenticatedUser
  ) {
    return this.productsService.saveCpaRuleSnapshot(productId, body, actor.id);
  }

  @Patch("products/:productId/cpa-rules/:ruleId/correction")
  @RequirePermissions("products.manage")
  correctCpaRule(
    @Param("productId") productId: string,
    @Param("ruleId") ruleId: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() actor: AuthenticatedUser
  ) {
    return this.productsService.correctCpaRule(productId, ruleId, body, actor.id);
  }

  @Get("product-rule-duplicate-diagnostics")
  @RequirePermissions("data.read")
  duplicateDiagnostics() {
    return this.productsService.productRuleDuplicateDiagnostics();
  }
}
