import { createHash, createHmac, verify } from "node:crypto";
import { Prisma } from "@prisma/client";
import { isIP } from "node:net";
import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { Request } from "express";
import { HTTP_SECURITY_CONFIG, HttpSecurityConfig } from "../common/http-security.config";
import { AUTH_CONFIG, AuthConfig } from "./auth.config";
import { AuthCookieService } from "./cookie.service";
import { authError, rateLimitError } from "./auth.errors";
import { PrismaService } from "../common/prisma.service";
import type { RawBodyDigestRequest } from "../common/http-server";

export const SECURITY_RATE_LIMITER = Symbol("SECURITY_RATE_LIMITER");

export type RateLimitDecision = {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
};

export interface SecurityRateLimiter {
  consume(key: string, limit: number, windowMs: number): Promise<RateLimitDecision>;
}

@Injectable()
export class AuthRequestSecurityService {
  private trustedTransportClaims = 0;

  constructor(
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
    private readonly cookies: AuthCookieService,
    @Inject(SECURITY_RATE_LIMITER) private readonly limiter: SecurityRateLimiter,
    @Inject(HTTP_SECURITY_CONFIG) private readonly http: HttpSecurityConfig,
    private readonly prisma: PrismaService
  ) {}

  async assertTrustedTransport(request: Request) {
    if (this.http.deploymentMode !== "local_lan") return;
    const identity = authenticatedLocalEdgeIdentity(request, this.http);
    if (!identity) throw new ForbiddenException({ code: "LOCAL_HTTPS_EDGE_REQUIRED", message: "The local HTTPS edge is required." });
    const bodyRequest=request as RawBodyDigestRequest;
    bodyRequest.localExpectedEdgeBodySha256=identity.bodySha256;
    if(bodyRequest.localRawBodyDigestComplete===true&&bodyRequest.localRawBodySha256!==identity.bodySha256)throw new ForbiddenException({code:"LOCAL_EDGE_BODY_DIGEST_MISMATCH",message:"The local HTTPS edge body binding is invalid."});
    if(bodyRequest.localRawBodyDigestComplete!==true&&!/^multipart\/form-data(?:;|$)/i.test(request.get("content-type")??""))throw new ForbiddenException({code:"LOCAL_EDGE_BODY_DIGEST_INCOMPLETE",message:"The local HTTPS edge body binding is incomplete."});
    const nonceHash = createHash("sha256").update(`local-edge-nonce\0${identity.nonce}\0${identity.bodySha256}`, "utf8").digest("hex");
    try {
      await this.prisma.localEdgeRequestNonce.create({ data: { nonceHash, expiresAt: new Date(identity.timestamp + 30_000) } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ForbiddenException({ code: "LOCAL_EDGE_REQUEST_REPLAYED", message: "The local HTTPS edge request was already used." });
      }
      throw error;
    }
    this.trustedTransportClaims += 1;
    if (this.trustedTransportClaims >= 256) {
      this.trustedTransportClaims = 0;
      await this.prisma.localEdgeRequestNonce.deleteMany({ where: { expiresAt: { lt: new Date() } } }).catch(() => undefined);
    }
  }

  async assertLoginRequest(request: Request, normalizedEmail: string) {
    this.assertOrigin(request);
    const fetchSite = request.get("sec-fetch-site");
    if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "same-site") {
      throw authError("ORIGIN_NOT_ALLOWED");
    }
    const address = clientAddress(request, this.http);
    await this.consumeKey(`auth:login:ip:${address}`, 20, 60_000);
    const accountKey = createHash("sha256").update(normalizedEmail).digest("base64url");
    await this.consumeKey(`auth:login:account:${address}:${accountKey}`, 5, 60_000);
    await this.consumeKey(`auth:login:account-global:${accountKey}`, 10, 5 * 60_000);
  }

  async assertSessionMutation(request: Request, operation: "refresh" | "logout") {
    this.assertMutationOrigin(request);
    await this.assertSessionCsrfAndRate(request, operation);
  }

  async assertInvitationAccept(request: Request, tokenHash: string) {
    this.assertMutationOrigin(request);
    const fetchSite = request.get("sec-fetch-site");
    if (fetchSite !== "same-origin" && fetchSite !== "same-site") {
      throw authError("ORIGIN_NOT_ALLOWED");
    }
    const tokenKey = createHash("sha256").update(tokenHash).digest("base64url");
    await this.consumeKey(`auth:invitation:ip:${clientAddress(request, this.http)}`, 10, 5 * 60_000);
    await this.consumeKey(`auth:invitation:token:${tokenKey}`, 3, 15 * 60_000);
  }

  async assertCsrfMutation(request: Request, operation: "password" | "users") {
    this.assertMutationOrigin(request);
    await this.consumeKey(`auth:${operation}:${clientAddress(request, this.http)}`, 30, 60_000);
    const csrfCookie = parseCookie(request.headers.cookie, this.cookies.csrfCookieName);
    const csrfHeader = request.get("x-csrf-token");
    if (!this.cookies.verifyCsrfToken(csrfCookie, csrfHeader)) throw authError("CSRF_INVALID");
  }

  async assertGeneralRead(request: Request) {
    await this.consumeKey(`http:read:${clientAddress(request, this.http)}`, 600, 60_000);
  }

