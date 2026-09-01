import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { preloadApiEnvironment } from "./environment-preload";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("API environment preload", () => {
  it("never reads a repository .env in cloud_container production", () => {
    const packageRoot = temporaryPackageRoot();
    writeFileSync(path.join(packageRoot, ".env"), "SHOULD_NOT_LOAD=repository-value\n", "utf8");
    const env = {
      APP_ENV: "production",
      DEPLOYMENT_MODE: " cloud_container "
    } as NodeJS.ProcessEnv;

    expect(preloadApiEnvironment({ packageRoot, env })).toBe(false);
    expect(env.SHOULD_NOT_LOAD).toBeUndefined();
  });

  it("never reads a repository .env when only cloud mode is pre-injected", () => {
    const packageRoot = temporaryPackageRoot();
    writeFileSync(path.join(packageRoot, ".env"), "APP_ENV=production\nSHOULD_NOT_LOAD=repository-value\n", "utf8");
    const env = { DEPLOYMENT_MODE: "cloud_container" } as NodeJS.ProcessEnv;

    expect(preloadApiEnvironment({ packageRoot, env })).toBe(false);
    expect(env.APP_ENV).toBeUndefined();
    expect(env.SHOULD_NOT_LOAD).toBeUndefined();
  });

  it("rejects cloud mode declared inside a file before applying any values", () => {
    const packageRoot = temporaryPackageRoot();
    writeFileSync(
      path.join(packageRoot, ".env"),
      "DEPLOYMENT_MODE=cloud_container\nAPP_ENV=production\nSHOULD_NOT_LOAD=repository-value\n",
      "utf8"
    );
    const env = {} as NodeJS.ProcessEnv;

    expect(() => preloadApiEnvironment({ packageRoot, env }))
      .toThrow("must be selected by the runtime environment");
    expect(env.DEPLOYMENT_MODE).toBeUndefined();
    expect(env.SHOULD_NOT_LOAD).toBeUndefined();
  });

  it("rejects CONFIG_PATH in cloud_container production", () => {
    const packageRoot = temporaryPackageRoot();
    expect(() => preloadApiEnvironment({
      packageRoot,
      env: {
        APP_ENV: "production",
        DEPLOYMENT_MODE: "cloud_container",
        CONFIG_PATH: path.join(path.dirname(packageRoot), "runtime.env")
      }
    })).toThrow("CONFIG_PATH is forbidden");
  });
});

function temporaryPackageRoot() {
  const directory = mkdtempSync(path.join(tmpdir(), "meta-api-env-"));
  temporaryDirectories.push(directory);
  return directory;
}
