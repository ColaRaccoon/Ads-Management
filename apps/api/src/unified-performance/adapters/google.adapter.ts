import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../common/prisma.service";
import { UnifiedManagementRepository } from "../management.repository";
import type { AdapterBatch, AdapterRequest, SourceAdapter } from "../types";
import { adPageDate, assertAdScope } from "./ad-source";
import { readAdDay } from "./ad-reader";

@Injectable()
export class GooglePerformanceAdapter implements SourceAdapter {
  readonly platform = "GOOGLE" as const;
  constructor(private readonly prisma: PrismaService, private readonly management: UnifiedManagementRepository) {}
  read(request: Readonly<AdapterRequest>): Promise<AdapterBatch> {
    adPageDate(request, this.platform); assertAdScope(request.scopeKeys[0], this.platform);
    return this.management.read(tx => readAdDay(tx, this.management, request, this.platform));
  }
}
