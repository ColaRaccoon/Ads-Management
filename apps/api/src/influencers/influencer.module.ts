import { Module } from "@nestjs/common";
import { InfluencerController } from "./influencer.controller";
import { InfluencerRecordsService } from "./influencer-records.service";
import { InfluencerWorkerService } from "./influencer-worker.service";

@Module({
  controllers: [InfluencerController],
  providers: [InfluencerRecordsService, InfluencerWorkerService]
})
export class InfluencerModule {}
