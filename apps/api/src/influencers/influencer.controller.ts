import { Body, Controller, Get, Header, Param, Patch, Post, Query } from "@nestjs/common";
import { RequirePermissions } from "../auth/route-decorators";
import { InfluencerRecordsService } from "./influencer-records.service";
import {
  InfluencerCollaborationId,
  InfluencerCollaborationInput,
  InfluencerCollaborationQuery,
  InfluencerDailyQuery,
  UpdateInfluencerNumberingInput,
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

  @Get("daily")
  @Header("Cache-Control", "private, no-store")
  @RequirePermissions("data.read")
  daily(@Query() query: InfluencerDailyQuery) {
    return this.records.daily(query);
  }

  @Get(":id/creatives")
  @Header("Cache-Control", "private, no-store")
  @RequirePermissions("data.read")
  creatives(@Param() params: InfluencerCollaborationId) {
    return this.records.creatives(params.id);
  }

  @Patch(":id/numbering")
  @RequirePermissions("influencers.numbering")
  numbering(@Param() params: InfluencerCollaborationId, @Body() input: UpdateInfluencerNumberingInput) {
    return this.records.numbering(params.id, input);
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
