import { HttpException, HttpStatus } from "@nestjs/common";

export type AuthErrorCode =
  | "AUTHENTICATION_REQUIRED"
  | "SESSION_INVALID"
  | "ACCESS_TOKEN_EXPIRED"
  | "SESSION_REVOKED"
  | "INVALID_CREDENTIALS"
  | "ACCOUNT_NOT_PROVISIONED"
  | "ACCOUNT_INACTIVE"
  | "ACCOUNT_ONBOARDING_REQUIRED"
  | "PERMISSION_DENIED"
  | "AUTH_PROVIDER_UNAVAILABLE"
  | "REFRESH_RACE_RETRY"
  | "ORIGIN_NOT_ALLOWED"
  | "CSRF_INVALID"
  | "RATE_LIMITED";

const messages: Record<AuthErrorCode, string> = {
  AUTHENTICATION_REQUIRED: "Authentication is required.",
  SESSION_INVALID: "The session is invalid.",
  ACCESS_TOKEN_EXPIRED: "The access token has expired.",
  SESSION_REVOKED: "The session has been revoked.",
  INVALID_CREDENTIALS: "The username or password is invalid.",
  ACCOUNT_NOT_PROVISIONED: "The account is not provisioned.",
  ACCOUNT_INACTIVE: "The account is inactive.",
  ACCOUNT_ONBOARDING_REQUIRED: "Account onboarding must be completed.",
  PERMISSION_DENIED: "Permission is denied.",
  AUTH_PROVIDER_UNAVAILABLE: "The authentication provider is temporarily unavailable.",
  REFRESH_RACE_RETRY: "Another refresh completed first. Synchronize and retry once.",
  ORIGIN_NOT_ALLOWED: "The request origin is not allowed.",
  CSRF_INVALID: "The CSRF token is invalid.",
  RATE_LIMITED: "Too many requests. Try again later."
};

export class AuthHttpException extends HttpException {
  constructor(
    readonly code: AuthErrorCode,
    status: HttpStatus,
    details: Record<string, unknown> | null = null
  ) {
    super({ code, message: messages[code], details }, status);
    this.name = code;
  }
}

export function rateLimitError(retryAfterSeconds: number) {
  return new AuthHttpException("RATE_LIMITED", HttpStatus.TOO_MANY_REQUESTS, {
    retryAfterSeconds: Math.max(1, Math.ceil(retryAfterSeconds))
  });
}

export function authError(code: AuthErrorCode) {
  const status: Record<AuthErrorCode, HttpStatus> = {
    AUTHENTICATION_REQUIRED: HttpStatus.UNAUTHORIZED,
    SESSION_INVALID: HttpStatus.UNAUTHORIZED,
    ACCESS_TOKEN_EXPIRED: HttpStatus.UNAUTHORIZED,
    SESSION_REVOKED: HttpStatus.UNAUTHORIZED,
    INVALID_CREDENTIALS: HttpStatus.UNAUTHORIZED,
    ACCOUNT_NOT_PROVISIONED: HttpStatus.FORBIDDEN,
    ACCOUNT_INACTIVE: HttpStatus.FORBIDDEN,
    ACCOUNT_ONBOARDING_REQUIRED: HttpStatus.FORBIDDEN,
    PERMISSION_DENIED: HttpStatus.FORBIDDEN,
    AUTH_PROVIDER_UNAVAILABLE: HttpStatus.SERVICE_UNAVAILABLE,
    REFRESH_RACE_RETRY: HttpStatus.CONFLICT,
    ORIGIN_NOT_ALLOWED: HttpStatus.FORBIDDEN,
    CSRF_INVALID: HttpStatus.FORBIDDEN,
    RATE_LIMITED: HttpStatus.TOO_MANY_REQUESTS
  };
  return new AuthHttpException(code, status[code]);
}
