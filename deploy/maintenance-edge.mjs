import { existsSync } from "node:fs";
import http from "node:http";

const port = boundedPort(process.env.PORT ?? "8080", "PORT");
const upstream = new URL(process.env.UPSTREAM_ORIGIN ?? "http://release:3200");
if (upstream.protocol !== "http:" || upstream.username || upstream.password || upstream.search || upstream.hash) {
  throw new Error("UPSTREAM_ORIGIN must be a credential-free internal HTTP origin.");
}
const maintenanceFile = process.env.MAINTENANCE_FILE ?? "/run/maintenance/enabled";
const forcedMaintenance = process.env.MAINTENANCE_MODE === "on";

const server = http.createServer((request, response) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
  if (request.url === "/edge/live") {
    response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end('{"status":"live"}');
    return;
  }
  if (forcedMaintenance || existsSync(maintenanceFile)) {
    response.writeHead(503, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "Retry-After": "300"
    });
    response.end("Service temporarily unavailable for maintenance.\n");
    return;
  }
  const headers = sanitizeHopByHop(request.headers);
  for (const key of ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-port", "x-forwarded-proto"]) {
    delete headers[key];
  }
  headers.host = upstream.host;
  headers["x-forwarded-for"] = normalizedRemoteAddress(request.socket.remoteAddress);
  headers["x-forwarded-host"] = request.headers.host ?? "unknown";
  headers["x-forwarded-proto"] = process.env.EXTERNAL_PROTO === "https" ? "https" : "http";
  const proxy = http.request({
    protocol: upstream.protocol,
    hostname: upstream.hostname,
    port: upstream.port,
    method: request.method,
    path: request.url,
    headers,
    timeout: 310_000
  }, (upstreamResponse) => {
    const responseHeaders = sanitizeHopByHop(upstreamResponse.headers);
    responseHeaders["x-robots-tag"] = "noindex, nofollow, noarchive";
    response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
    upstreamResponse.pipe(response);
  });
  proxy.on("timeout", () => proxy.destroy());
  proxy.on("error", () => {
    if (!response.headersSent) response.writeHead(503, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
    response.end("Service temporarily unavailable.\n");
  });
  request.pipe(proxy);
});

server.requestTimeout = 315_000;
server.headersTimeout = 15_000;
server.listen(port, "0.0.0.0");
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

function sanitizeHopByHop(input) {
  const headers = { ...input };
  const connectionTokens = String(headers.connection ?? "")
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
  for (const key of [
    "connection",
    "keep-alive",
    "proxy-authorization",
    "proxy-authenticate",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    ...connectionTokens
  ]) delete headers[key];
  return headers;
}

function normalizedRemoteAddress(value) {
  const address = value?.replace(/^::ffff:/, "") ?? "unknown";
  return /^[0-9a-f:.]+$/i.test(address) ? address : "unknown";
}

function boundedPort(value, key) {
  if (!/^\d+$/.test(value)) throw new Error(`${key} must be a port.`);
  const parsed = Number(value);
  if (parsed < 1 || parsed > 65_535) throw new Error(`${key} must be a port.`);
  return parsed;
}
