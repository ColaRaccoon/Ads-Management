import { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Subject } from "rxjs";
import { describe, expect, it, vi } from "vitest";
import { HttpSecurityConfig } from "./http-security.config";
import { HEAVY_OPERATION_METADATA, HeavyOperationGate } from "./heavy-operation";

describe("HeavyOperationGate", () => {
  it("rejects a second heavy request before its handler starts and releases on completion", () => {
    const gate = new HeavyOperationGate({
      heavyOperationConcurrency: 1,
      heavyOperationRetryAfterSeconds: 7
    } as HttpSecurityConfig, new Reflector());
    const handler = () => undefined;
    Reflect.defineMetadata(HEAVY_OPERATION_METADATA, true, handler);
    const setHeader = vi.fn();
    const context = {
      getHandler: () => handler,
      getClass: () => class TestController {},
      switchToHttp: () => ({ getResponse: () => ({ setHeader }) })
    } as unknown as ExecutionContext;
    const firstResult = new Subject<unknown>();
    const firstHandler = vi.fn(() => firstResult);
    const firstSubscription = gate.intercept(context, { handle: firstHandler }).subscribe();
    const secondHandler = vi.fn(() => new Subject<unknown>());

    expect(() => gate.intercept(context, { handle: secondHandler })).toThrow(
      "A memory-intensive operation is already running"
    );
    expect(secondHandler).not.toHaveBeenCalled();
    expect(setHeader).toHaveBeenCalledWith("Retry-After", "7");

    firstResult.complete();
    firstSubscription.unsubscribe();
    expect(() => gate.intercept(context, { handle: secondHandler })).not.toThrow();
  });

  it("does not consume capacity for ordinary routes", () => {
    const gate = new HeavyOperationGate({
      heavyOperationConcurrency: 1,
      heavyOperationRetryAfterSeconds: 5
    } as HttpSecurityConfig, new Reflector());
    const next = new Subject<unknown>();
    const context = {
      getHandler: () => () => undefined,
      getClass: () => class TestController {}
    } as unknown as ExecutionContext;

    expect(gate.intercept(context, { handle: () => next })).toBe(next);
    expect(gate.tryAcquire()).not.toBeNull();
  });
});
