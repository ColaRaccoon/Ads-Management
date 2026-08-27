import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

type Header = { key: string; value: string };

async function loadHeaderFactory() {
  const location = pathToFileURL(path.resolve(process.cwd(), "next.config.mjs")).href;
  const loaded = await import(/* @vite-ignore */ location) as {
    securityHeaders(production: boolean, hstsEnabled?: boolean): Header[];
  };
  return loaded.securityHeaders;
}

describe("active Next security headers", () => {
  it("sets a production CSP without unsafe-eval and denies framing", async () => {
    const headers = Object.fromEntries((await loadHeaderFactory())(true, true).map(
      ({ key, value }) => [key, value]
    ));
    expect(headers["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
    expect(headers["Content-Security-Policy"]).toContain("worker-src 'self' blob:");
    expect(headers["Content-Security-Policy"]).not.toContain("'unsafe-eval'");
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["X-Frame-Options"]).toBe("DENY");
    expect(headers["Strict-Transport-Security"]).toBe("max-age=300");
    expect(headers["Strict-Transport-Security"]).not.toContain("preload");
  });

  it("keeps HSTS out of local development and allows the Next dev runtime", async () => {
    const headers = Object.fromEntries((await loadHeaderFactory())(false).map(
      ({ key, value }) => [key, value]
    ));
    expect(headers).not.toHaveProperty("Strict-Transport-Security");
    expect(headers["Content-Security-Policy"]).toContain("'unsafe-eval'");
    expect(headers["Permissions-Policy"]).toContain("camera=()");
  });
});
