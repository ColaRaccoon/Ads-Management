/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    // Meta CSV imports perform sequential writes to the remote database and
    // can legitimately take longer than Next's 30-second development proxy
    // default. Keep the proxy connection alive while the API finishes.
    proxyTimeout: 300_000
  },
  async rewrites() {
    return [{
      source: "/backend-api/:path*",
      destination: `${process.env.API_PROXY_TARGET ?? "http://localhost:4100/api"}/:path*`
    }];
  },
  async headers() {
    return [{
      source: "/:path*",
      headers: securityHeaders(process.env.NODE_ENV === "production")
    }];
  }
};

export default nextConfig;

export function securityHeaders(production) {
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
  if (production) {
    headers.push({
      key: "Strict-Transport-Security",
      value: "max-age=31536000; includeSubDomains"
    });
  }
  return headers;
}