  async assertGeneralMutation(request: Request, expensive: boolean) {
    this.assertMutationOrigin(request);
    const principal = (request as Request & {
      authenticatedUser?: { id?: string };
    }).authenticatedUser;
    const identity = principal?.id
      ? createHash("sha256").update(principal.id).digest("base64url")
      : "anonymous";
    const scope = expensive ? "expensive" : "mutation";
    const limit = expensive ? 15 : 120;
    const windowMs = expensive ? 5 * 60_000 : 60_000;
    await this.consumeKey(
      `http:${scope}:${clientAddress(request, this.http)}:${identity}`,
      limit,
      windowMs
    );
    const csrfCookie = parseCookie(request.headers.cookie, this.cookies.csrfCookieName);
    const csrfHeader = request.get("x-csrf-token");
    if (!this.cookies.verifyCsrfToken(csrfCookie, csrfHeader)) throw authError("CSRF_INVALID");
  }

  assertMutationOrigin(request: Request) {
    this.assertOrigin(request);
  }

  async assertSessionCsrfAndRate(request: Request, operation: "refresh" | "logout") {
    await this.consumeKey(`auth:${operation}:${clientAddress(request, this.http)}`, 30, 60_000);
    const csrfCookie = parseCookie(request.headers.cookie, this.cookies.csrfCookieName);
    const csrfHeader = request.get("x-csrf-token");
    if (!this.cookies.verifyCsrfToken(csrfCookie, csrfHeader)) throw authError("CSRF_INVALID");
  }

  private assertOrigin(request: Request) {
    const origin = request.get("origin");
    if (!origin || !this.config.allowedOrigins.has(origin)) throw authError("ORIGIN_NOT_ALLOWED");
  }

  private async consumeKey(key: string, limit: number, windowMs: number) {
    const persistedKey = this.config.provider === "local" && this.config.localRateLimitSecret
      ? createHmac("sha256", this.config.localRateLimitSecret)
          .update(`rate-limit\0${key}`, "utf8")
          .digest("base64url")
      : key;
    const decision = await this.limiter.consume(persistedKey, limit, windowMs);
    if (!decision.allowed) {
      throw rateLimitError(decision.retryAfterSeconds);
    }
  }
}

export function clientAddress(
  request: Request,
  http?: Pick<HttpSecurityConfig, "deploymentMode" | "localEdgeProxyPublicKey">
) {
  const edgeIdentity = authenticatedLocalEdgeIdentity(request, http);
  if (http?.deploymentMode === "local_lan") return edgeIdentity?.address ?? "unknown";
  const address = request.ip || request.socket.remoteAddress || "unknown";
  return normalizeClientAddress(address);
}

function authenticatedLocalEdgeIdentity(
  request: Request,
  http: Pick<HttpSecurityConfig, "deploymentMode" | "localEdgeProxyPublicKey"> | undefined
) {
  if (http?.deploymentMode !== "local_lan" || !http.localEdgeProxyPublicKey) return null;
  const remote = normalizeClientAddress(request.socket.remoteAddress ?? "unknown");
  if (remote !== "127.0.0.1" && remote !== "::1") return null;
  const address = request.get("x-local-client-ip");
  const timestamp = request.get("x-local-edge-timestamp");
  const nonce = request.get("x-local-edge-nonce");
  const target = request.get("x-local-edge-target");
  const bodySha256 = request.get("x-local-edge-body-sha256");
  const signature = request.get("x-local-edge-signature");
  if (!address || !timestamp || !nonce || !target || !bodySha256 || !signature || !/^\d{13}$/.test(timestamp) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(nonce) ||
      !/^[0-9a-f]{64}$/.test(bodySha256) ||
      target.length > 8192 || !target.startsWith("/api/") || /[\r\n\0]/.test(target) ||
      !/^[A-Za-z0-9_-]{80,128}$/.test(signature)) return null;
  const normalized = normalizeClientAddress(address);
  const actualTarget = String(request.originalUrl ?? request.url ?? "");
  if (normalized === "unknown" || target !== actualTarget || Math.abs(Date.now() - Number(timestamp)) > 30_000) return null;
  const bodyRequest=request as RawBodyDigestRequest;
  if(bodyRequest.localRawBodyDigestComplete===true&&bodyRequest.localRawBodySha256!==bodySha256)return null;
  const message = Buffer.from(`${normalized}\0${timestamp}\0${nonce}\0${request.method.toUpperCase()}\0${target}\0${bodySha256}`, "utf8");
  try {
    return verify(null, message, http.localEdgeProxyPublicKey, Buffer.from(signature, "base64url"))
      ? { address: normalized, nonce, timestamp: Number(timestamp), bodySha256 }
      : null;
  } catch { return null; }
}

export function assertLocalEdgeBodyDigest(request: Request) {
  const bodyRequest=request as RawBodyDigestRequest;
  if(!bodyRequest.localExpectedEdgeBodySha256)return;
  if(bodyRequest.localRawBodyDigestComplete!==true||bodyRequest.localRawBodySha256!==bodyRequest.localExpectedEdgeBodySha256){
    throw new ForbiddenException({code:"LOCAL_EDGE_BODY_DIGEST_MISMATCH",message:"The local HTTPS edge body binding is invalid."});
  }
}

export function normalizeClientAddress(value: string) {
  const address = value.trim();
  const family = isIP(address);
  if (family === 4) {
    return address.split(".").map((octet) => String(Number(octet))).join(".");
  }
  if (family === 6) {
    const hostname = new URL(`http://[${address}]/`).hostname;
    return hostname.slice(1, -1).toLowerCase();
  }
  return "unknown";
}

function parseCookie(header: string | undefined, name: string) {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}
