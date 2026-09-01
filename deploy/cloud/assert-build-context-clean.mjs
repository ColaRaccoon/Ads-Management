import { readdir } from "node:fs/promises";
import path from "node:path";

const ignoredDirectories = new Set([
  ".git",
  ".next",
  "coverage",
  "dist",
  "node_modules"
]);

await assertBuildContextClean(process.cwd());

async function assertBuildContextClean(root) {
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) pending.push(path.join(directory, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name === ".env" || (entry.name.startsWith(".env.") && entry.name !== ".env.example")) {
        throw new Error("Build context contains a forbidden dotenv file.");
      }
    }
  }
}
