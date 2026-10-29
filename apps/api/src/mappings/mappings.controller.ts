import { Body, Controller, Get, Param, Patch, Post } from "@nestjs/common";
import { MappingsService } from "./mappings.service";
import { CurrentUser, RequirePermissions } from "../auth/route-decorators";
import { AuthenticatedUser } from "../auth/auth.types";
import {
  CreateManualProductMappingDto,
  CreateManualStageMappingDto,
  CreateProductMappingRuleDto,
  RematchMetricsDto,
  ProductMappingRuleIdDto,
  UpdateProductMappingRuleDto,
  ApplyProductMappingRuleDto
} from "./dto/mappings-transport.dto";

@Controller("mappings")
export class MappingsController {
  constructor(private readonly mappingsService: MappingsService) {}

  @Get("product-rules")
  @RequirePermissions("data.read")
  listProductRules() {
    return this.mappingsService.listProductRules();
  }

  @Post("product-rules")
  @RequirePermissions("mappings.manage")
  createProductRule(@Body() body: CreateProductMappingRuleDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.mappingsService.createProductRule(body, actor.id);
  }

  @Patch("product-rules/:id")
  @RequirePermissions("mappings.manage")
  updateProductRule(@Param() params: ProductMappingRuleIdDto, @Body() body: UpdateProductMappingRuleDto,
    @CurrentUser() actor: AuthenticatedUser) {
    return this.mappingsService.updateProductRule(params.id, body, actor.id);
  }

  @Post("product-rules/:id/apply")
  @RequirePermissions("mappings.manage")
  applyProductRule(@Param() params: ProductMappingRuleIdDto, @Body() body: ApplyProductMappingRuleDto,
    @CurrentUser() actor: AuthenticatedUser) {
    return this.mappingsService.applyProductRule(params.id, body, actor.id);
  }

  @Post("rematch")
  @RequirePermissions("mappings.manage")
  rematchCurrentMetrics(@Body() body: RematchMetricsDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.mappingsService.rematchCurrentMetrics(body, actor.id);
  }

  @Post("product/manual")
  @RequirePermissions("mappings.manage")
  createManualProductMapping(@Body() body: CreateManualProductMappingDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.mappingsService.createManualProductMapping(body, actor.id);
  }

  @Post("stage/manual")
  @RequirePermissions("mappings.manage")
  createManualStageMapping(@Body() body: CreateManualStageMappingDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.mappingsService.createManualStageMapping(body, actor.id);
  }
}
