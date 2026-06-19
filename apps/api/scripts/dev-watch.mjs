import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tscCli = require.resolve("typescript/bin/tsc");
const mainFile = path.join(apiRoot, "dist", "main.js");

const restartDelayMs = 350;
const shutdownGraceMs = 4000;
const finalShutdownWaitMs = 1000;

let apiProcess = null;
let restartTimer = null;
let restartInProgress = false;
let restartQueued = false;
let shuttingDown = false;
let tscStdoutBuffer = "";

const tscProcess = spawn(
  process.execPath,
  [tscCli, "-p", "tsconfig.build.json", "--watch", "--preserveWatchOutput"],
  { cwd: apiRoot, env: process.env }
);

tscProcess.stdout.on("data", (chunk) => {
  const text = chunk.toString();
  process.stdout.write(text);

  tscStdoutBuffer = `${tscStdoutBuffer}${text}`.slice(-4000);

  if (/Found 0 errors?\. Watching for file changes\./.test(tscStdoutBuffer)) {
    tscStdoutBuffer = "";
    scheduleRestart();
  }
});

tscProcess.stderr.on("data", (chunk) => {
  process.stderr.write(chunk);
});

tscProcess.on("error", (error) => {
  if (!shuttingDown) {
    console.error("TypeScript watch failed to start.", error);
    void shutdown(1);
  }
});

tscProcess.on("exit", (code, signal) => {
  if (!shuttingDown) {
    console.error(`TypeScript watch exited unexpectedly (code ${code ?? "null"}, signal ${signal ?? "null"}).`);
    void shutdown(code ?? 1);
  }
});

function scheduleRestart() {
  if (shuttingDown) {
    return;
  }

  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    void restartApi();
  }, restartDelayMs);
}

async function restartApi() {
  if (restartInProgress) {
    restartQueued = true;
    return;
  }

  restartInProgress = true;
  try {
    await stopApi();
    if (!shuttingDown) {
      startApi();
    }
  } finally {
    restartInProgress = false;
  }

  if (restartQueued) {
    restartQueued = false;
    scheduleRestart();
  }
}

function startApi() {
  if (!existsSync(mainFile)) {
    console.error(`API entrypoint was not found: ${mainFile}`);
    return;
  }

  apiProcess = spawn(process.execPath, [mainFile], {
    cwd: apiRoot,
    env: process.env,
    stdio: "inherit"
  });

  apiProcess.on("exit", (code, signal) => {
    apiProcess = null;
    if (!shuttingDown && code !== 0 && signal !== "SIGTERM") {
      console.error(`API process exited (code ${code ?? "null"}, signal ${signal ?? "null"}). Waiting for the next successful build.`);
    }
  });
}

function stopApi() {
  if (!apiProcess) {
    return Promise.resolve();
  }

  const child = apiProcess;
  apiProcess = null;

  return new Promise((resolve) => {
    let settled = false;
    let forceKillTimer = null;
    let forceResolveTimer = null;
    const finish = () => {
      if (!settled) {
        settled = true;
        if (forceKillTimer) {
          clearTimeout(forceKillTimer);
        }
        if (forceResolveTimer) {
          clearTimeout(forceResolveTimer);
        }
        resolve();
      }
    };

    forceKillTimer = setTimeout(() => {
      if (!settled) {
        child.kill("SIGKILL");
        forceResolveTimer = setTimeout(finish, finalShutdownWaitMs);
      }
    }, shutdownGraceMs);

    child.once("exit", finish);
    child.once("error", finish);
    if (!child.kill("SIGTERM")) {
      finish();
    }
  });
}

async function shutdown(exitCode = 0) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  clearTimeout(restartTimer);
  await stopApi();

  if (!tscProcess.killed) {
    tscProcess.kill("SIGTERM");
  }

  process.exit(exitCode);
}

process.on("SIGINT", () => {
  void shutdown(0);
});

process.on("SIGTERM", () => {
  void shutdown(0);
});
