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
  InMemorySecurityRateLimiter,
  SECURITY_RATE_LIMITER
} from "./request-security.service";
import { SupabaseAuthAdapter } from "./supabase-auth.adapter";
import { SupabaseJwtVerifier } from "./supabase-jwt.verifier";

@Module({
  imports: [CommonModule],
  controllers: [AuthController],
  providers: [
    { provide: AUTH_CONFIG, useFactory: () => loadAuthConfig() },
    SupabaseAuthAdapter,
    { provide: IDENTITY_PROVIDER, useExisting: SupabaseAuthAdapter },
    InMemorySecurityRateLimiter,
    { provide: SECURITY_RATE_LIMITER, useExisting: InMemorySecurityRateLimiter },
    SupabaseJwtVerifier,
    AuthCookieService,
    AuthRequestSecurityService,
    AuthService,
    AuthenticationGuard,
    PermissionGuard,
    { provide: APP_GUARD, useExisting: AuthenticationGuard },
    { provide: APP_GUARD, useExisting: PermissionGuard }
  ],
  exports: [
    AUTH_CONFIG,
    IDENTITY_PROVIDER,
    AuthCookieService,
    AuthService,
    AuthRequestSecurityService,
    AuthenticationGuard,
    PermissionGuard
  ]
})
export class AuthModule {}
