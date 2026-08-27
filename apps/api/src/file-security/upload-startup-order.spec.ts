import { NestFactory } from "@nestjs/core";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiExceptionFilter } from "../common/api-exception.filter";
import { preloadApiEnvironment } from "../common/environment-preload";

const TEST_ENV = {
  APP_ENV: "development",
  DATABASE_URL: "postgresql://app:password@db.abcdefghijklmnopqrst.supabase.co:5432/dev?schema=dev",
  PORT: "4200",
  STORAGE_PROVIDER: "local",
  UPLOAD_STORAGE_DIR: "./storage/security-dev/uploads",
  REPORT_STORAGE_DIR: "./storage/security-dev/reports",
  SUPABASE_URL: "https://ehnfrrmbkvlsbpvqcvkr.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test-key",
  SUPABASE_SECRET_KEY: "sb_secret_test-key",
  SUPABASE_JWT_ISSUER: "https://ehnfrrmbkvlsbpvqcvkr.supabase.co/auth/v1",
  SUPABASE_JWT_AUDIENCE: "authenticated",
  AUTH_COOKIE_SECURE: "false",
  AUTH_SESSION_HANDLE_SECRET: "4f68a2417e7c4fb7bf0663649c671b91406f6d7986061527f5e84a7894b6e45f",
  AUTH_AUTHORIZATION_VERSION_SECRET: "8b3ca7f1a62e49cd9058d27e183bfa645e71c328f4a09d6be2c7351f680ad942",
  AUTH_CSRF_SECRET: "7c778290a780dd14e507ef0282c50aa5f6ee4d955e13ab76d19714226520ca44",
  APP_ALLOWED_ORIGINS: "http://localhost:3200",
  INTERNAL_PROBE_TOKEN: "aa35e635992217a3295b8690b6c4f01eeb3e6e309ebf9a9e7eb86c42e0f2cf9d"
} as const;

const touchedKeys = new Set<string>();
const originalValues = new Map<string, string | undefined>();

describe.sequential("STEP7-EVAL-001 startup-order upload limits", () => {
  afterEach(() => {
    for (const key of touchedKeys) {
      const value = originalValues.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    touchedKeys.clear();
    originalValues.clear();
    vi.resetModules();
  });

  it("preloads package .env without overriding an existing OS variable", () => {
    const root = temporaryPackageRoot("UPLOAD_META_MAX_FILE_BYTES=1024\nSTARTUP_ORDER_SENTINEL=from-file\n");
    try {
      setEnv("STARTUP_ORDER_SENTINEL", "from-os");
      unsetEnv("UPLOAD_META_MAX_FILE_BYTES");
      expect(preloadApiEnvironment({ packageRoot: root })).toBe(true);
      expect(process.env.STARTUP_ORDER_SENTINEL).toBe("from-os");
      expect(process.env.UPLOAD_META_MAX_FILE_BYTES).toBe("1024");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("applies a lower .env limit while the controller interceptor is evaluated", async () => {
    const root = temporaryPackageRoot("UPLOAD_META_MAX_FILE_BYTES=1024\n");
    unsetEnv("UPLOAD_META_MAX_FILE_BYTES");
    let app: Awaited<ReturnType<typeof NestFactory.create>> | undefined;
    try {
      preloadApiEnvironment({ packageRoot: root });
      vi.resetModules();
      const { StartupUploadTestController, StartupUploadTestModule } =
        await import("./upload-startup-order.fixture");
      StartupUploadTestController.calls = 0;
      app = await NestFactory.create(StartupUploadTestModule, { logger: false, abortOnError: false });
      app.useGlobalFilters(new ApiExceptionFilter());
      await app.listen(0, "127.0.0.1");
      const address = app.getHttpServer().address() as AddressInfo;

      const body = new FormData();
      body.append("file", new Blob([new Uint8Array(Buffer.alloc(1025, 0x61))], { type: "text/csv" }), "bounded.csv");
      const response = await fetch(`http://127.0.0.1:${address.port}/startup-upload-test`, {
        method: "POST",
        body
      });

      expect(response.status).toBe(413);
      expect(await response.json()).toMatchObject({ code: "UPLOAD_TOO_LARGE" });
      expect(StartupUploadTestController.calls).toBe(0);
    } finally {
      if (app) await app.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails AppModule evaluation for an invalid preloaded upload limit without reflecting its value", async () => {
    const invalidValue = "invalid-private-upload-limit";
    const root = temporaryPackageRoot(`UPLOAD_META_MAX_FILE_BYTES=${invalidValue}\n`);
    try {
      for (const [key, value] of Object.entries(TEST_ENV)) setEnv(key, value);
      setEnv("NODE_ENV", "development");
      unsetEnv("UPLOAD_META_MAX_FILE_BYTES");
      preloadApiEnvironment({ packageRoot: root });
      vi.resetModules();

      let startupError: unknown;
      try {
        await import("../app.module");
      } catch (error) {
        startupError = error;
      }
      expect(startupError).toBeInstanceOf(Error);
      expect(String((startupError as Error).message)).toContain("UPLOAD_META_MAX_FILE_BYTES must be an integer");
      expect(String((startupError as Error).message)).not.toContain(invalidValue);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function temporaryPackageRoot(contents: string) {
  const root = mkdtempSync(path.join(tmpdir(), "step7-api-env-"));
  writeFileSync(path.join(root, ".env"), contents, { encoding: "utf8", flag: "wx" });
  return root;
}

function setEnv(key: string, value: string) {
  rememberEnv(key);
  process.env[key] = value;
}

function unsetEnv(key: string) {
  rememberEnv(key);
  delete process.env[key];
}

function rememberEnv(key: string) {
  if (touchedKeys.has(key)) return;
  touchedKeys.add(key);
  originalValues.set(key, process.env[key]);
}
