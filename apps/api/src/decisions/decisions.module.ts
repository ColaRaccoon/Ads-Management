import { Module } from "@nestjs/common";
import { DecisionsController } from "./decisions.controller";
import { DecisionsService } from "./decisions.service";
import { MetricsModule } from "../metrics/metrics.module";

@Module({
  imports: [MetricsModule],
  controllers: [DecisionsController],
  providers: [DecisionsService],
  exports: [DecisionsService]
})
export class DecisionsModule {}
