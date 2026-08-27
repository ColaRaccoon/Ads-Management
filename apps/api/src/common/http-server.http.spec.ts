import { Body, Controller, Get, INestApplication, Module, Post, Req } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { Request } from "express";
import { afterEach, describe, expect, it } from "vitest";
import { ApiExceptionFilter } from "./api-exception.filter";
import { configureHttpServer } from "./http-server";
import { clientAddress } from "../auth/request-security.service";

@Controller("transport-test")
class TransportTestController {
  @Post()
  echo(@Body() body: unknown) {
    return body;
  }

  @Get("ip")
  ip(@Req() request: Request) {
    return { address: clientAddress(request) };
  }
}

@Module({ controllers: [TransportTestController] })
class TransportTestModule {}

let app: INestApplication | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("configured HTTP transport", () => {
  it("returns a stable 413 with request ID, no-store, and security headers", async () => {
    app = await NestFactory.create(TransportTestModule, { bodyParser: false, logger: false, abortOnError: false });
    app.setGlobalPrefix("api");
    app.useGlobalFilters(new ApiExceptionFilter());
    configureHttpServer(app, {
      allowedOrigins: new Set(["http://localhost:3200"])
    } as never, {
      production: false,
      trustProxyHops: 0,
      jsonBodyLimitBytes: 128,
      urlencodedBodyLimitBytes: 128
    } as never);
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address() as { port: number };

    const response = await fetch(`http://127.0.0.1:${address.port}/api/transport-test`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:3200",
        "x-request-id": "request-from-client"
      },
      body: JSON.stringify({ value: "x".repeat(512) })
    });
    expect(response.status).toBe(413);
    const payload = await response.json() as { requestId: string };
    expect(payload).toEqual({
      code: "PAYLOAD_TOO_LARGE",
      message: "The request payload is too large.",
      details: null,
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/)
    });
    expect(response.headers.get("retry-after")).toBeNull();
    expect(response.headers.get("x-request-id")).toBe(payload.requestId);
    expect(payload.requestId).not.toBe("request-from-client");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:3200");
  });

  it("does not grant CORS to an origin outside the exact allowlist", async () => {
    app = await NestFactory.create(TransportTestModule, { bodyParser: false, logger: false, abortOnError: false });
    app.setGlobalPrefix("api");
    configureHttpServer(app, {
      allowedOrigins: new Set(["https://app.example.com"])
    } as never, {
      production: false,
      trustProxyHops: 0,
      jsonBodyLimitBytes: 1024,
      urlencodedBodyLimitBytes: 1024
    } as never);
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address() as { port: number };
    const response = await fetch(`http://127.0.0.1:${address.port}/api/transport-test`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://app.example.com.attacker.test" },
      body: "{}"
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("ignores spoofed forwarding headers with zero trusted hops", async () => {
    app = await createTransportApp(0);
    const address = app.getHttpServer().address() as { port: number };
    const response = await fetch(`http://127.0.0.1:${address.port}/api/transport-test/ip`, {
      headers: { "x-forwarded-for": "203.0.113.90, 198.51.100.70" }
    });
    const payload = await response.json() as { address: string };
    expect(payload.address).toMatch(/127\.0\.0\.1$/);
    expect(payload.address).not.toMatch(/203\.0\.113\.90|198\.51\.100\.70/);
  });

  it("with one trusted edge hop uses only the nearest forwarded address", async () => {
    app = await createTransportApp(1);
    const address = app.getHttpServer().address() as { port: number };
    const response = await fetch(`http://127.0.0.1:${address.port}/api/transport-test/ip`, {
      headers: { "x-forwarded-for": "203.0.113.90, 198.51.100.70" }
    });
    await expect(response.json()).resolves.toEqual({ address: "198.51.100.70" });
  });

  it("rejects invalid forwarded identities and canonicalizes equivalent IPv6 addresses", async () => {
    app = await createTransportApp(1);
    const address = app.getHttpServer().address() as { port: number };
    const forwarded = [
      "a",
      "999.999.999.999",
      "2001:db8::1",
      "2001:0db8:0:0:0:0:0:1"
    ];
    const normalized: string[] = [];
    for (const value of forwarded) {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/transport-test/ip`, {
        headers: { "x-forwarded-for": value }
      });
      const payload = await response.json() as { address: string };
      normalized.push(payload.address);
    }
    expect(normalized).toEqual(["unknown", "unknown", "2001:db8::1", "2001:db8::1"]);
  });
});

async function createTransportApp(trustProxyHops: number) {
  const instance = await NestFactory.create(TransportTestModule, { bodyParser: false, logger: false, abortOnError: false });
  instance.setGlobalPrefix("api");
  configureHttpServer(instance, {
    allowedOrigins: new Set(["http://localhost:3200"])
  } as never, {
    production: false,
    trustProxyHops,
    jsonBodyLimitBytes: 1024,
    urlencodedBodyLimitBytes: 1024
  } as never);
  await instance.listen(0, "127.0.0.1");
  return instance;
}
