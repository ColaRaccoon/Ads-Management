import { Body, Controller, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { Cafe24CouponRulesService } from "./cafe24-coupon-rules.service";
import { CurrentUser, RequirePermissions } from "../auth/route-decorators";
import { AuthenticatedUser } from "../auth/auth.types";

@Controller("sales/cafe24/coupon-rules")
export class Cafe24CouponRulesController {
  constructor(private readonly couponRulesService: Cafe24CouponRulesService) {}

  @Get()
  @RequirePermissions("data.read")
  list(
    @Query("productId") productId?: string,
    @Query("scope") scope?: string,
    @Query("includeInactive") includeInactive?: string
  ) {
    return this.couponRulesService.listCouponRules({
      productId,
      scope,
      includeInactive: includeInactive === "true"
    });
  }

  @Post()
  @RequirePermissions("products.manage")
  create(@Body() body: Record<string, unknown>, @CurrentUser() actor: AuthenticatedUser) {
    return this.couponRulesService.createCouponRule(body, actor.id);
  }

  @Patch(":id")
  @RequirePermissions("products.manage")
  update(
    @Param("id") id: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() actor: AuthenticatedUser
  ) {
    return this.couponRulesService.updateCouponRule(id, body, actor.id);
  }
}
