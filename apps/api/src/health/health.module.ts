import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { HealthController } from "./health.controller";
import { HealthService } from "./health.service";
import { ReportsModule } from "../reports/reports.module";

@Module({
  imports: [AuthModule, ReportsModule],
  controllers: [HealthController],
  providers: [HealthService]
})
export class HealthModule {}
