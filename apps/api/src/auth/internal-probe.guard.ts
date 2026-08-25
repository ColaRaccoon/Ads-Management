import { timingSafeEqual } from "node:crypto";
import { CanActivate, ExecutionContext, HttpException, HttpStatus, Inject, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Request } from "express";
import {
  HTTP_SECURITY_CONFIG,
  HttpSecurityConfig
} from "../common/http-security.config";
import { AUTH_ROUTE_ACCESS, INTERNAL_PROBE_ROUTE } from "./route-decorators";

export const INTERNAL_PROBE_AUTHORIZED = Symbol("INTERNAL_PROBE_AUTHORIZED");

export type InternalProbeRequest = Request & {
  [INTERNAL_PROBE_AUTHORIZED]?: true;
};

@Injectable()
export class InternalProbeGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(HTTP_SECURITY_CONFIG) private readonly config: HttpSecurityConfig
  ) {}

  canActivate(context: ExecutionContext) {
    const access = this.reflector.get<string>(AUTH_ROUTE_ACCESS, context.getHandler());
    if (access !== INTERNAL_PROBE_ROUTE) return true;

    const request = context.switchToHttp().getRequest<InternalProbeRequest>();
    const candidate = request.get("x-internal-probe-token");
    if (!constantTimeEqual(candidate, this.config.internalProbeToken)) {
      throw new HttpException({
        code: "INTERNAL_PROBE_FORBIDDEN",
        message: "The internal probe is not allowed.",
        details: null
      }, HttpStatus.FORBIDDEN);
    }
    request[INTERNAL_PROBE_AUTHORIZED] = true;
    return true;
  }
}

function constantTimeEqual(candidate: string | undefined, expected: string) {
  if (!candidate || candidate.length > 256) return false;
  const left = Buffer.from(candidate, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}
