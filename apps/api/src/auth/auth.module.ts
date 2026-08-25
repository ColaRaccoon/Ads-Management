import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { CommonModule } from "../common/common.module";
import { AuthController } from "./auth.controller";
import { AUTH_CONFIG, loadAuthConfig } from "./auth.config";
import { AuthService } from "./auth.service";
import { AuthenticationGuard } from "./authentication.guard";
import { PermissionGuard } from "./permission.guard";
import { AuthCookieService } from "./cookie.service";
import { IDENTITY_PROVIDER } from "./identity-provider";
import {
  AuthRequestSecurityService,
  SECURITY_RATE_LIMITER
} from "./request-security.service";
import { SupabaseAuthAdapter } from "./supabase-auth.adapter";
import { SupabaseJwtVerifier } from "./supabase-jwt.verifier";
import { PostgresSecurityRateLimiter } from "./postgres-security-rate-limiter";
import { InternalProbeGuard } from "./internal-probe.guard";
import { HttpSecurityGuard } from "./http-security.guard";

@Module({
  imports: [CommonModule],
  controllers: [AuthController],
  providers: [
    { provide: AUTH_CONFIG, useFactory: () => loadAuthConfig() },
    SupabaseAuthAdapter,
    { provide: IDENTITY_PROVIDER, useExisting: SupabaseAuthAdapter },
    PostgresSecurityRateLimiter,
    { provide: SECURITY_RATE_LIMITER, useExisting: PostgresSecurityRateLimiter },
    SupabaseJwtVerifier,
    AuthCookieService,
    AuthRequestSecurityService,
    AuthService,
    AuthenticationGuard,
    InternalProbeGuard,
    PermissionGuard,
    HttpSecurityGuard,
    { provide: APP_GUARD, useExisting: AuthenticationGuard },
    { provide: APP_GUARD, useExisting: InternalProbeGuard },
    { provide: APP_GUARD, useExisting: PermissionGuard },
    { provide: APP_GUARD, useExisting: HttpSecurityGuard }
  ],
  exports: [
    AUTH_CONFIG,
    IDENTITY_PROVIDER,
    AuthCookieService,
    AuthService,
    AuthRequestSecurityService,
    AuthenticationGuard,
    InternalProbeGuard,
    HttpSecurityGuard,
    PermissionGuard
  ]
})
export class AuthModule {}
