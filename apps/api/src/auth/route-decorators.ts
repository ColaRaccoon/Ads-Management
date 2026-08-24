import { applyDecorators, createParamDecorator, ExecutionContext, SetMetadata } from "@nestjs/common";
import { AuthenticatedRequest } from "./auth.types";
import type { Permission } from "./role-permissions";

export const AUTH_ROUTE_ACCESS = "auth:route-access";
export const PUBLIC_ROUTE = "public";
export const AUTHENTICATED_ROUTE = "authenticated";
export const PERMISSION_ROUTE = "permission";
export const INTERNAL_PROBE_ROUTE = "internal-probe";
export const REQUIRED_PERMISSIONS = "auth:required-permissions";

export const Public = () => SetMetadata(AUTH_ROUTE_ACCESS, PUBLIC_ROUTE);

export const Authenticated = () => SetMetadata(AUTH_ROUTE_ACCESS, AUTHENTICATED_ROUTE);

export const RequirePermissions = (...permissions: Permission[]) => applyDecorators(
  SetMetadata(AUTH_ROUTE_ACCESS, PERMISSION_ROUTE),
  SetMetadata(REQUIRED_PERMISSIONS, permissions)
);

export const InternalProbe = () => SetMetadata(AUTH_ROUTE_ACCESS, INTERNAL_PROBE_ROUTE);

export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
  if (!request.authenticatedUser) throw new Error("Authenticated principal is unavailable.");
  return request.authenticatedUser;
});
