import { Body, Controller, Get, Param, Patch } from "@nestjs/common";
import { AuthenticatedUser } from "../auth/auth.types";
import { CurrentUser, RequirePermissions } from "../auth/route-decorators";
import { UpdateCoupangManualPurchaseVendorFeeDto } from "./dto/update-coupang-manual-purchase-vendor-fee.dto";
import { ProductsService } from "./products.service";

@Controller("settings")
export class SettingsController {
  constructor(private readonly productsService: ProductsService) {}

  @Get()
  @RequirePermissions("data.read")
  list() {
    return this.productsService.listSettings();
  }

  @Patch(":key")
  @RequirePermissions("settings.manage")
  update(
    @Param("key") key: string,
    @Body() body: { valueJson?: unknown; description?: string },
    @CurrentUser() actor: AuthenticatedUser
  ) {
    return this.productsService.updateSetting(key, body, actor.id);
  }

  @Patch("products/coupang-manual-purchase-vendor-fee")
  @RequirePermissions("products.manage")
  updateCoupangManualPurchaseVendorFee(
    @Body() body: UpdateCoupangManualPurchaseVendorFeeDto,
    @CurrentUser() actor: AuthenticatedUser
  ) {
    return this.productsService.updateCoupangManualPurchaseVendorFee(body, actor.id);
  }
}
