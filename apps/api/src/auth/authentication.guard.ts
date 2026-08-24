import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
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

@Injectable()
export class AuthenticationGuard implements CanActivate {
  constructor(
    private readonly authService: AuthService,
    private readonly cookies: AuthCookieService,
    private readonly reflector: Reflector
  ) {}

  async canActivate(context: ExecutionContext) {
    const access = this.reflector.get<string>(AUTH_ROUTE_ACCESS, context.getHandler());
    if (access === PUBLIC_ROUTE || access === INTERNAL_PROBE_ROUTE) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const accessToken = this.cookies.readAccessToken(request);
    if (!accessToken) throw authError("AUTHENTICATION_REQUIRED");
    request.authenticatedUser = await this.authService.authenticateAccessToken(accessToken);
    return true;
  }
}
