import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  unwatchFile,
  watch,
  watchFile
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = path.resolve(apiRoot, "..", "..");
const sourceRoot = path.join(apiRoot, "src");
const distRoot = path.join(apiRoot, "dist");
const tscCli = require.resolve("typescript/bin/tsc");
const mainFile = path.join(distRoot, "main.js");
const watchedConfigFiles = [
  path.join(apiRoot, "tsconfig.build.json"),
  path.join(apiRoot, "tsconfig.json"),
  path.join(workspaceRoot, "tsconfig.base.json")
];

const compileDelayMs = 200;
const restartDelayMs = 350;
const shutdownGraceMs = 4000;
const finalShutdownWaitMs = 1000;

let apiProcess = null;
let compilerProcess = null;
let compileTimer = null;
let compileInProgress = false;
let compileQueued = false;
let restartTimer = null;
let restartInProgress = false;
let restartQueued = false;
let refreshWatchersTimer = null;
let directoryWatchers = [];
let shuttingDown = false;
let lastBuildFingerprint = null;
const scheduleConfigCompile = () => scheduleCompile();

refreshDirectoryWatchers();
for (const configFile of watchedConfigFiles) {
  if (existsSync(configFile)) {
    watchFile(configFile, { interval: 750 }, scheduleConfigCompile);
  }
}
scheduleCompile(0);

function scheduleCompile(delayMs = compileDelayMs) {
  if (shuttingDown) {
    return;
  }
  if (compileInProgress) {
    compileQueued = true;
    return;
  }

  clearTimeout(compileTimer);
  compileTimer = setTimeout(runCompile, delayMs);
}

function runCompile() {
  if (shuttingDown || compileInProgress) {
    return;
  }

  compileInProgress = true;
  compilerProcess = spawn(
    process.execPath,
    [tscCli, "-p", "tsconfig.build.json", "--pretty"],
    { cwd: apiRoot, env: process.env, stdio: "inherit" }
  );

  compilerProcess.on("error", (error) => {
    if (!shuttingDown) {
      console.error("TypeScript build failed to start.", error);
    }
  });

  compilerProcess.on("exit", (code, signal) => {
    compilerProcess = null;
    compileInProgress = false;

    if (!shuttingDown) {
      if (code === 0) {
        scheduleRestartForChangedBuild();
      } else if (signal !== "SIGTERM") {
        console.error(
          `TypeScript build failed (code ${code ?? "null"}, signal ${signal ?? "null"}).`
        );
      }
    }

    if (compileQueued && !shuttingDown) {
      compileQueued = false;
      scheduleCompile();
    }
  });
}

function refreshDirectoryWatchers() {
  for (const watcher of directoryWatchers) {
    watcher.close();
  }
  directoryWatchers = [];

  for (const directory of sourceDirectories(sourceRoot)) {
    const watcher = watch(directory, (eventType, filename) => {
      if (shuttingDown) {
        return;
      }

      const changedName = filename?.toString() ?? "";
      if (!changedName || changedName.endsWith(".ts") || changedName.endsWith(".json")) {
        scheduleCompile();
      }
      if (eventType === "rename") {
        clearTimeout(refreshWatchersTimer);
        refreshWatchersTimer = setTimeout(refreshDirectoryWatchers, compileDelayMs);
      }
    });
    watcher.on("error", (error) => {
      if (!shuttingDown) {
        console.error(`Source watcher failed for ${directory}.`, error);
      }
    });
    directoryWatchers.push(watcher);
  }
}

function sourceDirectories(root) {
  if (!existsSync(root)) {
    return [];
  }

  const directories = [root];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      directories.push(...sourceDirectories(path.join(root, entry.name)));
    }
  }
  return directories;
}

function scheduleRestartForChangedBuild() {
  if (!existsSync(mainFile)) {
    console.error(`API entrypoint was not found: ${mainFile}`);
    return;
  }

  const nextFingerprint = compiledJavaScriptFingerprint(distRoot);
  if (nextFingerprint === lastBuildFingerprint) {
    return;
  }

  lastBuildFingerprint = nextFingerprint;
  scheduleRestart();
}

function compiledJavaScriptFingerprint(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (entry.isFile() && entry.name.endsWith(".js")) {
        files.push(entryPath);
      }
    }
  };
  visit(root);
  files.sort((left, right) => left.localeCompare(right));

  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(path.relative(root, file));
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

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
      console.error(
        `API process exited (code ${code ?? "null"}, signal ${signal ?? "null"}). Waiting for the next successful build.`
      );
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
  clearTimeout(compileTimer);
  clearTimeout(restartTimer);
  clearTimeout(refreshWatchersTimer);
  for (const watcher of directoryWatchers) {
    watcher.close();
  }
  for (const configFile of watchedConfigFiles) {
    unwatchFile(configFile, scheduleConfigCompile);
  }
  if (compilerProcess && !compilerProcess.killed) {
    compilerProcess.kill("SIGTERM");
  }
  await stopApi();
  process.exit(exitCode);
}

process.on("SIGINT", () => {
  void shutdown(0);
});

process.on("SIGTERM", () => {
  void shutdown(0);
});
