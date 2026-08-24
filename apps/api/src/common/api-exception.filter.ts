import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { Response } from "express";

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<{ originalUrl?: string; url?: string }>();

    if ((request.originalUrl ?? request.url ?? "").startsWith("/api/auth/")) {
      response.setHeader("Cache-Control", "private, no-store");
      response.setHeader("Pragma", "no-cache");
    }

    const prismaError =
      exception instanceof Prisma.PrismaClientKnownRequestError
        ? toPrismaHttpError(exception)
        : null;
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : prismaError?.status ?? HttpStatus.INTERNAL_SERVER_ERROR;
    const payload = exception instanceof HttpException ? exception.getResponse() : null;
    const structuredPayload =
      typeof payload === "object" && payload !== null ? payload as Record<string, unknown> : null;
    const message =
      structuredPayload && "message" in structuredPayload
        ? structuredPayload.message
        : prismaError
          ? prismaError.message
        : exception instanceof Error
          ? exception.message
          : "Unexpected server error";

    response.status(status).json({
      code:
        exception instanceof HttpException
          ? typeof structuredPayload?.code === "string"
            ? structuredPayload.code
            : exception.name
          : prismaError?.code ?? "INTERNAL_SERVER_ERROR",
      message,
      details:
        exception instanceof HttpException
          ? structuredPayload && "details" in structuredPayload
            ? structuredPayload.details
            : structuredPayload
          : prismaError?.details ?? null
    });
  }
}

function toPrismaHttpError(error: Prisma.PrismaClientKnownRequestError) {
  if (error.code === "P2002") {
    return {
      status: HttpStatus.CONFLICT,
      code: "UNIQUE_CONSTRAINT",
      message: "이미 같은 고유 값이 존재합니다.",
      details: { prismaCode: error.code, target: error.meta?.target ?? null }
    };
  }

  if (error.code === "P2003") {
    return {
      status: HttpStatus.BAD_REQUEST,
      code: "FOREIGN_KEY_CONSTRAINT",
      message: "연결된 데이터를 찾을 수 없습니다.",
      details: { prismaCode: error.code, field: error.meta?.field_name ?? null }
    };
  }

  if (error.code === "P2025") {
    return {
      status: HttpStatus.NOT_FOUND,
      code: "RECORD_NOT_FOUND",
      message: "요청한 데이터를 찾을 수 없습니다.",
      details: { prismaCode: error.code }
    };
  }

  return {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    code: "DATABASE_ERROR",
    message: "데이터베이스 처리 중 오류가 발생했습니다.",
    details: { prismaCode: error.code, meta: error.meta ?? null }
  };
}
