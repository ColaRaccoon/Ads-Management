import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { Inject, Injectable } from "@nestjs/common";
import { Request } from "express";
import { AUTH_CONFIG, AuthConfig } from "./auth.config";
import { AuthCookieService } from "./cookie.service";
import { authError, rateLimitError } from "./auth.errors";

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
  constructor(
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
    private readonly cookies: AuthCookieService,
    @Inject(SECURITY_RATE_LIMITER) private readonly limiter: SecurityRateLimiter
  ) {}

  async assertLoginRequest(request: Request, normalizedEmail: string) {
    this.assertOrigin(request);
    const fetchSite = request.get("sec-fetch-site");
    if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "same-site") {
      throw authError("ORIGIN_NOT_ALLOWED");
    }
    const address = clientAddress(request);
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
    await this.consumeKey(`auth:invitation:ip:${clientAddress(request)}`, 10, 5 * 60_000);
    await this.consumeKey(`auth:invitation:token:${tokenKey}`, 3, 15 * 60_000);
  }

  async assertCsrfMutation(request: Request, operation: "password" | "users") {
    this.assertMutationOrigin(request);
    await this.consumeKey(`auth:${operation}:${clientAddress(request)}`, 30, 60_000);
    const csrfCookie = parseCookie(request.headers.cookie, this.cookies.csrfCookieName);
    const csrfHeader = request.get("x-csrf-token");
    if (!this.cookies.verifyCsrfToken(csrfCookie, csrfHeader)) throw authError("CSRF_INVALID");
  }

  async assertGeneralRead(request: Request) {
    await this.consumeKey(`http:read:${clientAddress(request)}`, 600, 60_000);
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
      `http:${scope}:${clientAddress(request)}:${identity}`,
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
    await this.consumeKey(`auth:${operation}:${clientAddress(request)}`, 30, 60_000);
    const csrfCookie = parseCookie(request.headers.cookie, this.cookies.csrfCookieName);
    const csrfHeader = request.get("x-csrf-token");
    if (!this.cookies.verifyCsrfToken(csrfCookie, csrfHeader)) throw authError("CSRF_INVALID");
  }

  private assertOrigin(request: Request) {
    const origin = request.get("origin");
    if (!origin || !this.config.allowedOrigins.has(origin)) throw authError("ORIGIN_NOT_ALLOWED");
  }

  private async consumeKey(key: string, limit: number, windowMs: number) {
    const decision = await this.limiter.consume(key, limit, windowMs);
    if (!decision.allowed) {
      throw rateLimitError(decision.retryAfterSeconds);
    }
  }
}

export function clientAddress(request: Request) {
  const address = request.ip || request.socket.remoteAddress || "unknown";
  return normalizeClientAddress(address);
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
