import { Body, Controller, Get, Post } from "@nestjs/common";
import { MappingsService } from "./mappings.service";

@Controller("mappings")
export class MappingsController {
  constructor(private readonly mappingsService: MappingsService) {}

  @Get("product-rules")
  listProductRules() {
    return this.mappingsService.listProductRules();
  }

  @Post("product-rules")
  createProductRule(@Body() body: Record<string, unknown>) {
    return this.mappingsService.createProductRule(body);
  }

  @Post("rematch")
  rematchCurrentMetrics(@Body() body: Record<string, unknown>) {
    return this.mappingsService.rematchCurrentMetrics(body);
  }

  @Post("product/manual")
  createManualProductMapping(@Body() body: Record<string, unknown>) {
    return this.mappingsService.createManualProductMapping(body);
  }

  @Post("stage/manual")
  createManualStageMapping(@Body() body: Record<string, unknown>) {
    return this.mappingsService.createManualStageMapping(body);
  }
}
