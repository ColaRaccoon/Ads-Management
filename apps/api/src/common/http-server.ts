import { INestApplication } from "@nestjs/common";
import { json, NextFunction, Request, Response, urlencoded } from "express";
import { createHash } from "node:crypto";
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
  app.use(trackRawRequestBodyDigest);
  app.enableCors({
    origin(
      origin: string | undefined,
      callback: (error: Error | null, allow?: boolean) => void
    ) {
      callback(null, origin === undefined || auth.allowedOrigins.has(origin));
    },
    credentials: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Idempotency-Key", "X-CSRF-Token", "X-Request-Id", "X-User-Activity-Age"],
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

export type RawBodyDigestRequest = Request & {
  localRawBodySha256?: string;
  localRawBodyDigestComplete?: boolean;
  localExpectedEdgeBodySha256?: string;
};

export function trackRawRequestBodyDigest(request: RawBodyDigestRequest, _response: Response, next: NextFunction) {
  const hasFramedBody=request.headers["transfer-encoding"]!==undefined||Number(request.headers["content-length"]??"0")>0;
  if(!hasFramedBody){request.localRawBodySha256=createHash("sha256").digest("hex");request.localRawBodyDigestComplete=true;next();return}
  const hash=createHash("sha256");let completed=false;const originalEmit=request.emit.bind(request);
  request.emit=((event:string|symbol,...args:unknown[])=>{
    if(event==="data"&&!completed&&args[0]!==undefined)hash.update(Buffer.isBuffer(args[0])?args[0]:Buffer.from(args[0] as ArrayBuffer));
    if(event==="end"&&!completed){completed=true;request.localRawBodySha256=hash.digest("hex");request.localRawBodyDigestComplete=true}
    return originalEmit(event,...args);
  }) as Request["emit"];
  next();
}
