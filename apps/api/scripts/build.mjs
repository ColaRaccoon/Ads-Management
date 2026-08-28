import { rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const applicationRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const outputRoot = path.join(applicationRoot, "dist");
const buildInfoPath = path.resolve(applicationRoot, "../../node_modules/.cache/api-build.tsbuildinfo");
rmSync(outputRoot, { recursive: true, force: true });
rmSync(buildInfoPath, { force: true });

const require = createRequire(import.meta.url);
const typescriptCompiler = require.resolve("typescript/bin/tsc");
const result = spawnSync(process.execPath, [typescriptCompiler, "-p", "tsconfig.build.json"], {
  cwd: applicationRoot,
  stdio: "inherit",
  windowsHide: true
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
