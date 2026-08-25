import { Body, Controller, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { ProductsService } from "./products.service";
import { CurrentUser, RequirePermissions } from "../auth/route-decorators";
import { AuthenticatedUser } from "../auth/auth.types";
import {
  CorrectProductCostRuleDto,
  CorrectProductCpaRuleDto,
  CreateProductCostRuleDto,
  CreateProductCpaRuleDto,
  ProductCostSnapshotDto,
  ProductCpaSnapshotDto,
  ProductIdParamDto,
  ProductRuleParamDto,
  ProductRulesQueryDto
} from "./dto/product-transport.dto";

@Controller()
export class ProductRulesController {
  constructor(private readonly productsService: ProductsService) {}

  @Get("product-cost-rules")
  @RequirePermissions("data.read")
  listCostRules(@Query() query: ProductRulesQueryDto) {
    return this.productsService.listCostRules(query.productId);
  }

  @Post("product-cost-rules")
  @RequirePermissions("products.manage")
  createCostRule(@Body() body: CreateProductCostRuleDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.productsService.createCostRule(body, actor.id);
  }

  @Post("products/:productId/cost-rule-snapshots")
  @RequirePermissions("products.manage")
  saveCostRuleSnapshot(
    @Param() params: ProductIdParamDto,
    @Body() body: ProductCostSnapshotDto,
    @CurrentUser() actor: AuthenticatedUser
  ) {
    return this.productsService.saveCostRuleSnapshot(params.productId, body, actor.id);
  }

  @Patch("products/:productId/cost-rules/:ruleId/correction")
  @RequirePermissions("products.manage")
  correctCostRule(
    @Param() params: ProductRuleParamDto,
    @Body() body: CorrectProductCostRuleDto,
    @CurrentUser() actor: AuthenticatedUser
  ) {
    return this.productsService.correctCostRule(params.productId, params.ruleId, body, actor.id);
  }

  @Get("product-cpa-rules")
  @RequirePermissions("data.read")
  listCpaRules(@Query() query: ProductRulesQueryDto) {
    return this.productsService.listCpaRules(query.productId);
  }

  @Post("product-cpa-rules")
  @RequirePermissions("products.manage")
  createCpaRule(@Body() body: CreateProductCpaRuleDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.productsService.createCpaRule(body, actor.id);
  }

  @Post("products/:productId/cpa-rule-snapshots")
  @RequirePermissions("products.manage")
  saveCpaRuleSnapshot(
    @Param() params: ProductIdParamDto,
    @Body() body: ProductCpaSnapshotDto,
    @CurrentUser() actor: AuthenticatedUser
  ) {
    return this.productsService.saveCpaRuleSnapshot(params.productId, body, actor.id);
  }

  @Patch("products/:productId/cpa-rules/:ruleId/correction")
  @RequirePermissions("products.manage")
  correctCpaRule(
    @Param() params: ProductRuleParamDto,
    @Body() body: CorrectProductCpaRuleDto,
    @CurrentUser() actor: AuthenticatedUser
  ) {
    return this.productsService.correctCpaRule(params.productId, params.ruleId, body, actor.id);
  }

  @Get("product-rule-duplicate-diagnostics")
  @RequirePermissions("data.read")
  duplicateDiagnostics() {
    return this.productsService.productRuleDuplicateDiagnostics();
  }
}
