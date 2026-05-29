import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../common/prisma.service";

@Injectable()
export class SettingsService {
  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.appSetting.findMany({ orderBy: { key: "asc" } });
  }

  update(key: string, body: { valueJson?: unknown; description?: string }) {
    return this.prisma.appSetting.upsert({
      where: { key },
      update: {
        valueJson: body.valueJson === undefined ? undefined : (body.valueJson as Prisma.InputJsonValue),
        description: body.description
      },
      create: {
        key,
        valueJson: (body.valueJson ?? {}) as Prisma.InputJsonValue,
        description: body.description
      }
    });
  }

  async getNumber(key: string, fallback: number): Promise<number> {
    const setting = await this.prisma.appSetting.findUnique({ where: { key } });
    const value = Number(setting?.valueJson);
    return Number.isFinite(value) ? value : fallback;
  }
}
