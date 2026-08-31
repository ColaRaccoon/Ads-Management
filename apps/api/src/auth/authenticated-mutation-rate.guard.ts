import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { AuthenticatedRequest } from "./auth.types";
import { AuthRequestSecurityService } from "./request-security.service";
import { isExpensiveMutation, requestPath } from "./http-security.guard";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const AUTH_SECURITY_ROUTES = new Set([
  "POST /api/auth/login",
  "POST /api/auth/refresh",
  "POST /api/auth/logout",
  "POST /api/auth/invitations/accept",
  "POST /api/auth/password"
]);

@Injectable()
export class AuthenticatedMutationRateGuard implements CanActivate {
  constructor(private readonly security: AuthRequestSecurityService) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const method = String(request.method ?? "GET").toUpperCase();
    const path = requestPath(request);
    if (
      SAFE_METHODS.has(method) || path === "/api/health/live" || path === "/api/health/ready" ||
      AUTH_SECURITY_ROUTES.has(`${method} ${path}`) || path.startsWith("/api/users")
    ) return true;
    await this.security.assertAuthenticatedMutationRate(request, isExpensiveMutation(path));
    return true;
  }
}
