import {
  CanActivate,
  CallHandler,
  Controller,
  ExecutionContext,
  Injectable,
  Module,
  NestInterceptor,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors
} from "@nestjs/common";
import { APP_INTERCEPTOR, NestFactory } from "@nestjs/core";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiExceptionFilter } from "./api-exception.filter";
import { HTTP_SECURITY_CONFIG, HttpSecurityConfig } from "./http-security.config";
import { HeavyOperation, HeavyOperationGate } from "./heavy-operation";
import { UPLOAD_PROFILES, uploadFileInterceptor } from "../file-security/upload-profiles";

@Injectable()
class SyntheticAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    return context.switchToHttp().getRequest<{ headers: Record<string, string> }>()
      .headers.authorization === "Bearer allowed";
  }
}

@Injectable()
class TransportCounterInterceptor implements NestInterceptor {
  static calls = 0;
  intercept(_context: ExecutionContext, next: CallHandler) {
    TransportCounterInterceptor.calls += 1;
    return next.handle();
  }
}

@Controller("heavy-upload-test")
class HeavyUploadTestController {
  static calls = 0;
  static wait: Promise<void> = Promise.resolve();

  @Post()
  @HeavyOperation()
  @UseGuards(SyntheticAuthGuard)
  @UseInterceptors(TransportCounterInterceptor, uploadFileInterceptor(UPLOAD_PROFILES.META_CSV))
  async upload(@UploadedFile() _file: Express.Multer.File) {
    HeavyUploadTestController.calls += 1;
    await HeavyUploadTestController.wait;
    return { accepted: true };
  }
}

@Module({
  controllers: [HeavyUploadTestController],
  providers: [
    SyntheticAuthGuard,
    TransportCounterInterceptor,
    HeavyOperationGate,
    {
      provide: HTTP_SECURITY_CONFIG,
      useValue: {
        heavyOperationConcurrency: 1,
        heavyOperationRetryAfterSeconds: 9
      } as HttpSecurityConfig
    },
    { provide: APP_INTERCEPTOR, useExisting: HeavyOperationGate }
  ]
})
class HeavyUploadTestModule {}

describe.sequential("heavy operation HTTP ordering", () => {
  let app: Awaited<ReturnType<typeof NestFactory.create>> | undefined;

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
    vi.restoreAllMocks();
  });

  it("runs guards first and rejects a second multipart request before route upload interceptors", async () => {
    let release!: () => void;
    HeavyUploadTestController.wait = new Promise<void>((resolve) => { release = resolve; });
    HeavyUploadTestController.calls = 0;
    TransportCounterInterceptor.calls = 0;
    app = await NestFactory.create(HeavyUploadTestModule, { logger: false, abortOnError: false });
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address() as AddressInfo;
    const url = `http://127.0.0.1:${address.port}/heavy-upload-test`;

    const first = fetch(url, uploadRequest(true));
    await Promise.race([
      vi.waitFor(() => expect(HeavyUploadTestController.calls).toBe(1), { timeout: 5_000 }),
      first.then(async (response) => {
        throw new Error(`first heavy request ended early: ${response.status} ${await response.text()}`);
      })
    ]);
    expect(TransportCounterInterceptor.calls).toBe(1);

    const busy = await fetch(url, uploadRequest(true));
    expect(busy.status).toBe(503);
    expect(busy.headers.get("retry-after")).toBe("9");
    expect(await busy.json()).toMatchObject({ code: "HEAVY_OPERATION_BUSY" });
    expect(TransportCounterInterceptor.calls).toBe(1);
    expect(HeavyUploadTestController.calls).toBe(1);

    const forbidden = await fetch(url, uploadRequest(false));
    expect(forbidden.status).toBe(403);
    expect(TransportCounterInterceptor.calls).toBe(1);

    release();
    expect((await first).status).toBe(201);
    const afterRelease = await fetch(url, uploadRequest(true));
    expect(afterRelease.status).toBe(201);
    expect(TransportCounterInterceptor.calls).toBe(2);
    expect(HeavyUploadTestController.calls).toBe(2);
  });
});

function uploadRequest(authenticated: boolean): RequestInit {
  const body = new FormData();
  body.append("file", new Blob(["date,spend\n2026-08-01,1\n"], { type: "text/csv" }), "bounded.csv");
  return {
    method: "POST",
    headers: authenticated ? { authorization: "Bearer allowed" } : undefined,
    body
  };
}
