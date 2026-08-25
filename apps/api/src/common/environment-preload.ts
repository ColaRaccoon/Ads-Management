import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

export function apiPackageRoot() {
  return path.resolve(__dirname, "..", "..");
}

/**
 * Loads the API package's .env before AppModule (and therefore upload
 * controller decorators) is evaluated. Existing OS variables always win.
 */
export function preloadApiEnvironment(options: {
  packageRoot?: string;
  env?: NodeJS.ProcessEnv;
} = {}) {
  const packageRoot = path.resolve(options.packageRoot ?? apiPackageRoot());
  const envFile = path.join(packageRoot, ".env");
  if (!existsSync(envFile)) return false;

  const parsed = parseEnv(readFileSync(envFile, "utf8"));
  const target = options.env ?? process.env;
  for (const [key, value] of Object.entries(parsed)) {
    if (target[key] === undefined) target[key] = value;
  }
  return true;
}
