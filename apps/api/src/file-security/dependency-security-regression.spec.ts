import { parse } from "csv-parse/sync";
import type { Request, Response } from "express";
import multer from "multer";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { MetaCsvParser } from "../domain/meta-csv";
import { bundleUploadMulterOptions } from "./upload-profiles";

describe("CSV dependency security regressions", () => {
  // https://github.com/adaltas/node-csv/security/advisories/GHSA-8cw4-87c7-c6xx
  // Grouping is a dependency regression; the application currently uses columns
  // without grouping. No global prototype is mutated by these bounded fixtures.
  it.each(["__proto__", "constructor", "toString"])(
    "groups duplicate %s headers as own data without inherited values",
    (header) => {
      const [row] = parse(`${header},${header},name\nfirst,second,synthetic\n`, {
        columns: true,
        group_columns_by_name: true
      }) as Record<string, unknown>[];

      expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
      expect(Object.prototype.hasOwnProperty.call(row, header)).toBe(true);
      expect(row[header]).toEqual(["first", "second"]);
      expect(row.name).toBe("synthetic");
      expect(Object.prototype.hasOwnProperty.call(row, "0")).toBe(false);
    }
  );

  it("preserves special headers as ordinary data through the actual Meta CSV parser", () => {
    const result = new MetaCsvParser().parseBuffer(
      Buffer.from("__proto__,constructor,광고 세트 이름\nplain,ordinary,합성 광고\n")
    );
    expect(result.headers).toEqual(["__proto__", "constructor", "광고 세트 이름"]);
    expect(Object.getPrototypeOf(result.rows[0])).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(result.rows[0], "__proto__")).toMatchObject({
      value: "plain", enumerable: true
    });
    expect(result.rows[0]["광고 세트 이름"]).toBe("합성 광고");
  });
});

describe("multipart dependency security regressions", () => {
  // https://github.com/expressjs/multer/security/advisories/GHSA-535w-7cp7-47q4
  // Use tiny indices instead of the advisory's maximum sparse-array index.
  it.each(["items[1]", "items[1][label]", "items[0001]"])(
    "rejects bracket field %s through the real upload profile",
    async (name) => {
      const result = await parseMultipart([[name, "synthetic"], ["items[label]", "next"]]);
      expect(result.error).toBeInstanceOf(multer.MulterError);
      expect(result.error).toMatchObject({ code: "LIMIT_FIELD_NESTING", field: name });
      expect(result.body).not.toHaveProperty("items");
    }
  );

  it("still accepts the flat text fields used by upload controllers", async () => {
    const result = await parseMultipart([
      ["conflictPolicy", "SKIP"], ["reportDate", "2026-09-09"]
    ]);
    expect(result.error).toBeUndefined();
    expect(result.body).toEqual({ conflictPolicy: "SKIP", reportDate: "2026-09-09" });
  });
});

function parseMultipart(fields: Array<[string, string]>) {
  const boundary = "bounded-security-regression";
  const payload = fields.map(([name, value]) =>
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
  ).join("") + `--${boundary}--\r\n`;
  const request = new PassThrough() as PassThrough & Request;
  request.headers = {
    "content-type": `multipart/form-data; boundary=${boundary}`,
    "content-length": String(Buffer.byteLength(payload))
  };
  request.method = "POST";
  const profile = bundleUploadMulterOptions({});
  const parser = multer({
    storage: profile.storage,
    limits: profile.limits,
    fileFilter(request, file, callback) {
      if (!profile.fileFilter) return callback(null, true);
      profile.fileFilter(request, file, (error, accepted) => {
        if (error) callback(error);
        else callback(null, accepted);
      });
    }
  }).none();
  return new Promise<{ error: unknown; body: Record<string, unknown> }>((resolve) => {
    parser(request, {} as Response, (error?: unknown) => {
      resolve({ error, body: request.body as Record<string, unknown> });
    });
    request.end(payload);
  });
}
