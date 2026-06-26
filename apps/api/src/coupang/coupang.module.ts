import { Module } from "@nestjs/common";
import { MulterModule } from "@nestjs/platform-express";
import { CoupangController } from "./coupang.controller";
import { CoupangService } from "./coupang.service";

@Module({
  imports: [MulterModule.register({})],
  controllers: [CoupangController],
  providers: [CoupangService],
  exports: [CoupangService]
})
export class CoupangModule {}
