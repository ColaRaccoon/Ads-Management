import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { ProductsService } from "./products.service";

@Controller("products")
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Get()
  list(@Query("includeInactive") includeInactive?: string) {
    return this.productsService.listProducts(includeInactive === "true");
  }

  @Post()
  create(@Body() body: Record<string, unknown>) {
    return this.productsService.createProduct(body);
  }

  @Patch(":id")
  update(@Param("id") id: string, @Body() body: Record<string, unknown>) {
    return this.productsService.updateProduct(id, body);
  }

  @Delete(":id")
  remove(@Param("id") id: string) {
    return this.productsService.deleteProduct(id);
  }
}
