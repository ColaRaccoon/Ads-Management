import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { ProductsService } from "./products.service";
import { RequirePermissions } from "../auth/route-decorators";
import { AuthenticatedUser } from "../auth/auth.types";
import { CurrentUser } from "../auth/route-decorators";
import {
  CreateProductDto,
  ProductListQueryDto,
  ProductParamDto,
  UpdateProductDto
} from "./dto/product-transport.dto";

@Controller("products")
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Get()
  @RequirePermissions("data.read")
  list(@Query() query: ProductListQueryDto) {
    return this.productsService.listProducts(query.includeInactive === "true");
  }

  @Post()
  @RequirePermissions("products.manage")
  create(@Body() body: CreateProductDto) {
    return this.productsService.createProduct(body);
  }

  @Patch(":id")
  @RequirePermissions("products.manage")
  update(
    @Param() params: ProductParamDto,
    @Body() body: UpdateProductDto,
    @CurrentUser() actor: AuthenticatedUser
  ) {
    return this.productsService.updateProduct(params.id, body, actor.id);
  }

  @Delete(":id")
  @RequirePermissions("products.manage")
  remove(@Param() params: ProductParamDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.productsService.deleteProduct(params.id, actor.id);
  }
}
