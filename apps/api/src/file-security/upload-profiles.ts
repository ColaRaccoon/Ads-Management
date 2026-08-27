import { CallHandler, ExecutionContext, HttpException, mixin, NestInterceptor, Type } from "@nestjs/common";
import { FileFieldsInterceptor, FileInterceptor } from "@nestjs/platform-express";
import type { MulterOptions } from "@nestjs/platform-express/multer/interfaces/multer-options.interface";
import type { Request } from "express";
import multer from "multer";
import { sanitizeUploadedFilename } from "../common/encoding";
import { assertLocalEdgeBodyDigest } from "../auth/request-security.service";

const MIB = 1024 * 1024;
const REQUEST_UPLOAD_STATE = Symbol("request-upload-state");

export type UploadProfileId =
  | "META_CSV"
  | "CAFE24_CSV"
  | "COUPANG_SALES_XLSX"
  | "COUPANG_ADS_XLSX"
  | "COUPANG_MARGIN_TEXT"
  | "COUPANG_PRICE_TEXT"
  | "COUPANG_PROMOTION_XLSX";

export type UploadContentKind = "CSV" | "TEXT" | "XLSX";

export type UploadProfile = {
  id: UploadProfileId;
  contentKind: UploadContentKind;
  extensions: readonly string[];
  mimeTypes: readonly string[];
  maxFileBytes: number;
  maxFileBytesEnv: string;
};

const CSV_MIME_TYPES = [
  "text/csv",
  "application/csv",
  "application/vnd.ms-excel",
  "text/plain",
  "application/octet-stream"
] as const;

const XLSX_MIME_TYPES = [
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/octet-stream"
] as const;

export const UPLOAD_PROFILES: Record<UploadProfileId, UploadProfile> = {
  META_CSV: {
    id: "META_CSV",
    contentKind: "CSV",
    extensions: [".csv"],
    mimeTypes: CSV_MIME_TYPES,
    maxFileBytes: 8 * MIB,
    maxFileBytesEnv: "UPLOAD_META_MAX_FILE_BYTES"
  },
  CAFE24_CSV: {
    id: "CAFE24_CSV",
    contentKind: "CSV",
    extensions: [".csv"],
    mimeTypes: CSV_MIME_TYPES,
    maxFileBytes: 8 * MIB,
    maxFileBytesEnv: "UPLOAD_CAFE24_MAX_FILE_BYTES"
  },
  COUPANG_SALES_XLSX: {
    id: "COUPANG_SALES_XLSX",
    contentKind: "XLSX",
    extensions: [".xlsx"],
    mimeTypes: XLSX_MIME_TYPES,
    maxFileBytes: 24 * MIB,
    maxFileBytesEnv: "UPLOAD_COUPANG_XLSX_MAX_FILE_BYTES"
  },
  COUPANG_ADS_XLSX: {
    id: "COUPANG_ADS_XLSX",
    contentKind: "XLSX",
    extensions: [".xlsx"],
    mimeTypes: XLSX_MIME_TYPES,
    maxFileBytes: 24 * MIB,
    maxFileBytesEnv: "UPLOAD_COUPANG_XLSX_MAX_FILE_BYTES"
  },
  COUPANG_MARGIN_TEXT: {
    id: "COUPANG_MARGIN_TEXT",
    contentKind: "CSV",
    extensions: [".csv", ".tsv"],
    mimeTypes: CSV_MIME_TYPES,
    maxFileBytes: 8 * MIB,
    maxFileBytesEnv: "UPLOAD_COUPANG_TEXT_MAX_FILE_BYTES"
  },
  COUPANG_PRICE_TEXT: {
    id: "COUPANG_PRICE_TEXT",
    contentKind: "TEXT",
    extensions: [".txt", ".csv", ".tsv"],
    mimeTypes: CSV_MIME_TYPES,
    maxFileBytes: 8 * MIB,
    maxFileBytesEnv: "UPLOAD_COUPANG_TEXT_MAX_FILE_BYTES"
  },
  COUPANG_PROMOTION_XLSX: {
    id: "COUPANG_PROMOTION_XLSX",
    contentKind: "XLSX",
    extensions: [".xlsx"],
    mimeTypes: XLSX_MIME_TYPES,
    maxFileBytes: 24 * MIB,
    maxFileBytesEnv: "UPLOAD_COUPANG_XLSX_MAX_FILE_BYTES"
  }
};

