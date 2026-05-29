import { Module } from "@nestjs/common";
import { ProductsController } from "./products.controller";
import { ProductRulesController } from "./product-rules.controller";
import { SettingsController } from "./settings.controller";
import { ProductsService } from "./products.service";

@Module({
  controllers: [ProductsController, ProductRulesController, SettingsController],
  providers: [ProductsService],
  exports: [ProductsService]
})
export class ProductsModule {}
