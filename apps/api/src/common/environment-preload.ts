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
  const target = options.env ?? process.env;
  const configuredPath = target.CONFIG_PATH?.trim();
  const localProduction = target.DEPLOYMENT_MODE === "local_lan" &&
    (target.APP_ENV === "production" || target.NODE_ENV === "production");
  if (localProduction && !configuredPath) {
    throw new Error("CONFIG_PATH is required for local_lan production; repository .env loading is disabled.");
  }
  const envFile = configuredPath
    ? resolveExternalConfigPath(configuredPath, packageRoot)
    : path.join(packageRoot, ".env");
  if (!existsSync(envFile)) return false;

  const parsed = parseEnv(readFileSync(envFile, "utf8"));
  for (const [key, value] of Object.entries(parsed)) {
    if (target[key] === undefined) target[key] = value;
  }
  return true;
}

function resolveExternalConfigPath(value: string, packageRoot: string) {
  if (!path.isAbsolute(value)) throw new Error("CONFIG_PATH must be absolute.");
  const resolved = path.resolve(value);
  const relative = path.relative(packageRoot, resolved);
  if (!relative.startsWith(`..${path.sep}`) && relative !== "..") {
    throw new Error("CONFIG_PATH must be outside the repository package.");
  }
  return resolved;
}
