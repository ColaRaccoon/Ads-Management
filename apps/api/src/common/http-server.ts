import { INestApplication } from "@nestjs/common";
import { json, NextFunction, Request, Response, urlencoded } from "express";
import helmet from "helmet";
import { AuthConfig } from "../auth/auth.config";
import { HttpSecurityConfig } from "./http-security.config";
import { RequestContextMiddleware } from "./request-context";

/**
 * Call before listen(). NestFactory should use { bodyParser: false } so these
 * bounded parsers are the only JSON/urlencoded parsers in the chain.
 */
export function configureHttpServer(
  app: INestApplication,
  auth: AuthConfig,
  http: HttpSecurityConfig
) {
  const express = app.getHttpAdapter().getInstance();
  express.disable("x-powered-by");
  express.set("trust proxy", http.trustProxyHops === 0 ? false : http.trustProxyHops);

  const requestContext = new RequestContextMiddleware();
  app.use(requestContext.use.bind(requestContext));
  app.enableCors({
    origin(
      origin: string | undefined,
      callback: (error: Error | null, allow?: boolean) => void
    ) {
      callback(null, origin === undefined || auth.allowedOrigins.has(origin));
    },
    credentials: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Idempotency-Key", "X-CSRF-Token", "X-Request-Id"],
    exposedHeaders: ["Retry-After", "X-Request-Id"],
    maxAge: 600
  });
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"]
      }
    },
    crossOriginResourcePolicy: { policy: "same-site" },
    hsts: http.production
      ? { maxAge: 31_536_000, includeSubDomains: true, preload: false }
      : false,
    referrerPolicy: { policy: "no-referrer" }
  }));
  app.use((_request: Request, response: Response, next: NextFunction) => {
    response.setHeader(
      "Permissions-Policy",
      "camera=(), geolocation=(), microphone=(), payment=(), usb=()"
    );
    next();
  });
  app.use(json({ limit: http.jsonBodyLimitBytes, strict: true }));
  app.use(urlencoded({
    limit: http.urlencodedBodyLimitBytes,
    extended: false,
    parameterLimit: 100
  }));
}
