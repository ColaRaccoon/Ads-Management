import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { ChangeLogsService } from "./change-logs.service";
import { CurrentUser, RequirePermissions } from "../auth/route-decorators";
import { AuthenticatedUser } from "../auth/auth.types";
import {
  ChangeLogDateQueryDto,
  ChangeLogRangeQueryDto,
  CreateChangeLogDto,
  CreateCreativeChangeLogDto,
  CreateProductChangeLogDto,
  CreativeParamDto,
  ProductChangeLogParamDto
} from "./dto/change-log-transport.dto";

@Controller("change-logs")
export class ChangeLogsController {
  constructor(private readonly changeLogsService: ChangeLogsService) {}

  @Get("creatives")
  @RequirePermissions("data.read")
  listCreatives(@Query() query: ChangeLogRangeQueryDto) {
    return this.changeLogsService.listCreatives(query.from, query.to);
  }

  @Get("creatives/:creativeId")
  @RequirePermissions("data.read")
  getCreativeDetail(@Param() params: CreativeParamDto, @Query() query: ChangeLogRangeQueryDto) {
    return this.changeLogsService.getCreativeDetail(params.creativeId, query.from, query.to);
  }

  @Post("creatives/:creativeId/logs")
  @RequirePermissions("change_logs.create")
  createCreativeLog(
    @Param() params: CreativeParamDto,
    @Body() body: CreateCreativeChangeLogDto,
    @CurrentUser() actor: AuthenticatedUser
  ) {
    return this.changeLogsService.createCreativeLog(params.creativeId, body, actor.id);
  }

  @Get("products")
  @RequirePermissions("data.read")
  listProducts(@Query() query: ChangeLogDateQueryDto) {
    return this.changeLogsService.listProducts(query.date);
  }

  @Get("products/:productId")
  @RequirePermissions("data.read")
  getProductDetail(@Param() params: ProductChangeLogParamDto, @Query() query: ChangeLogDateQueryDto) {
    return this.changeLogsService.getProductDetail(params.productId, query.date);
  }

  @Post("products/:productId/logs")
  @RequirePermissions("change_logs.create")
  createProductLog(
    @Param() params: ProductChangeLogParamDto,
    @Body() body: CreateProductChangeLogDto,
    @CurrentUser() actor: AuthenticatedUser
  ) {
    return this.changeLogsService.createProductLog(params.productId, body, actor.id);
  }

  @Get()
  @RequirePermissions("data.read")
  list(@Query() query: ChangeLogRangeQueryDto) {
    return this.changeLogsService.list(query.from, query.to);
  }

  @Post()
  @RequirePermissions("change_logs.create")
  create(@Body() body: CreateChangeLogDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.changeLogsService.create(body, actor.id);
  }
}
