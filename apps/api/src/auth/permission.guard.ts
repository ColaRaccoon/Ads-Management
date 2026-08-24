import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { authError } from "./auth.errors";
import { AuthenticatedRequest } from "./auth.types";
import {
  AUTHENTICATED_ROUTE,
  AUTH_ROUTE_ACCESS,
  INTERNAL_PROBE_ROUTE,
  PERMISSION_ROUTE,
  PUBLIC_ROUTE,
  REQUIRED_PERMISSIONS
} from "./route-decorators";
import type { Permission } from "./role-permissions";

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext) {
    const handler = context.getHandler();
    const access = this.reflector.get<string>(AUTH_ROUTE_ACCESS, handler);

    if (access === PUBLIC_ROUTE) return true;
    // Internal probes require their dedicated network/header guard. Until an
    // active probe is introduced, fail closed instead of treating this marker
    // as a general authentication bypass.
    if (access === INTERNAL_PROBE_ROUTE) throw authError("PERMISSION_DENIED");

    const principal = context.switchToHttp().getRequest<AuthenticatedRequest>().authenticatedUser;
    if (!principal) throw authError("AUTHENTICATION_REQUIRED");
    if (access === AUTHENTICATED_ROUTE) return true;
    if (access !== PERMISSION_ROUTE) throw authError("PERMISSION_DENIED");

    const required = this.reflector.get<readonly Permission[]>(REQUIRED_PERMISSIONS, handler);
    if (!required?.length || !required.every((permission) => principal.permissions.includes(permission))) {
      throw authError("PERMISSION_DENIED");
    }
    return true;
  }
}
