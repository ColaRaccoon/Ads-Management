/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "standalone",
  experimental: {
    // Meta CSV imports perform sequential writes to the remote database and
    // can legitimately take longer than Next's 30-second development proxy
    // default. Keep the proxy connection alive while the API finishes.
    proxyTimeout: 300_000
  },
  async rewrites() {
    const apiTarget = process.env.NODE_ENV === "production"
      ? `http://127.0.0.1:${internalPort(process.env.API_INTERNAL_PORT, 4200)}/api`
      : process.env.API_PROXY_TARGET ?? "http://localhost:4100/api";
    return [{
      source: "/backend-api/:path*",
      destination: `${apiTarget}/:path*`
    }];
  },
  async headers() {
    return [{
      source: "/:path*",
      headers: securityHeaders(
        process.env.NODE_ENV === "production",
        process.env.HSTS_ENABLED === "true"
      )
    }];
  }
};

export default nextConfig;

export function securityHeaders(production, hstsEnabled = false) {
  const scriptSources = ["'self'", "'unsafe-inline'"];
  const connectSources = ["'self'"];
  if (!production) {
    scriptSources.push("'unsafe-eval'");
    connectSources.push("http:", "https:", "ws:", "wss:");
  }
  const contentSecurityPolicy = [
    "default-src 'self'",
    "base-uri 'self'",
    `connect-src ${connectSources.join(" ")}`,
    "font-src 'self' data:",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' blob: data:",
    "object-src 'none'",
    `script-src ${scriptSources.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    "worker-src 'self' blob:"
  ].join("; ");

  const headers = [
    { key: "Content-Security-Policy", value: contentSecurityPolicy },
    { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "Permissions-Policy", value: "camera=(), geolocation=(), microphone=(), payment=(), usb=()" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" }
  ];
  if (production && hstsEnabled) {
    headers.push({
      key: "Strict-Transport-Security",
      value: "max-age=300"
    });
  }
  return headers;
}

function internalPort(value, fallback) {
  const normalized = value?.trim() || String(fallback);
  if (!/^\d+$/.test(normalized)) throw new Error("API_INTERNAL_PORT must be an integer.");
  const port = Number(normalized);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
    throw new Error("API_INTERNAL_PORT must be between 1024 and 65535.");
  }
  return port;
}
