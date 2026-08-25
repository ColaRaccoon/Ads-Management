import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { ProductsService } from "./products.service";
import { RequirePermissions } from "../auth/route-decorators";
import { AuthenticatedUser } from "../auth/auth.types";
import { CurrentUser } from "../auth/route-decorators";

@Controller("products")
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Get()
  @RequirePermissions("data.read")
  list(@Query("includeInactive") includeInactive?: string) {
    return this.productsService.listProducts(includeInactive === "true");
  }

  @Post()
  @RequirePermissions("products.manage")
  create(@Body() body: Record<string, unknown>) {
    return this.productsService.createProduct(body);
  }

  @Patch(":id")
  @RequirePermissions("products.manage")
  update(
    @Param("id") id: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() actor: AuthenticatedUser
  ) {
    return this.productsService.updateProduct(id, body, actor.id);
  }

  @Delete(":id")
  @RequirePermissions("products.manage")
  remove(@Param("id") id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.productsService.deleteProduct(id, actor.id);
  }
}
