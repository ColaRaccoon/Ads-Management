import { Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AUTH_CONFIG, AuthConfig } from "../auth/auth.config";
import {
  HTTP_SECURITY_CONFIG,
  HttpSecurityConfig
} from "../common/http-security.config";
import { PrismaService } from "../common/prisma.service";

@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(AUTH_CONFIG) private readonly auth: AuthConfig,
    @Inject(HTTP_SECURITY_CONFIG) private readonly http: HttpSecurityConfig
  ) {}

  async assertReady() {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("Readiness deadline exceeded."));
      }, this.http.readinessTimeoutMs);
    });
    try {
      await Promise.race([
        Promise.all([
          this.prisma.$queryRaw(Prisma.sql`SELECT 1`),
          this.probeIdentityProvider(controller.signal)
        ]),
        deadline
      ]);
    } catch {
      throw new ServiceUnavailableException({
        code: "SERVICE_NOT_READY",
        message: "Service is not ready.",
        details: null
      });
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
    }
  }

  private async probeIdentityProvider(signal: AbortSignal) {
    const response = await fetch(`${this.auth.supabaseUrl}/auth/v1/health`, {
      method: "GET",
      headers: { apikey: this.auth.supabasePublishableKey },
      redirect: "error",
      signal
    });
    if (!response.ok) throw new Error("Identity provider is unavailable.");
  }
}
