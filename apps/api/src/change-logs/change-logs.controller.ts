import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { ChangeLogsService } from "./change-logs.service";
import { CurrentUser, RequirePermissions } from "../auth/route-decorators";
import { AuthenticatedUser } from "../auth/auth.types";

@Controller("change-logs")
export class ChangeLogsController {
  constructor(private readonly changeLogsService: ChangeLogsService) {}

  @Get("creatives")
  @RequirePermissions("data.read")
  listCreatives(@Query("from") from?: string, @Query("to") to?: string) {
    return this.changeLogsService.listCreatives(from, to);
  }

  @Get("creatives/:creativeId")
  @RequirePermissions("data.read")
  getCreativeDetail(@Param("creativeId") creativeId: string, @Query("from") from?: string, @Query("to") to?: string) {
    return this.changeLogsService.getCreativeDetail(creativeId, from, to);
  }

  @Post("creatives/:creativeId/logs")
  @RequirePermissions("change_logs.create")
  createCreativeLog(
    @Param("creativeId") creativeId: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() actor: AuthenticatedUser
  ) {
    return this.changeLogsService.createCreativeLog(creativeId, body, actor.id);
  }

  @Get("products")
  @RequirePermissions("data.read")
  listProducts(@Query("date") date?: string) {
    return this.changeLogsService.listProducts(date);
  }

  @Get("products/:productId")
  @RequirePermissions("data.read")
  getProductDetail(@Param("productId") productId: string, @Query("date") date?: string) {
    return this.changeLogsService.getProductDetail(productId, date);
  }

  @Post("products/:productId/logs")
  @RequirePermissions("change_logs.create")
  createProductLog(
    @Param("productId") productId: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() actor: AuthenticatedUser
  ) {
    return this.changeLogsService.createProductLog(productId, body, actor.id);
  }

  @Get()
  @RequirePermissions("data.read")
  list(@Query("from") from?: string, @Query("to") to?: string) {
    return this.changeLogsService.list(from, to);
  }

  @Post()
  @RequirePermissions("change_logs.create")
  create(@Body() body: Record<string, unknown>, @CurrentUser() actor: AuthenticatedUser) {
    return this.changeLogsService.create(body, actor.id);
  }
}
