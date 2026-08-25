import { Global, Module } from "@nestjs/common";
import { PrismaService } from "./prisma.service";
import { HTTP_SECURITY_CONFIG, loadHttpSecurityConfig } from "./http-security.config";

@Global()
@Module({
  providers: [
    PrismaService,
    { provide: HTTP_SECURITY_CONFIG, useFactory: () => loadHttpSecurityConfig() }
  ],
  exports: [PrismaService, HTTP_SECURITY_CONFIG]
})
export class CommonModule {}
