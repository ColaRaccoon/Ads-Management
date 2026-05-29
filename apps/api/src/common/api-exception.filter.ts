import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { Response } from "express";

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    const prismaError =
      exception instanceof Prisma.PrismaClientKnownRequestError
        ? toPrismaHttpError(exception)
        : null;
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : prismaError?.status ?? HttpStatus.INTERNAL_SERVER_ERROR;
    const payload = exception instanceof HttpException ? exception.getResponse() : null;
    const message =
      typeof payload === "object" && payload !== null && "message" in payload
        ? (payload as { message: unknown }).message
        : prismaError
          ? prismaError.message
        : exception instanceof Error
          ? exception.message
          : "Unexpected server error";

    response.status(status).json({
      code: exception instanceof HttpException ? exception.name : prismaError?.code ?? "INTERNAL_SERVER_ERROR",
      message,
      details: typeof payload === "object" && payload !== null ? payload : prismaError?.details ?? null
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
