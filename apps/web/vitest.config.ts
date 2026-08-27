import { defineConfig } from "vitest/config";
import path from "node:path";

const workingDirectory = process.cwd();
const sourceRoot = path.resolve(
  workingDirectory,
  workingDirectory.replace(/\\/g, "/").endsWith("/apps/web") ? "src" : "apps/web/src"
);

export default defineConfig({
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "react"
  },
  resolve: {
    alias: {
      "@": sourceRoot
    }
  }
});
