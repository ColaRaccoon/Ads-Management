import { spawn } from "node:child_process";

const webPort = boundedPort(process.env.PORT ?? "3200", "PORT");
const apiPort = boundedPort(process.env.API_INTERNAL_PORT ?? "4200", "API_INTERNAL_PORT");
if (webPort === apiPort) throw new Error("Public Web and internal API ports must differ.");

const children = [
  spawn(process.execPath, ["apps/api/dist/main.js"], {
    env: { ...process.env, PORT: String(apiPort) },
    stdio: "inherit"
  }),
  spawn(process.execPath, ["apps/web/server.js"], {
    env: { ...process.env, PORT: String(webPort), HOSTNAME: "0.0.0.0" },
    stdio: "inherit"
  })
];

let stopping = false;
const stop = (signal = "SIGTERM") => {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill(signal);
  setTimeout(() => {
    for (const child of children) child.kill("SIGKILL");
  }, 10_000).unref();
};

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stop(signal));
for (const child of children) {
  child.once("exit", (code, signal) => {
    stop();
    process.exitCode = code ?? (signal ? 1 : 0);
  });
  child.once("error", () => {
    stop();
    process.exitCode = 1;
  });
}

function boundedPort(value, key) {
  if (!/^\d+$/.test(value)) throw new Error(`${key} must be a port.`);
  const port = Number(value);
  if (port < 1 || port > 65535) throw new Error(`${key} must be a port.`);
  return port;
}
