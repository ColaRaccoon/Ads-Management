import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { Request, Response } from "express";
import { AUTH_CONFIG, AuthConfig } from "./auth.config";

const ACCESS_COOKIE = "meta_access";
const REFRESH_COOKIE = "meta_refresh";
const SESSION_COOKIE = "meta_session";
const CSRF_COOKIE = "meta_csrf";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

@Injectable()
export class AuthCookieService {
  constructor(@Inject(AUTH_CONFIG) private readonly config: AuthConfig) {}

  get accessCookieName() { return this.name(ACCESS_COOKIE); }
  get refreshCookieName() { return this.name(REFRESH_COOKIE); }
  get sessionCookieName() { return this.name(SESSION_COOKIE); }
  get csrfCookieName() { return this.name(CSRF_COOKIE); }

  readAccessToken(request: Request) {
    return this.read(request, this.accessCookieName);
  }

  readRefreshToken(request: Request) {
    return this.read(request, this.refreshCookieName);
  }

  readSessionHandle(request: Request) {
    return this.read(request, this.sessionCookieName);
  }

  setAuthenticatedCookies(
    response: Response,
    values: { accessToken: string; refreshToken: string; sessionId: string; expiresIn: number }
  ) {
    const base = this.baseOptions(true);
    response.cookie(this.accessCookieName, values.accessToken, {
      ...base,
      maxAge: Math.max(1, values.expiresIn) * 1000
    });
    response.cookie(this.refreshCookieName, values.refreshToken, { ...base, maxAge: SESSION_TTL_MS });
    response.cookie(this.sessionCookieName, this.signSessionHandle(values.sessionId), {
      ...base,
      maxAge: SESSION_TTL_MS
    });
    this.issueCsrfCookie(response);
  }

  setRefreshCookie(response: Response, refreshToken: string) {
    response.cookie(this.refreshCookieName, refreshToken, {
      ...this.baseOptions(true),
      maxAge: SESSION_TTL_MS
    });
  }

  issueCsrfCookie(response: Response) {
    const issuedAt = Math.floor(Date.now() / 1000).toString(10);
    const nonce = randomBytes(32).toString("base64url");
    const value = `${issuedAt}.${nonce}`;
    const token = `${value}.${this.mac("csrf", value, this.config.csrfSecret)}`;
    response.cookie(this.csrfCookieName, token, {
      ...this.baseOptions(false),
      maxAge: this.config.csrfTtlMs
    });
    return token;
  }

  clearAuthenticationCookies(response: Response) {
    response.clearCookie(this.accessCookieName, this.baseOptions(true));
    response.clearCookie(this.refreshCookieName, this.baseOptions(true));
    response.clearCookie(this.sessionCookieName, this.baseOptions(true));
    response.clearCookie(this.csrfCookieName, this.baseOptions(false));
  }

  verifySessionHandle(handle: string | undefined) {
    if (!handle || handle.length > 256) return null;
    const [sessionId, signature, extra] = handle.split(".");
    if (!sessionId || !signature || extra || !isUuid(sessionId)) return null;
    const expected = this.mac("session", sessionId, this.config.sessionHandleSecret);
    return safeEqual(signature, expected) ? sessionId : null;
  }

  verifyCsrfToken(cookie: string | undefined, header: string | undefined) {
    if (!cookie || !header || !safeEqual(cookie, header) || cookie.length > 256) return false;
    const [issuedAtText, nonce, signature, extra] = cookie.split(".");
    if (!issuedAtText || !nonce || !signature || extra || !/^\d{10}$/.test(issuedAtText)) return false;
    const issuedAtMs = Number(issuedAtText) * 1000;
    const ageMs = Date.now() - issuedAtMs;
    if (!Number.isSafeInteger(issuedAtMs) || ageMs < -30_000 || ageMs > this.config.csrfTtlMs) {
      return false;
    }
    const expected = this.mac("csrf", `${issuedAtText}.${nonce}`, this.config.csrfSecret);
    return safeEqual(signature, expected);
  }

  authorizationVersion(appUserId: string, version: number) {
    return this.mac("authz", `${appUserId}:${version}`, this.config.sessionHandleSecret);
  }

  private signSessionHandle(sessionId: string) {
    return `${sessionId}.${this.mac("session", sessionId, this.config.sessionHandleSecret)}`;
  }

  private read(request: Request, name: string) {
    return parseCookieHeader(request.headers.cookie)[name];
  }

  private name(baseName: string) {
    return this.config.production ? `__Host-${baseName}` : baseName;
  }

  private baseOptions(httpOnly: boolean) {
    return {
      httpOnly,
      secure: this.config.cookieSecure,
      sameSite: "lax" as const,
      path: "/"
    };
  }

  private mac(purpose: string, value: string, secret: string) {
    return createHmac("sha256", secret).update(`${purpose}\0${value}`, "utf8").digest("base64url");
  }
}

export function parseCookieHeader(header: string | undefined) {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      continue;
    }
  }
  return cookies;
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
