import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
  }
};

export default nextConfig;
