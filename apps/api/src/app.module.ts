import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { CommonModule } from "./common/common.module";
import { UploadsModule } from "./uploads/uploads.module";
import { ProductsModule } from "./products/products.module";
import { MappingsModule } from "./mappings/mappings.module";
import { MetricsModule } from "./metrics/metrics.module";
import { DecisionsModule } from "./decisions/decisions.module";
import { ReportsModule } from "./reports/reports.module";
import { ChangeLogsModule } from "./change-logs/change-logs.module";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    CommonModule,
    UploadsModule,
    ProductsModule,
    MappingsModule,
    MetricsModule,
    DecisionsModule,
    ReportsModule,
    ChangeLogsModule
  ]
})
export class AppModule {}
