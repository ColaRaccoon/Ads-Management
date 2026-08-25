import { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { describe, expect, it, vi } from "vitest";
import { PermissionGuard } from "./permission.guard";
import { InternalProbeGuard, INTERNAL_PROBE_AUTHORIZED } from "./internal-probe.guard";
import { AUTH_ROUTE_ACCESS, INTERNAL_PROBE_ROUTE } from "./route-decorators";

const token = "0123456789abcdef0123456789abcdef0123456789abcdef";

describe("InternalProbeGuard", () => {
  it("rejects absent/wrong tokens and authorizes only an exact constant-time match", () => {
    const handler = () => undefined;
    Reflect.defineMetadata(AUTH_ROUTE_ACCESS, INTERNAL_PROBE_ROUTE, handler);
    const guard = new InternalProbeGuard(new Reflector(), { internalProbeToken: token } as never);
    for (const candidate of [undefined, `${token}x`, `x${token.slice(1)}`]) {
      expect(() => guard.canActivate(context(handler, candidate).context)).toThrow(
        expect.objectContaining({ status: 403 })
      );
    }
    const accepted = context(handler, token);
    expect(guard.canActivate(accepted.context)).toBe(true);
    expect(accepted.request[INTERNAL_PROBE_AUTHORIZED]).toBe(true);
    expect(new PermissionGuard(new Reflector()).canActivate(accepted.context)).toBe(true);
  });

  it("does not treat the internal token as a bypass on ordinary handlers", () => {
    const handler = () => undefined;
    const request = { get: vi.fn().mockReturnValue(token) };
    const contextValue = {
      getHandler: () => handler,
      switchToHttp: () => ({ getRequest: () => request })
    } as unknown as ExecutionContext;
    const guard = new InternalProbeGuard(new Reflector(), { internalProbeToken: token } as never);
    expect(guard.canActivate(contextValue)).toBe(true);
    expect((request as Record<PropertyKey, unknown>)[INTERNAL_PROBE_AUTHORIZED]).toBeUndefined();
  });
});

function context(handler: Function, candidate: string | undefined) {
  const request: Record<PropertyKey, unknown> = {
    get: vi.fn((name: string) => name === "x-internal-probe-token" ? candidate : undefined)
  };
  return {
    request,
    context: {
      getHandler: () => handler,
      switchToHttp: () => ({ getRequest: () => request })
    } as unknown as ExecutionContext
  };
}
