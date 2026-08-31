import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { assembleLocalRelease } from "./assemble-local-release.mjs";
import { LOCAL_HOST_TOOL_FILES, WINDOWS_HOST_FILES } from "./verify-local-release.mjs";

test("assembler copies the complete installed dependency tree to both API and Web runtimes", async () => {
  const fixture = await fixtureRoot();
  const releaseParent = await mkdtemp(path.join(tmpdir(), "metaads-release-parent-"));
  const release = path.join(releaseParent, "release");
  try {
    const result = await assembleLocalRelease(fixture, release);
    assert.ok(result.copied > 0);
    assert.equal(await text(path.join(release, "api/node_modules/@tanstack/react-query/package.json")), "{}\n");
    assert.equal(await text(path.join(release, "web/node_modules/@tanstack/react-query/package.json")), "{}\n");
    assert.equal(await text(path.join(release, "web/server.js")), "server\n");
    await assert.rejects(readFile(path.join(release, "api/dist/auth/bootstrap-super-admin.cli.js")), { code: "ENOENT" });
    await assert.rejects(readFile(path.join(release, "api/node_modules/example/source.ts")), { code: "ENOENT" });
  } finally {
    await rm(fixture, { recursive: true, force: true });
    await rm(releaseParent, { recursive: true, force: true });
  }
});

test("assembler rejects an existing target instead of merging or overwriting it", async () => {
  const fixture = await fixtureRoot();
  const release = await mkdtemp(path.join(tmpdir(), "metaads-release-existing-"));
  try {
    await assert.rejects(assembleLocalRelease(fixture, release), { code: "EEXIST" });
  } finally {
    await rm(fixture, { recursive: true, force: true });
    await rm(release, { recursive: true, force: true });
  }
});

async function fixtureRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "metaads-release-source-"));
  const files = new Map([
    ["apps/api/dist/main.js", "main\n"],
    ["apps/api/dist/auth/bootstrap-local-super-admin.cli.js", "local\n"],
    ["apps/api/dist/auth/bootstrap-super-admin.cli.js", "forbidden\n"],
    ["apps/api/package.json", "{\"dependencies\":{}}\n"],
    ["apps/api/prisma/schema.prisma", "datasource db { provider = \"postgresql\" url = env(\"DATABASE_URL\") }\n"],
    ["apps/api/prisma/migrations/one/migration.sql", "SELECT 1;\n"],
    ["apps/web/.next/standalone/apps/web/server.js", "server\n"],
    ["apps/web/.next/standalone/apps/web/package.json", "{\"dependencies\":{}}\n"],
    ["apps/web/.next/standalone/apps/web/.next/BUILD_ID", "build\n"],
    ["apps/web/.next/standalone/apps/web/.next/server/app.js", "app\n"],
    ["apps/web/.next/static/chunk.js", "chunk\n"],
    ["node_modules/@tanstack/react-query/package.json", "{}\n"],
    ["node_modules/example/index.js", "module.exports={}\n"],
    ["node_modules/example/source.ts", "not runtime\n"]
  ]);
  for (const relative of [...LOCAL_HOST_TOOL_FILES, ...WINDOWS_HOST_FILES]) files.set(relative, "tool\n");
  for (const [relative, value] of files) {
    const target = path.join(root, ...relative.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, value);
  }
  return root;
}

async function text(file) {
  return readFile(file, "utf8");
}
