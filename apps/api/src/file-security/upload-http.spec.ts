import { ConflictException, Controller, Module, Post, UploadedFile, UploadedFiles, UseInterceptors } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ApiExceptionFilter } from "../common/api-exception.filter";
import { SecureCoupangBundlePipe, SecureUploadPipe } from "./secure-upload.pipe";
import { coupangBundleInterceptor, uploadFileInterceptor, type UploadProfile } from "./upload-profiles";
import type { CoupangBundleFiles } from "./upload-preflight";

const HTTP_TEST_CSV_PROFILE: UploadProfile = {
  id: "META_CSV",
  contentKind: "CSV",
  extensions: [".csv"],
  mimeTypes: ["text/csv"],
  maxFileBytes: 1024,
  maxFileBytesEnv: "STEP7_HTTP_TEST_MAX_FILE_BYTES"
};

const previousBundleLimit = process.env.UPLOAD_COUPANG_BUNDLE_MAX_TOTAL_BYTES;
process.env.UPLOAD_COUPANG_BUNDLE_MAX_TOTAL_BYTES = "16384";

@Controller("upload-security-test")
class UploadSecurityTestController {
  static calls = 0;

  @Post("single")
  @UseInterceptors(uploadFileInterceptor(HTTP_TEST_CSV_PROFILE))
  single(@UploadedFile(new SecureUploadPipe(HTTP_TEST_CSV_PROFILE)) file: Express.Multer.File | undefined) {
    UploadSecurityTestController.calls += 1;
    return { size: file?.size ?? 0 };
  }

  @Post("bundle")
  @UseInterceptors(coupangBundleInterceptor())
  bundle(@UploadedFiles(new SecureCoupangBundlePipe()) files: CoupangBundleFiles | undefined) {
    UploadSecurityTestController.calls += 1;
    return { fields: Object.keys(files ?? {}).length };
  }

  @Post("partial")
  partial() {
    throw new ConflictException({
      code: "COUPANG_BUNDLE_PARTIAL_FAILURE",
      message: "The bundle was only partially imported. Retry the complete bundle with SKIP.",
      details: {
        completedFields: ["margin"],
        failedField: "sales",
        retryConflictPolicy: "SKIP",
        filename: "private-sales.xlsx",
        providerMessage: "private provider message"
      }
    });
  }
}

if (previousBundleLimit === undefined) {
  delete process.env.UPLOAD_COUPANG_BUNDLE_MAX_TOTAL_BYTES;
} else {
  process.env.UPLOAD_COUPANG_BUNDLE_MAX_TOTAL_BYTES = previousBundleLimit;
}

@Module({ controllers: [UploadSecurityTestController] })
class UploadSecurityTestModule {}

