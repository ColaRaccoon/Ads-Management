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
  const deploymentMode = target.DEPLOYMENT_MODE?.trim().toLowerCase();
  const appEnvironment = target.APP_ENV?.trim().toLowerCase();
  const nodeEnvironment = target.NODE_ENV?.trim().toLowerCase();
  const cloudContainer = deploymentMode === "cloud_container";
  if (cloudContainer) {
    if (configuredPath) {
      throw new Error("CONFIG_PATH is forbidden for cloud_container; inject runtime environment variables.");
    }
    return false;
  }
  const localProduction = deploymentMode === "local_lan" &&
    (appEnvironment === "production" || nodeEnvironment === "production");
  if (localProduction && !configuredPath) {
    throw new Error("CONFIG_PATH is required for local_lan production; repository .env loading is disabled.");
  }
  const envFile = configuredPath
    ? resolveExternalConfigPath(configuredPath, packageRoot)
    : path.join(packageRoot, ".env");
  if (!existsSync(envFile)) return false;

  const parsed = parseEnv(readFileSync(envFile, "utf8"));
  if (parsed.DEPLOYMENT_MODE?.trim().toLowerCase() === "cloud_container") {
    throw new Error("cloud_container must be selected by the runtime environment; file-based environment loading is forbidden.");
  }
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
