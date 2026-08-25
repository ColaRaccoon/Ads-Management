import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { Response } from "express";
import multer from "multer";
import { requestIdOf, RequestWithContext, safeLogText } from "./request-context";

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<RequestWithContext>();
    const requestId = requestIdOf(request);
    response.setHeader("X-Request-Id", requestId);

    if ((request.originalUrl ?? request.url ?? "").startsWith("/api/auth/")) {
      response.setHeader("Cache-Control", "private, no-store");
      response.setHeader("Pragma", "no-cache");
    }

    const prismaError =
      exception instanceof Prisma.PrismaClientKnownRequestError
        ? toPrismaHttpError(exception)
        : null;
    const parserError = toBodyParserHttpError(exception) ?? toMulterHttpError(exception);
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : parserError?.status ?? prismaError?.status ?? HttpStatus.INTERNAL_SERVER_ERROR;
    const payload = exception instanceof HttpException ? exception.getResponse() : null;
    const structuredPayload =
      typeof payload === "object" && payload !== null ? payload as Record<string, unknown> : null;
    const multipartRequest = /^multipart\/form-data(?:;|$)/i.test(
      String(request.headers?.["content-type"] ?? "")
    );
    const safeHttp = exception instanceof HttpException
      ? safeHttpPayload(status, structuredPayload, multipartRequest)
      : null;
    const retryAfterSeconds = safeHttp?.code === "RATE_LIMITED"
      ? safeRetryAfter(structuredPayload?.details)
      : null;
    const responseDetails = safeHttp?.code === "COUPANG_BUNDLE_PARTIAL_FAILURE"
      ? safeBundlePartialDetails(structuredPayload?.details)
      : retryAfterSeconds === null
        ? null
        : { retryAfterSeconds };
    if (retryAfterSeconds !== null) {
      response.setHeader("Retry-After", String(retryAfterSeconds));
    }

    if (!safeHttp || status >= 500) {
      this.logger.error(JSON.stringify({
        requestId,
        status,
        code: safeHttp?.code ?? parserError?.code ?? prismaError?.code ?? "INTERNAL_SERVER_ERROR",
        errorType: safeLogText(
          exception instanceof Error ? exception.constructor.name : typeof exception,
          80
        )
      }));
    }

    response.status(status).json({
      code: safeHttp?.code ?? parserError?.code ?? prismaError?.code ?? "INTERNAL_SERVER_ERROR",
      message: safeHttp?.message ?? parserError?.message ?? prismaError?.message ?? "Unexpected server error",
      details: responseDetails,
      requestId
    });
  }
}

function toMulterHttpError(error: unknown) {
  if (!error || typeof error !== "object") return null;
  const candidate = error as { name?: unknown; code?: unknown };
  if (!(error instanceof multer.MulterError) && candidate.name !== "MulterError") return null;
  const code = typeof candidate.code === "string" ? candidate.code : "";
  if (!/^LIMIT_[A-Z_]+$/.test(code)) return null;
  if (code === "LIMIT_FILE_SIZE") {
    return {
      status: HttpStatus.PAYLOAD_TOO_LARGE,
      code: "UPLOAD_TOO_LARGE",
      message: "The uploaded file is too large."
    };
  }
  return {
    status: HttpStatus.BAD_REQUEST,
    code: "UPLOAD_MULTIPART_INVALID",
    message: "The multipart upload is invalid."
  };
}

function toBodyParserHttpError(error: unknown) {
  if (!error || typeof error !== "object") return null;
  const candidate = error as { type?: unknown; status?: unknown; statusCode?: unknown };
  if (
    candidate.type === "entity.too.large" &&
    (candidate.status === HttpStatus.PAYLOAD_TOO_LARGE ||
      candidate.statusCode === HttpStatus.PAYLOAD_TOO_LARGE)
  ) {
    return {
      status: HttpStatus.PAYLOAD_TOO_LARGE,
      code: "PAYLOAD_TOO_LARGE",
      message: "The request payload is too large."
    };
  }
  return null;
}

function safeHttpPayload(status: number, payload: Record<string, unknown> | null, multipartRequest = false) {
  const explicitCode = typeof payload?.code === "string" && /^[A-Z][A-Z0-9_]{0,99}$/.test(payload.code)
    ? payload.code
    : null;
  if (!explicitCode) {
    const fallback = status === 400
      ? multipartRequest
        ? { code: "UPLOAD_MULTIPART_INVALID", message: "The multipart upload is invalid." }
        : { code: "VALIDATION_FAILED", message: "Request validation failed." }
      : status === 413
        ? multipartRequest
          ? { code: "UPLOAD_TOO_LARGE", message: "The uploaded file is too large." }
          : { code: "PAYLOAD_TOO_LARGE", message: "The request payload is too large." }
        : { code: `HTTP_${status}`, message: "The request could not be completed." };
    return {
      code: fallback.code,
      message: fallback.message
    };
  }
  const message = safePublicMessage(payload?.message);
  return {
    code: explicitCode,
    message: message ?? "The request could not be completed."
  };
}

function safePublicMessage(value: unknown) {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return normalized.length > 0 && normalized.length <= 500 ? normalized : null;
}

function safeRetryAfter(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const seconds = (value as Record<string, unknown>).retryAfterSeconds;
  return Number.isInteger(seconds) && Number(seconds) >= 1 && Number(seconds) <= 86_400
    ? Number(seconds)
    : null;
}

function safeBundlePartialDetails(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const allowedFields = new Set(["margin", "sales", "ads"]);
  if (!Array.isArray(candidate.completedFields) || candidate.completedFields.length < 1 || candidate.completedFields.length > 3 ||
      candidate.completedFields.some((field) => typeof field !== "string" || !allowedFields.has(field)) ||
      new Set(candidate.completedFields).size !== candidate.completedFields.length ||
      typeof candidate.failedField !== "string" || !allowedFields.has(candidate.failedField) ||
      candidate.completedFields.includes(candidate.failedField) ||
      candidate.retryConflictPolicy !== "SKIP") {
    return null;
  }
  return {
    completedFields: candidate.completedFields,
    failedField: candidate.failedField,
    retryConflictPolicy: "SKIP"
  };
}

function toPrismaHttpError(error: Prisma.PrismaClientKnownRequestError) {
  if (error.code === "P2002") {
    return {
      status: HttpStatus.CONFLICT,
      code: "UNIQUE_CONSTRAINT",
      message: "이미 같은 고유 값이 존재합니다.",
      details: null
    };
  }

  if (error.code === "P2003") {
    return {
      status: HttpStatus.BAD_REQUEST,
      code: "FOREIGN_KEY_CONSTRAINT",
      message: "연결된 데이터를 찾을 수 없습니다.",
      details: null
    };
  }

  if (error.code === "P2025") {
    return {
      status: HttpStatus.NOT_FOUND,
      code: "RECORD_NOT_FOUND",
      message: "요청한 데이터를 찾을 수 없습니다.",
      details: null
    };
  }

  return {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    code: "DATABASE_ERROR",
    message: "데이터베이스 처리 중 오류가 발생했습니다.",
    details: null
  };
}
