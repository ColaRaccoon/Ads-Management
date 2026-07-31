import { Body, Controller, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { Cafe24CouponRulesService } from "./cafe24-coupon-rules.service";

@Controller("sales/cafe24/coupon-rules")
export class Cafe24CouponRulesController {
  constructor(private readonly couponRulesService: Cafe24CouponRulesService) {}

  @Get()
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
  create(@Body() body: Record<string, unknown>) {
    return this.couponRulesService.createCouponRule(body);
  }

  @Patch(":id")
  update(@Param("id") id: string, @Body() body: Record<string, unknown>) {
    return this.couponRulesService.updateCouponRule(id, body);
  }
}
