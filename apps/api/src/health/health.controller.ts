import { Controller, Get, Inject } from "@nestjs/common";
import { InternalProbe, Public } from "../auth/route-decorators";
import { HTTP_SECURITY_CONFIG, HttpSecurityConfig } from "../common/http-security.config";
import { HealthService } from "./health.service";

@Controller("health")
export class HealthController {
  constructor(
    private readonly health: HealthService,
    @Inject(HTTP_SECURITY_CONFIG) private readonly http: HttpSecurityConfig
  ) {}

  @Get("live")
  @Public()
  live() {
    return { status: "live" };
  }

  @Get("ready")
  @InternalProbe()
  async ready() {
    await this.health.assertReady();
    return {
      status: "ready",
      releaseId: this.http.releaseId,
      runtimeConfigFingerprint: this.http.runtimeConfigFingerprint
    };
  }
}
