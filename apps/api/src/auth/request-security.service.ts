import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { Request } from "express";
import { AUTH_CONFIG, AuthConfig } from "./auth.config";
import { AuthCookieService } from "./cookie.service";
import { authError } from "./auth.errors";

export const SECURITY_RATE_LIMITER = Symbol("SECURITY_RATE_LIMITER");

export interface SecurityRateLimiter {
  consume(key: string, limit: number, windowMs: number): Promise<boolean>;
}

@Injectable()
export class InMemorySecurityRateLimiter implements SecurityRateLimiter {
  private readonly attempts = new Map<string, { timestamps: number[]; maxWindowMs: number }>();
  private static readonly MAX_KEYS = 10_000;

  async consume(key: string, limit: number, windowMs: number) {
    const now = Date.now();
    const stored = this.attempts.get(key);
    const maxWindowMs = Math.max(stored?.maxWindowMs ?? 0, windowMs);
    const retained = (stored?.timestamps ?? []).filter((at) => at > now - maxWindowMs);
    const attemptsInWindow = retained.filter((at) => at > now - windowMs).length;
    if (attemptsInWindow >= limit) return false;
    if (retained.length === 0) this.attempts.delete(key);
    if (!this.attempts.has(key) && this.attempts.size >= InMemorySecurityRateLimiter.MAX_KEYS) {
      for (const [storedKey, bucket] of this.attempts) {
        const live = bucket.timestamps.filter((at) => at > now - bucket.maxWindowMs);
        if (live.length === 0) this.attempts.delete(storedKey);
        else if (live.length !== bucket.timestamps.length) {
          this.attempts.set(storedKey, { ...bucket, timestamps: live });
        }
      }
      if (this.attempts.size >= InMemorySecurityRateLimiter.MAX_KEYS) return false;
    }
    retained.push(now);
    this.attempts.set(key, { timestamps: retained, maxWindowMs });
    return true;
  }
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
    if (!(await this.limiter.consume(key, limit, windowMs))) {
      throw authError("RATE_LIMITED");
    }
  }
}

function clientAddress(request: Request) {
  return request.ip || request.socket.remoteAddress || "unknown";
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
