import { Body, Controller, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { ProductsService } from "./products.service";

@Controller()
export class ProductRulesController {
  constructor(private readonly productsService: ProductsService) {}

  @Get("product-cost-rules")
  listCostRules(@Query("productId") productId?: string) {
    return this.productsService.listCostRules(productId);
  }

  @Post("product-cost-rules")
  createCostRule(@Body() body: Record<string, unknown>) {
    return this.productsService.createCostRule(body);
  }

  @Post("products/:productId/cost-rule-snapshots")
  saveCostRuleSnapshot(@Param("productId") productId: string, @Body() body: Record<string, unknown>) {
    return this.productsService.saveCostRuleSnapshot(productId, body);
  }

  @Patch("products/:productId/cost-rules/:ruleId/correction")
  correctCostRule(
    @Param("productId") productId: string,
    @Param("ruleId") ruleId: string,
    @Body() body: Record<string, unknown>
  ) {
    return this.productsService.correctCostRule(productId, ruleId, body);
  }

  @Get("product-cpa-rules")
  listCpaRules(@Query("productId") productId?: string) {
    return this.productsService.listCpaRules(productId);
  }

  @Post("product-cpa-rules")
  createCpaRule(@Body() body: Record<string, unknown>) {
    return this.productsService.createCpaRule(body);
  }

  @Post("products/:productId/cpa-rule-snapshots")
  saveCpaRuleSnapshot(@Param("productId") productId: string, @Body() body: Record<string, unknown>) {
    return this.productsService.saveCpaRuleSnapshot(productId, body);
  }

  @Patch("products/:productId/cpa-rules/:ruleId/correction")
  correctCpaRule(
    @Param("productId") productId: string,
    @Param("ruleId") ruleId: string,
    @Body() body: Record<string, unknown>
  ) {
    return this.productsService.correctCpaRule(productId, ruleId, body);
  }

  @Get("product-rule-duplicate-diagnostics")
  duplicateDiagnostics() {
    return this.productsService.productRuleDuplicateDiagnostics();
  }
}