export const COUPANG_BUNDLE_FIELDS = {
  sales: UPLOAD_PROFILES.COUPANG_SALES_XLSX,
  ads: UPLOAD_PROFILES.COUPANG_ADS_XLSX,
  margin: UPLOAD_PROFILES.COUPANG_MARGIN_TEXT
} as const;

export const DEFAULT_COUPANG_BUNDLE_MAX_TOTAL_BYTES = 48 * MIB;

export class UploadTransportError extends HttpException {
  readonly code: string;
  readonly publicMessage: string;

  constructor(statusCode: number, code: string, publicMessage: string) {
    super({ code, message: publicMessage }, statusCode);
    this.name = "UploadTransportError";
    this.code = code;
    this.publicMessage = publicMessage;
  }
}

export function uploadFileInterceptor(profile: UploadProfile) {
  return withEdgeBodyBinding(FileInterceptor("file", singleUploadMulterOptions(profile)));
}

export function coupangBundleInterceptor() {
  return withEdgeBodyBinding(FileFieldsInterceptor(
    [
      { name: "sales", maxCount: 1 },
      { name: "ads", maxCount: 1 },
      { name: "margin", maxCount: 1 }
    ],
    bundleUploadMulterOptions()
  ));
}

function withEdgeBodyBinding(BaseInterceptor: Type<NestInterceptor>) {
  class EdgeBodyBoundUploadInterceptor extends BaseInterceptor {
    intercept(context: ExecutionContext, next: CallHandler) {
      return super.intercept(context, {
        handle: () => {
          assertLocalEdgeBodyDigest(context.switchToHttp().getRequest<Request>());
          return next.handle();
        }
      });
    }
  }
  return mixin(EdgeBodyBoundUploadInterceptor);
}

export function singleUploadMulterOptions(
  profile: UploadProfile,
  env: NodeJS.ProcessEnv = process.env
): MulterOptions {
  const maxFileBytes = resolveProfileMaxFileBytes(profile, env);
  return boundedMemoryOptions({
    maxFileBytes,
    maxTotalBytes: maxFileBytes,
    maxFiles: 1,
    allowedProfiles: { file: profile },
    perFieldMaxBytes: { file: maxFileBytes }
  });
}

export function bundleUploadMulterOptions(env: NodeJS.ProcessEnv = process.env): MulterOptions {
  const perFieldMaxBytes = Object.fromEntries(
    Object.entries(COUPANG_BUNDLE_FIELDS).map(([field, profile]) => [field, resolveProfileMaxFileBytes(profile, env)])
  );
  const maxFileBytes = Math.max(...Object.values(perFieldMaxBytes));
  return boundedMemoryOptions({
    maxFileBytes,
    maxTotalBytes: resolveCoupangBundleMaxTotalBytes(env),
    maxFiles: 3,
    allowedProfiles: COUPANG_BUNDLE_FIELDS,
    perFieldMaxBytes
  });
}

export function resolveProfileMaxFileBytes(
  profile: UploadProfile,
  env: NodeJS.ProcessEnv = process.env
) {
  return lowerOnlyLimit(env[profile.maxFileBytesEnv], profile.maxFileBytes, 1024, profile.maxFileBytesEnv);
}

export function resolveCoupangBundleMaxTotalBytes(env: NodeJS.ProcessEnv = process.env) {
  return lowerOnlyLimit(
    env.UPLOAD_COUPANG_BUNDLE_MAX_TOTAL_BYTES,
    DEFAULT_COUPANG_BUNDLE_MAX_TOTAL_BYTES,
    3072,
    "UPLOAD_COUPANG_BUNDLE_MAX_TOTAL_BYTES"
  );
}

