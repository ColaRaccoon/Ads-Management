import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [{
      source: "/backend-api/:path*",
      destination: `${process.env.API_PROXY_TARGET ?? "http://localhost:4100/api"}/:path*`
    }];
  }
};

export default nextConfig;
