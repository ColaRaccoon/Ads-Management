import { Body, Controller, Get, Param, Patch } from "@nestjs/common";
import { SettingsService } from "./settings.service";

@Controller("settings")
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @Get()
  list() {
    return this.settingsService.list();
  }

  @Patch(":key")
  update(@Param("key") key: string, @Body() body: { valueJson?: unknown; description?: string }) {
    return this.settingsService.update(key, body);
  }
}
