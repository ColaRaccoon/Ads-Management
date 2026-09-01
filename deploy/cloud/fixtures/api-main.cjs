"use strict";

const http = require("node:http");

if (process.env.HOSTNAME !== "127.0.0.1" || process.env.PORT !== "4200") {
  throw new Error("FIXTURE_API_MUST_USE_FIXED_LOOPBACK");
}

const server = http.createServer((request, response) => {
  if (request.method === "GET" && request.url === "/api/health/live") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"status":"live"}');
    return;
  }
  response.writeHead(404);
  response.end();
});

server.listen(4200, "127.0.0.1", () => {
  console.log(JSON.stringify({ component: "fixture-api", event: "listening", address: "127.0.0.1", port: 4200 }));
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
