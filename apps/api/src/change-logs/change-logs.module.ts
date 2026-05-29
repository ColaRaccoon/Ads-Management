import { Module } from "@nestjs/common";
import { ChangeLogsController } from "./change-logs.controller";
import { ChangeLogsService } from "./change-logs.service";

@Module({
  controllers: [ChangeLogsController],
  providers: [ChangeLogsService],
  exports: [ChangeLogsService]
})
export class ChangeLogsModule {}
