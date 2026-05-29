import { Body, Controller, Get, Post, Query } from "@nestjs/common";
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

  @Get("product-cpa-rules")
  listCpaRules(@Query("productId") productId?: string) {
    return this.productsService.listCpaRules(productId);
  }

  @Post("product-cpa-rules")
  createCpaRule(@Body() body: Record<string, unknown>) {
    return this.productsService.createCpaRule(body);
  }
}
