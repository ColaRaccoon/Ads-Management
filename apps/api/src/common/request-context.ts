import { randomUUID } from "node:crypto";
import { Logger, NestMiddleware } from "@nestjs/common";
import { NextFunction, Request, Response } from "express";

export type RequestWithContext = Request & { requestId?: string };

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export class RequestContextMiddleware implements NestMiddleware {
  private readonly logger = new Logger("HttpRequest");

  use(request: RequestWithContext, response: Response, next: NextFunction) {
    const received = request.get("x-request-id");
    const requestId = received && REQUEST_ID_PATTERN.test(received) ? received : randomUUID();
    request.requestId = requestId;
    response.setHeader("X-Request-Id", requestId);

    // This API is cookie-authenticated. Keeping every response private/no-store
    // prevents shared caches from retaining user-specific data or Set-Cookie.
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("Pragma", "no-cache");

    const started = process.hrtime.bigint();
    response.once("finish", () => {
      const path = pathWithoutQuery(request.originalUrl || request.url);
      if (!shouldLogRequestCompletion(path, response.statusCode)) return;
      const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
      this.logger.log(JSON.stringify({
        requestId,
        method: safeLogText(request.method, 12),
        path: safeLogText(path, 256),
        status: response.statusCode,
        durationMs: Math.round(durationMs)
      }));
    });
    next();
  }
}

export function requestIdOf(request: RequestWithContext | undefined) {
  return request?.requestId && REQUEST_ID_PATTERN.test(request.requestId)
    ? request.requestId
    : randomUUID();
}

export function safeLogText(value: unknown, maximum = 500) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, maximum);
}

export function shouldLogRequestCompletion(path: string, status: number) {
  const successfulHealthProbe = status >= 200 && status < 400 &&
    (path === "/api/health/live" || path === "/api/health/ready");
  return !successfulHealthProbe;
}

function pathWithoutQuery(value: string) {
  return value.split("?", 1)[0];
}
