import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaService } from "../common/prisma.service";
import { AUTH_CONFIG, AuthConfig } from "./auth.config";

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const INTERVAL_MS = 6 * 60 * 60 * 1000;

@Injectable()
export class LocalAuthMaintenanceService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly prisma: PrismaService, @Inject(AUTH_CONFIG) private readonly config: AuthConfig) {}

  onModuleInit() {
    if (this.config.provider !== "local") return;
    void this.prune().catch(() => undefined);
    this.timer = setInterval(() => void this.prune().catch(() => undefined), INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async prune(now = new Date()) {
    if (this.config.provider !== "local" || this.running) return;
    this.running = true;
    const retainedUntil = new Date(now.getTime() - RETENTION_MS);
    try {
      await this.prisma.$transaction([
        this.prisma.appAuthSession.deleteMany({
          where: {
            OR: [
              { absoluteExpiresAt: { lt: retainedUntil } },
              { revokedAt: { lt: retainedUntil } }
            ]
          }
        }),
        this.prisma.localAccountSetupToken.deleteMany({
          where: {
            createdAt: { lt: retainedUntil },
            OR: [
              { expiresAt: { lt: now } },
              { usedAt: { not: null } },
              { revokedAt: { not: null } }
            ]
          }
        }),
        this.prisma.securityRateLimitBucket.deleteMany({ where: { expiresAt: { lt: now } } }),
        this.prisma.localEdgeRequestNonce.deleteMany({ where: { expiresAt: { lt: now } } })
      ]);
    } finally {
      this.running = false;
    }
  }
}
