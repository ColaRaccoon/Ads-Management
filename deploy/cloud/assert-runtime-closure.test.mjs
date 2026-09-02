import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertRuntimeClosure } from "./assert-runtime-closure.mjs";

test("accepts the minimal public runtime closure", async (t) => {
  const root = await publicRuntime(t);
  const result = await assertRuntimeClosure(root);
  assert.equal(result.result, "PASS");
});

test("rejects maintenance payloads in the public runtime", async (t) => {
  for (const file of [
    "apps/api/dist-maintenance/auth/user-disposition.cli.js",
    "maintenance/purpose",
    "deploy/maintenance-entrypoint.mjs"
  ]) {
    const root = await publicRuntime(t);
    await put(root, file, "x");
    await assert.rejects(() => assertRuntimeClosure(root), withCode("RUNTIME_MAINTENANCE_ARTIFACT_PRESENT"));
  }
});

test("rejects migrations, CLI tools, SQL, dotenv, source maps, and signing keys", async (t) => {
  for (const [file, code, content = "x"] of [
    ["apps/api/prisma/schema.prisma", "RUNTIME_MIGRATION_ARTIFACT_PRESENT"],
    ["apps/api/dist/staging/tool.cli.js", "RUNTIME_MAINTENANCE_CLI_PRESENT"],
    ["policy.sql", "RUNTIME_SQL_PRESENT"],
    [".env", "RUNTIME_DOTENV_PRESENT"],
    ["apps/api/dist/main.js.map", "RUNTIME_SOURCE_PRESENT"],
    ["keys/signing-key.pem", "RUNTIME_PRIVATE_KEY_PRESENT", "-----BEGIN PRIVATE KEY-----"]
  ]) {
    const root = await publicRuntime(t);
    await put(root, file, content);
    await assert.rejects(() => assertRuntimeClosure(root), withCode(code));
  }
});

test("requires every public launch artifact", async (t) => {
  const root = await publicRuntime(t);
  await rm(path.join(root, "apps", "web", "server.js"));
  await assert.rejects(() => assertRuntimeClosure(root), withCode("RUNTIME_REQUIRED_FILE_MISSING"));
});

test("rejects the e2e workspace and Playwright from the public runtime", async (t) => {
  for (const file of [
    "apps/e2e/package.json",
    "node_modules/@meta-ads-performance/e2e/package.json",
    "node_modules/@playwright/test/index.js",
    "node_modules/playwright/index.js",
    "node_modules/playwright-core/index.js",
    "node_modules/.bin/playwright"
  ]) {
    const root = await publicRuntime(t);
    await put(root, file, "x");
    await assert.rejects(() => assertRuntimeClosure(root), withCode("RUNTIME_TEST_DEPENDENCY_PRESENT"));
  }
});

test("rejects backup-only AWS tooling from the public runtime", async (t) => {
  for (const file of [
    "node_modules/@aws-sdk/client-s3/package.json",
    "node_modules/@smithy/core/package.json"
  ]) {
    const root = await publicRuntime(t);
    await put(root, file, "{}\n");
    await assert.rejects(() => assertRuntimeClosure(root), withCode("RUNTIME_BACKUP_TOOLING_PRESENT"));
  }
});

async function publicRuntime(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "runtime-closure-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await put(root, "apps/api/dist/main.js", "export {};\n");
  await put(root, "apps/web/server.js", "export {};\n");
  await put(root, "deploy/launch-bundle.mjs", "export {};\n");
  await put(root, "deploy/cloud/ready-barrier.mjs", "export {};\n");
  await put(root, "node_modules/pkg/index.js", "module.exports = {};\n");
  return root;
}

async function put(root, relative, content) {
  const absolute = path.join(root, ...relative.split("/"));
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
}

function withCode(code) {
  return (error) => error?.code === code;
}
