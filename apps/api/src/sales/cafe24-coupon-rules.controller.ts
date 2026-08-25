import { Body, Controller, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { Cafe24CouponRulesService } from "./cafe24-coupon-rules.service";
import { CurrentUser, RequirePermissions } from "../auth/route-decorators";
import { AuthenticatedUser } from "../auth/auth.types";
import {
  Cafe24CouponRuleDto,
  Cafe24ParamDto,
  CouponRulesQueryDto
} from "./dto/sales-transport.dto";

@Controller("sales/cafe24/coupon-rules")
export class Cafe24CouponRulesController {
  constructor(private readonly couponRulesService: Cafe24CouponRulesService) {}

  @Get()
  @RequirePermissions("data.read")
  list(@Query() query: CouponRulesQueryDto) {
    return this.couponRulesService.listCouponRules({
      productId: query.productId,
      scope: query.scope,
      includeInactive: query.includeInactive === "true"
    });
  }

  @Post()
  @RequirePermissions("products.manage")
  create(@Body() body: Cafe24CouponRuleDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.couponRulesService.createCouponRule(body, actor.id);
  }

  @Patch(":id")
  @RequirePermissions("products.manage")
  update(
    @Param() params: Cafe24ParamDto,
    @Body() body: Cafe24CouponRuleDto,
    @CurrentUser() actor: AuthenticatedUser
  ) {
    return this.couponRulesService.updateCouponRule(params.id, body, actor.id);
  }
}