function boundedMemoryOptions(input: {
  maxFileBytes: number;
  maxTotalBytes: number;
  maxFiles: number;
  allowedProfiles: Record<string, UploadProfile>;
  perFieldMaxBytes: Record<string, number>;
}): MulterOptions {
  return {
    preservePath: false,
    storage: new AggregateBoundedMemoryStorage(input.maxTotalBytes, input.perFieldMaxBytes),
    limits: {
      fieldNameSize: 64,
      fieldSize: 16 * 1024,
      fields: 10,
      // Busboy marks a stream truncated when it reaches (not only exceeds)
      // fileSize. The storage engine below is the authoritative byte limit and
      // rejects `> max`, so one transport byte preserves exact-limit uploads.
      fileSize: input.maxFileBytes + 1,
      files: input.maxFiles,
      parts: input.maxFiles + 10,
      headerPairs: 100
    },
    fileFilter(_request, file, callback) {
      const profile = input.allowedProfiles[file.fieldname];
      if (!profile) {
        callback(new UploadTransportError(400, "UPLOAD_FIELD_INVALID", "The multipart file field is not allowed."), false);
        return;
      }
      try {
        file.originalname = sanitizeUploadedFilename(file.originalname);
        assertAllowedExtensionAndMime(file, profile);
        callback(null, true);
      } catch (error) {
        callback(error instanceof Error ? error : new Error("Upload envelope validation failed."), false);
      }
    }
  };
}

function assertAllowedExtensionAndMime(
  file: Pick<Express.Multer.File, "originalname" | "mimetype">,
  profile: UploadProfile
) {
  const extension = extensionOf(file.originalname);
  if (!profile.extensions.includes(extension)) {
    throw new UploadTransportError(415, "UPLOAD_EXTENSION_NOT_ALLOWED", "The uploaded file extension is not allowed.");
  }
  const mimeType = String(file.mimetype ?? "").split(";", 1)[0].trim().toLowerCase();
  if (!profile.mimeTypes.includes(mimeType)) {
    throw new UploadTransportError(415, "UPLOAD_MIME_NOT_ALLOWED", "The uploaded file MIME type is not allowed.");
  }
}

function extensionOf(filename: string) {
  const dotIndex = filename.lastIndexOf(".");
  return dotIndex >= 0 ? filename.slice(dotIndex).toLowerCase() : "";
}

function lowerOnlyLimit(raw: string | undefined, hardDefault: number, minimum: number, name: string) {
  if (raw === undefined || raw.trim() === "") {
    return hardDefault;
  }
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(`${name} must be an integer.`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > hardDefault) {
    throw new Error(`${name} must be between ${minimum} and ${hardDefault}.`);
  }
  return parsed;
}

class AggregateBoundedMemoryStorage implements multer.StorageEngine {
  constructor(
    private readonly maxTotalBytes: number,
    private readonly perFieldMaxBytes: Record<string, number>
  ) {}

  _handleFile(
    request: Request,
    file: Express.Multer.File,
    callback: (error?: unknown, info?: Partial<Express.Multer.File>) => void
  ) {
    const requestWithState = request as Request & {
      [REQUEST_UPLOAD_STATE]?: { bytes: number };
    };
    const state = requestWithState[REQUEST_UPLOAD_STATE] ?? { bytes: 0 };
    requestWithState[REQUEST_UPLOAD_STATE] = state;
    const chunks: Buffer[] = [];
    let fileBytes = 0;
    let completed = false;

    const fail = (error: Error) => {
      if (completed) return;
      completed = true;
      chunks.length = 0;
      callback(error);
    };

    file.stream.on("data", (chunk: Buffer | Uint8Array | string) => {
      if (completed) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      fileBytes += buffer.length;
      state.bytes += buffer.length;
      const fieldLimit = this.perFieldMaxBytes[file.fieldname];
      if (!fieldLimit || fileBytes > fieldLimit) {
        fail(new UploadTransportError(413, "UPLOAD_TOO_LARGE", "The uploaded file is too large."));
        return;
      }
      if (state.bytes > this.maxTotalBytes) {
        fail(new UploadTransportError(413, "UPLOAD_TOTAL_TOO_LARGE", "The multipart upload total is too large."));
        return;
      }
      chunks.push(buffer);
    });
    file.stream.once("error", (error) => fail(error));
    file.stream.once("end", () => {
      if (completed) return;
      completed = true;
      callback(null, { buffer: Buffer.concat(chunks, fileBytes), size: fileBytes });
    });
  }

  _removeFile(_request: Request, file: Express.Multer.File, callback: (error: Error | null) => void) {
    delete (file as Partial<Express.Multer.File>).buffer;
    callback(null);
  }
}
