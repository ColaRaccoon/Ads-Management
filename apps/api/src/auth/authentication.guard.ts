import { CanActivate, ExecutionContext, Inject, Injectable, Optional } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AuthService } from "./auth.service";
import { AuthCookieService } from "./cookie.service";
import { authError } from "./auth.errors";
import { AuthenticatedRequest } from "./auth.types";
import {
  AUTH_ROUTE_ACCESS,
  INTERNAL_PROBE_ROUTE,
  PUBLIC_ROUTE
} from "./route-decorators";
import { AUTH_CONFIG, AuthConfig } from "./auth.config";
import { activityAge } from "./session-idle";
import { LocalAuthService } from "./local-auth.service";

@Injectable()
export class AuthenticationGuard implements CanActivate {
  constructor(
    private readonly authService: AuthService,
    private readonly cookies: AuthCookieService,
    private readonly reflector: Reflector,
    @Optional() @Inject(AUTH_CONFIG) private readonly config?: AuthConfig,
    @Optional() private readonly localAuth?: LocalAuthService
  ) {}

  async canActivate(context: ExecutionContext) {
    const access = this.reflector.get<string>(AUTH_ROUTE_ACCESS, context.getHandler());
    if (access === PUBLIC_ROUTE || access === INTERNAL_PROBE_ROUTE) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (this.config?.provider === "local") {
      const sessionToken = this.cookies.readSessionHandle(request);
      if (!sessionToken || !this.localAuth) throw authError("AUTHENTICATION_REQUIRED");
      request.authenticatedUser = await this.localAuth.authenticateSession(sessionToken);
    } else {
      const accessToken = this.cookies.readAccessToken(request);
      if (!accessToken) {
        const handle = this.cookies.readSessionHandle(request);
        if (handle && this.cookies.verifySessionHandle(handle) && this.cookies.readRefreshToken(request)) {
          throw authError("ACCESS_TOKEN_EXPIRED");
        }
        throw authError("AUTHENTICATION_REQUIRED");
      }
      request.authenticatedUser = await this.authService.authenticateAccessToken(
        accessToken, activityAge(request.headers?.["x-user-activity-age"])
      );
    }
    return true;
  }
}
