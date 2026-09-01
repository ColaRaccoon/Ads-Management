import { Global, Module } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { PrismaService } from "./prisma.service";
import { HTTP_SECURITY_CONFIG, loadHttpSecurityConfig } from "./http-security.config";
import { HeavyOperationGate } from "./heavy-operation";

@Global()
@Module({
  providers: [
    PrismaService,
    HeavyOperationGate,
    { provide: HTTP_SECURITY_CONFIG, useFactory: () => loadHttpSecurityConfig() },
    { provide: APP_INTERCEPTOR, useExisting: HeavyOperationGate }
  ],
  exports: [PrismaService, HTTP_SECURITY_CONFIG, HeavyOperationGate]
})
export class CommonModule {}
