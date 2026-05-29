import { Body, Controller, Get, Param, Patch } from "@nestjs/common";
import { ProductsService } from "./products.service";

@Controller("settings")
export class SettingsController {
  constructor(private readonly productsService: ProductsService) {}

  @Get()
  list() {
    return this.productsService.listSettings();
  }

  @Patch(":key")
  update(@Param("key") key: string, @Body() body: { valueJson?: unknown; description?: string }) {
    return this.productsService.updateSetting(key, body);
  }
}
