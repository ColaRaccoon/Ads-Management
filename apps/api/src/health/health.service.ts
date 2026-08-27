import { Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { ConfigService } from "@nestjs/config";
import { AUTH_CONFIG, AuthConfig } from "../auth/auth.config";
import {
  HTTP_SECURITY_CONFIG,
  HttpSecurityConfig
} from "../common/http-security.config";
import { PrismaService } from "../common/prisma.service";
import { configuredFileStorage } from "../storage/configured-file-storage";
import { LocalFileStorage } from "../storage/local-file-storage";

@Injectable()
export class HealthService {
  private databaseProbe: Promise<void> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(AUTH_CONFIG) private readonly auth: AuthConfig,
    @Inject(HTTP_SECURITY_CONFIG) private readonly http: HttpSecurityConfig,
    private readonly config: ConfigService
  ) {}

  async assertReady() {
    if (
      this.http.storageCredentialExpiresAtMs !== null &&
      this.http.storageCredentialExpiresAtMs - Date.now() < 300_000
    ) {
      throw this.notReady();
    }
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
          this.probeDatabase(),
          this.probeIdentityProvider(controller.signal),
          this.probeStorageProvider(controller.signal)
        ]),
        deadline
      ]);
    } catch {
      throw this.notReady();
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
    }
  }

  private probeDatabase() {
    if (this.databaseProbe) return this.databaseProbe;
    const timeoutMs = this.http.databaseReadinessTimeoutMs;
    const probe = this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw(
        Prisma.sql`SELECT set_config('statement_timeout', ${String(timeoutMs)}, true)`
      );
      await transaction.$queryRaw(Prisma.sql`SELECT 1`);
    }, {
      maxWait: timeoutMs,
      timeout: timeoutMs
    });
    this.databaseProbe = probe;
    void probe.finally(() => {
      if (this.databaseProbe === probe) this.databaseProbe = null;
    }).catch(() => undefined);
    return probe;
  }

  private notReady() {
    return new ServiceUnavailableException({
      code: "SERVICE_NOT_READY",
      message: "Service is not ready.",
      details: null
    });
  }

  private async probeIdentityProvider(signal: AbortSignal) {
    if (this.auth.provider === "local") return;
    const response = await fetch(`${this.auth.supabaseUrl}/auth/v1/health`, {
      method: "GET",
      headers: { apikey: this.auth.supabasePublishableKey },
      redirect: "error",
      signal
    });
    if (!response.ok) throw new Error("Identity provider is unavailable.");
  }

  private async probeStorageProvider(signal: AbortSignal) {
    if (this.http.deploymentMode === "local_lan") {
      const minimumFreeBytes = Number(this.config.get<string>("TEMP_STORAGE_BUDGET_BYTES") ?? 104_857_600);
      for (const domain of ["uploads", "reports"] as const) {
        const storage = configuredFileStorage(this.config, domain);
        if (!(storage instanceof LocalFileStorage)) throw new Error("Local storage provider is unavailable.");
        await storage.assertReady(minimumFreeBytes);
      }
      return;
    }
    if (!this.http.storageReadinessKey) return;
    const bucket = this.config.get<string>("SUPABASE_STORAGE_BUCKET")?.trim();
    const token = this.config.get<string>("SUPABASE_STORAGE_ACCESS_TOKEN")?.trim();
    if (!bucket || !token) throw new Error("Storage readiness configuration is unavailable.");
    const objectPath = [bucket, ...this.http.storageReadinessKey.split("/")]
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    const response = await fetch(`${this.auth.supabaseUrl}/storage/v1/object/${objectPath}`, {
      method: "HEAD",
      headers: {
        apikey: this.auth.supabasePublishableKey,
        authorization: `Bearer ${token}`
      },
      redirect: "error",
      signal
    });
    if (!response.ok) throw new Error("Storage provider is unavailable.");
  }
}
