import { Module } from "@nestjs/common";
import { CoupangController } from "./coupang.controller";
import { CoupangService } from "./coupang.service";

@Module({
  controllers: [CoupangController],
  providers: [CoupangService],
  exports: [CoupangService]
})
export class CoupangModule {}
