import { Inject, Injectable, Optional } from "@nestjs/common";
import {
  createRemoteJWKSet,
  errors as joseErrors,
  jwtVerify,
  JWTVerifyGetKey
} from "jose";
import { AUTH_CONFIG, AuthConfig } from "./auth.config";
import { authError } from "./auth.errors";
import { VerifiedAccessToken } from "./auth.types";

export const SUPABASE_JWT_KEY_RESOLVER = Symbol("SUPABASE_JWT_KEY_RESOLVER");
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class SupabaseJwtVerifier {
  private readonly keyResolver: JWTVerifyGetKey;

  constructor(
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
    @Optional() @Inject(SUPABASE_JWT_KEY_RESOLVER) keyResolver?: JWTVerifyGetKey
  ) {
    this.keyResolver = keyResolver ?? createRemoteJWKSet(
      new URL(`${config.jwtIssuer}/.well-known/jwks.json`),
      { cacheMaxAge: 10 * 60_000, cooldownDuration: 30_000 }
    );
  }

  async verify(token: string): Promise<VerifiedAccessToken> {
    try {
      const { payload, protectedHeader } = await jwtVerify(token, this.keyResolver, {
        algorithms: ["ES256", "RS256"],
        issuer: this.config.jwtIssuer,
        audience: this.config.jwtAudience,
        requiredClaims: ["exp", "sub", "session_id"]
      });
      if (protectedHeader.typ && protectedHeader.typ !== "JWT") throw authError("SESSION_INVALID");
      if (typeof payload.sub !== "string" || !UUID_PATTERN.test(payload.sub)) {
        throw authError("SESSION_INVALID");
      }
      const sessionId = payload.session_id;
      if (typeof sessionId !== "string" || !UUID_PATTERN.test(sessionId)) {
        throw authError("SESSION_INVALID");
      }
      if (typeof payload.exp !== "number" || !Number.isSafeInteger(payload.exp)) {
        throw authError("SESSION_INVALID");
      }
      return { subject: payload.sub, sessionId, expiresAt: payload.exp };
    } catch (error) {
      if (error instanceof joseErrors.JWTExpired) throw authError("ACCESS_TOKEN_EXPIRED");
      if (isAuthHttpException(error)) throw error;
      if (isJwksUnavailable(error)) throw authError("AUTH_PROVIDER_UNAVAILABLE");
      throw authError("SESSION_INVALID");
    }
  }
}

function isJwksUnavailable(error: unknown) {
  return error instanceof joseErrors.JWKSTimeout ||
    error instanceof joseErrors.JWKSInvalid ||
    error instanceof joseErrors.JWKInvalid ||
    (error instanceof joseErrors.JOSEError &&
      error.constructor === joseErrors.JOSEError &&
      (error.message === "Expected 200 OK from the JSON Web Key Set HTTP response" ||
        error.message === "Failed to parse the JSON Web Key Set HTTP response as JSON")) ||
    (error instanceof TypeError && /fetch|network|socket|connect|timed?\s*out/i.test(error.message));
}

function isAuthHttpException(error: unknown): error is Error & { code: string } {
  return error instanceof Error && "code" in error && error.name === error.code;
}
