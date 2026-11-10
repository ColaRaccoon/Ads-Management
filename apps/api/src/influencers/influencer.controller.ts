import { Body, Controller, Get, Header, Param, Patch, Post, Query } from "@nestjs/common";
import { RequirePermissions } from "../auth/route-decorators";
import { InfluencerRecordsService } from "./influencer-records.service";
import {
  InfluencerCollaborationId,
  InfluencerCollaborationInput,
  InfluencerCollaborationQuery,
  UpdateInfluencerCollaborationInput
} from "./influencer.dto";

@Controller("storefront/influencers")
export class InfluencerController {
  constructor(private readonly records: InfluencerRecordsService) {}

  @Get()
  @Header("Cache-Control", "private, no-store")
  @RequirePermissions("data.read")
  list(@Query() query: InfluencerCollaborationQuery) {
    return this.records.list(query.page ?? 1);
  }

  @Get(":id/creatives")
  @Header("Cache-Control", "private, no-store")
  @RequirePermissions("data.read")
  creatives(@Param() params: InfluencerCollaborationId) {
    return this.records.creatives(params.id);
  }

  @Post()
  @RequirePermissions("influencers.manage")
  create(@Body() input: InfluencerCollaborationInput) {
    return this.records.create(input);
  }

  @Patch(":id")
  @RequirePermissions("influencers.manage")
  update(@Param() params: InfluencerCollaborationId, @Body() input: UpdateInfluencerCollaborationInput) {
    return this.records.update(params.id, input);
  }
}
