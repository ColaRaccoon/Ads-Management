import { Global, Module } from "@nestjs/common";
import { CommonModule } from "../common/common.module";
import { SecurityAuditController } from "./security-audit.controller";
import { SecurityAuditService } from "./security-audit.service";

@Global()
@Module({
  imports: [CommonModule],
  controllers: [SecurityAuditController],
  providers: [SecurityAuditService],
  exports: [SecurityAuditService]
})
export class SecurityAuditModule {}
