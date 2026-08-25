import { EventEmitter } from "node:events";
import { Logger } from "@nestjs/common";
import { NextFunction, Request, Response } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RequestContextMiddleware,
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
});