describe("STEP7-EVAL-001/002 actual Nest multipart response contract", () => {
  let app: Awaited<ReturnType<typeof NestFactory.create>>;
  let baseUrl: string;

  beforeAll(async () => {
    app = await NestFactory.create(UploadSecurityTestModule, { logger: false, abortOnError: false });
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}/upload-security-test`;
  });

  beforeEach(() => {
    UploadSecurityTestController.calls = 0;
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns 413 for the per-file Multer limit before the handler", async () => {
    const response = await postFile(`${baseUrl}/single`, "file", Buffer.alloc(1025, 0x61), "large.csv", "text/csv");
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: "UPLOAD_TOO_LARGE" });
    expect(UploadSecurityTestController.calls).toBe(0);
  });

  it("STEP7-EVAL-001 accepts one byte below and exactly at the configured file limit", async () => {
    const belowLimitCsv = Buffer.from(`a,b\n1,${"x".repeat(1017)}`);
    const exactLimitCsv = Buffer.from(`a,b\n1,${"x".repeat(1018)}`);
    expect(belowLimitCsv).toHaveLength(1023);
    expect(exactLimitCsv).toHaveLength(1024);

    const below = await postFile(`${baseUrl}/single`, "file", belowLimitCsv, "below.csv", "text/csv");
    expect(below.status).toBe(201);
    expect(await below.json()).toEqual({ size: 1023 });

    const exact = await postFile(`${baseUrl}/single`, "file", exactLimitCsv, "exact.csv", "text/csv");
    expect(exact.status).toBe(201);
    expect(await exact.json()).toEqual({ size: 1024 });
    expect(UploadSecurityTestController.calls).toBe(2);
  });

  it("returns 413 for the captured request-total limit before the handler", async () => {
    const response = await postFile(`${baseUrl}/bundle`, "margin", Buffer.alloc(20 * 1024, 0x61), "margin.csv", "text/csv");
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: "UPLOAD_TOTAL_TOO_LARGE" });
    expect(UploadSecurityTestController.calls).toBe(0);
  });

  it("returns 415 for MIME/envelope and content-magic mismatches before the handler", async () => {
    const mime = await postFile(`${baseUrl}/single`, "file", Buffer.from("a,b\n1,2"), "normal.csv", "application/json");
    expect(mime.status).toBe(415);
    expect(await mime.json()).toMatchObject({ code: "UPLOAD_MIME_NOT_ALLOWED" });

    const magic = await postFile(`${baseUrl}/single`, "file", Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x01]), "fake.csv", "text/csv");
    expect(magic.status).toBe(415);
    expect(await magic.json()).toMatchObject({ code: "UPLOAD_CONTENT_MISMATCH" });
    expect(UploadSecurityTestController.calls).toBe(0);
  });

  it("accepts a normal bounded CSV and rejects an empty multipart bundle", async () => {
    const valid = await postFile(`${baseUrl}/single`, "file", Buffer.from("a,b\n1,2"), "normal.csv", "text/csv");
    expect(valid.status).toBe(201);
    expect(UploadSecurityTestController.calls).toBe(1);

    UploadSecurityTestController.calls = 0;
    const empty = await fetch(`${baseUrl}/bundle`, { method: "POST", body: new FormData() });
    expect(empty.status).toBe(400);
    expect(await empty.json()).toMatchObject({ code: "UPLOAD_BUNDLE_EMPTY" });
    expect(UploadSecurityTestController.calls).toBe(0);
  });

  it("STEP7-EVAL-005 rejects a duplicate bundle field before the handler", async () => {
    const body = new FormData();
    appendFile(body, "margin", Buffer.from("name,price\na,1"), "margin-a.csv", "text/csv");
    appendFile(body, "margin", Buffer.from("name,price\nb,2"), "margin-b.csv", "text/csv");

    const response = await fetch(`${baseUrl}/bundle`, { method: "POST", body });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "UPLOAD_MULTIPART_INVALID" });
    expect(UploadSecurityTestController.calls).toBe(0);
  });

  it("STEP7-EVAL-001/005 rejects an excess fourth bundle file before the handler", async () => {
    const body = new FormData();
    appendFile(body, "sales", Buffer.from("not parsed"), "sales.xlsx", "application/octet-stream");
    appendFile(body, "ads", Buffer.from("not parsed"), "ads.xlsx", "application/octet-stream");
    appendFile(body, "margin", Buffer.from("name,price\na,1"), "margin.csv", "text/csv");
    appendFile(body, "unexpected", Buffer.from("name,price\nb,2"), "extra.csv", "text/csv");

    const response = await fetch(`${baseUrl}/bundle`, { method: "POST", body });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "UPLOAD_MULTIPART_INVALID" });
    expect(UploadSecurityTestController.calls).toBe(0);
  });

  it("STEP7-EVAL-005 returns only allowlisted partial-failure metadata over HTTP", async () => {
    const response = await fetch(`${baseUrl}/partial`, { method: "POST" });
    expect(response.status).toBe(409);
    const payload = await response.json();
    expect(payload).toMatchObject({
      code: "COUPANG_BUNDLE_PARTIAL_FAILURE",
      details: { completedFields: ["margin"], failedField: "sales", retryConflictPolicy: "SKIP" }
    });
    expect(JSON.stringify(payload)).not.toMatch(/private-sales|private provider/);
  });
});

async function postFile(url: string, field: string, content: Buffer, filename: string, mimeType: string) {
  const body = new FormData();
  appendFile(body, field, content, filename, mimeType);
  return fetch(url, { method: "POST", body });
}

function appendFile(body: FormData, field: string, content: Buffer, filename: string, mimeType: string) {
  body.append(field, new Blob([new Uint8Array(content)], { type: mimeType }), filename);
}
