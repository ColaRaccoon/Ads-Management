import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { Request } from "express";
import { AuthRequestSecurityService } from "./request-security.service";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const AUTH_SECURITY_ROUTES = new Set([
  "POST /api/auth/login",
  "POST /api/auth/refresh",
  "POST /api/auth/logout",
  "POST /api/auth/invitations/accept",
  "POST /api/auth/password"
]);

@Injectable()
export class HttpSecurityGuard implements CanActivate {
  constructor(private readonly security: AuthRequestSecurityService) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<Request>();
    const method = String(request.method ?? "GET").toUpperCase();
    const path = requestPath(request);

    if (path === "/api/health/live" || path === "/api/health/ready") return true;
    if (SAFE_METHODS.has(method)) {
      await this.security.assertGeneralRead(request);
      return true;
    }

    // These routes already call the same central service with their stricter
    // auth/user policy and, for browser bootstrap routes, intentionally do not
    // require a pre-existing CSRF cookie.
    if (AUTH_SECURITY_ROUTES.has(`${method} ${path}`) || path.startsWith("/api/users")) {
      return true;
    }

    await this.security.assertGeneralMutation(request, isExpensiveMutation(path));
    return true;
  }
}

export function requestPath(request: Pick<Request, "originalUrl" | "url">) {
  const raw = request.originalUrl || request.url || "/";
  const query = raw.indexOf("?");
  return (query === -1 ? raw : raw.slice(0, query)).replace(/\/{2,}/g, "/");
}

export function isExpensiveMutation(path: string) {
  return path.startsWith("/api/uploads/") ||
    path === "/api/sales/cafe24/uploads" ||
    path.startsWith("/api/coupang/uploads/") ||
    path.endsWith("/rematch") ||
    path === "/api/decisions/run" ||
    path === "/api/reports/export";
}
