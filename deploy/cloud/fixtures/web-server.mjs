import http from "node:http";

if (process.env.HOSTNAME !== "0.0.0.0" || !process.env.PORT) {
  throw new Error("FIXTURE_WEB_MUST_BE_PUBLIC_LISTENER");
}

const port = Number(process.env.PORT);
const server = http.createServer((request, response) => {
  if (request.method !== "GET" || request.url !== "/backend-api/health/live") {
    response.writeHead(404);
    response.end();
    return;
  }
  const upstream = http.get("http://127.0.0.1:4200/api/health/live", (incoming) => {
    response.writeHead(incoming.statusCode ?? 502, { "content-type": "application/json" });
    incoming.pipe(response);
  });
  upstream.on("error", () => {
    response.writeHead(503);
    response.end();
  });
});

server.listen(port, "0.0.0.0", () => {
  console.log(JSON.stringify({ component: "fixture-web", event: "listening", address: "0.0.0.0", port }));
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
