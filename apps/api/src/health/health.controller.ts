import { Controller, Get } from "@nestjs/common";
import { InternalProbe, Public } from "../auth/route-decorators";
import { HealthService } from "./health.service";

@Controller("health")
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get("live")
  @Public()
  live() {
    return { status: "live" };
  }

  @Get("ready")
  @InternalProbe()
  async ready() {
    await this.health.assertReady();
    return { status: "ready" };
  }
}
