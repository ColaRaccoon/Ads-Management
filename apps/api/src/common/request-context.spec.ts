import { EventEmitter } from "node:events";
import { Logger } from "@nestjs/common";
import { NextFunction, Request, Response } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RequestContextMiddleware,
  safeRouteTemplate,
  shouldLogRequestCompletion
} from "./request-context";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("request completion logging", () => {
  it("suppresses successful health probe noise but retains failed probes", () => {
    expect(shouldLogRequestCompletion("/api/health/live", 200)).toBe(false);
    expect(shouldLogRequestCompletion("/api/health/ready", 204)).toBe(false);
    expect(shouldLogRequestCompletion("/api/health/ready", 403)).toBe(true);
    expect(shouldLogRequestCompletion("/api/health/ready", 503)).toBe(true);
    expect(shouldLogRequestCompletion("/api/products", 200)).toBe(true);
  });

  it("does not emit an info log for a successful live probe", () => {
    const log = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    const response = new EventEmitter() as EventEmitter & Partial<Response>;
    response.statusCode = 200;
    response.setHeader = vi.fn();
    const request = {
      method: "GET",
      originalUrl: "/api/health/live?probe=1",
      url: "/api/health/live?probe=1",
      get: vi.fn(() => undefined)
    } as unknown as Request;

    new RequestContextMiddleware().use(
      request,
      response as Response,
      vi.fn() as unknown as NextFunction
    );
    response.emit("finish");

    expect(log).not.toHaveBeenCalled();
  });

  it("logs a failed readiness probe without its query", () => {
    const log = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    const response = new EventEmitter() as EventEmitter & Partial<Response>;
    response.statusCode = 503;
    response.setHeader = vi.fn();
    const request = {
      method: "GET",
      originalUrl: "/api/health/ready?token=must-not-log",
      url: "/api/health/ready?token=must-not-log",
      get: vi.fn(() => undefined)
    } as unknown as Request;

    new RequestContextMiddleware().use(
      request,
      response as Response,
      vi.fn() as unknown as NextFunction
    );
    response.emit("finish");

    expect(log).toHaveBeenCalledTimes(1);
    const payload = String(log.mock.calls[0]?.[0]);
    expect(payload).toContain('"path":"/api/health/ready"');
    expect(payload).not.toContain("must-not-log");
  });

  it("ignores a caller-provided request id and replaces every unmatched path with a constant", () => {
    const response = new EventEmitter() as EventEmitter & Partial<Response>;
    response.statusCode = 200;
    response.setHeader = vi.fn();
    const request = {
      method: "GET",
      originalUrl: "/api/reports/44b5b46a-d596-4a52-88b5-63f5f017ee0f?token=secret",
      url: "/api/reports/44b5b46a-d596-4a52-88b5-63f5f017ee0f?token=secret",
      get: vi.fn(() => "attacker-controlled-id")
    } as unknown as Request;

    new RequestContextMiddleware().use(request, response as Response, vi.fn());

    const requestIdHeader = (response.setHeader as ReturnType<typeof vi.fn>).mock.calls
      .find((call) => call[0] === "X-Request-Id")?.[1];
    expect(requestIdHeader).toMatch(/^[0-9a-f-]{36}$/);
    expect(requestIdHeader).not.toBe("attacker-controlled-id");
    expect(safeRouteTemplate(request)).toBe("/:unmatched");
    expect(safeRouteTemplate({ originalUrl: "/api/not-found/alice@example.com/private.xlsx" } as Request)).toBe("/:unmatched");
  });

  it("prefers the server route template over concrete parameter values", () => {
    const request = {
      baseUrl: "/api/users",
      route: { path: "/:id" },
      originalUrl: "/api/users/private-value"
    } as unknown as Request;
    expect(safeRouteTemplate(request)).toBe("/api/users/:id");
  });
});
