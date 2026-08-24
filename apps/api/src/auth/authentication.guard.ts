import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { AuthService } from "./auth.service";
import { AuthCookieService } from "./cookie.service";
import { authError } from "./auth.errors";
import { AuthenticatedRequest } from "./auth.types";

@Injectable()
export class AuthenticationGuard implements CanActivate {
  constructor(
    private readonly authService: AuthService,
    private readonly cookies: AuthCookieService
  ) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const accessToken = this.cookies.readAccessToken(request);
    if (!accessToken) throw authError("AUTHENTICATION_REQUIRED");
    request.authenticatedUser = await this.authService.authenticateAccessToken(accessToken);
    return true;
  }
}
