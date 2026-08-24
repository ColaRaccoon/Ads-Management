import { applyDecorators, createParamDecorator, ExecutionContext, SetMetadata, UseGuards } from "@nestjs/common";
import { AuthenticationGuard } from "./authentication.guard";
import { AuthenticatedRequest } from "./auth.types";

export const AUTH_ROUTE_ACCESS = "auth:route-access";
export const PUBLIC_ROUTE = "public";
export const AUTHENTICATED_ROUTE = "authenticated";

export const Public = () => SetMetadata(AUTH_ROUTE_ACCESS, PUBLIC_ROUTE);

export const Authenticated = () => applyDecorators(
  SetMetadata(AUTH_ROUTE_ACCESS, AUTHENTICATED_ROUTE),
  UseGuards(AuthenticationGuard)
);

export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
  if (!request.authenticatedUser) throw new Error("Authenticated principal is unavailable.");
  return request.authenticatedUser;
});
