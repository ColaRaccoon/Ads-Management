import { Controller, Get } from "@nestjs/common";
import { InternalProbe, Public } from "../auth/route-decorators";
import { HealthService } from "./health.service";

@Controller("health")
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get("live")
  @Public()
  live() {
    return { status: "live", releaseId: process.env.LOCAL_RELEASE_ID ?? null };
  }

  @Get("ready")
  @InternalProbe()
  async ready() {
    await this.health.assertReady();
    return { status: "ready" };
  }
}
