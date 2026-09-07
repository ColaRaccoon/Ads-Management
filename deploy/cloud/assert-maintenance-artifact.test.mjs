import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertMaintenanceArtifact, MAINTENANCE_PURPOSES } from "./assert-maintenance-artifact.mjs";

const cliByPurpose = {
  auth: ["dist/auth/user-disposition.cli.js"],
  migration: ["dist/migration/migration.cli.js"],
  storage: ["dist/storage/policy.cli.js", "dist/storage/token-artifact.cli.js"],
  backup: ["dist/backup/backup.cli.js"],
  legacy: ["dist/legacy/legacy.cli.js"]
};

for (const purpose of MAINTENANCE_PURPOSES) {
  test(`accepts the least-privilege ${purpose} artifact`, async (t) => {
    const root = await fixture(t, purpose);
    const result = await assertMaintenanceArtifact(root, purpose, {
      execFileImpl: async () => ({ stdout: "pg_dump (PostgreSQL) 17.11 (Debian 17.11-1.pgdg12+2)\n", stderr: "" })
    });
    assert.equal(result.result, "PASS");
    assert.equal(result.purpose, purpose);
    if (purpose === "backup") assert.equal(result.pgDumpVersion, "17.11");
  });
}

test("rejects a foreign purpose payload", async (t) => {
  const root = await fixture(t, "auth");
  await put(root, "dist/backup/backup.cli.js", "export {};\n");
  await assert.rejects(() => assertMaintenanceArtifact(root, "auth"), withCode("MAINTENANCE_FOREIGN_PURPOSE_PRESENT"));
});

test("rejects public runtime, unexpected CLI, dotenv, source, and signing material", async (t) => {
  for (const [file, code, content = "x"] of [
    ["server.js", "MAINTENANCE_PUBLIC_RUNTIME_PRESENT"],
    ["dist/auth/extra.cli.js", "MAINTENANCE_UNEXPECTED_CLI_PRESENT"],
    [".env.production", "MAINTENANCE_DOTENV_PRESENT"],
    ["dist/auth/source.ts", "MAINTENANCE_SOURCE_PRESENT"],
    ["secret.pem", "MAINTENANCE_PRIVATE_KEY_PRESENT", "-----BEGIN PRIVATE KEY-----"]
  ]) {
    const root = await fixture(t, "auth");
    await put(root, file, content);
    await assert.rejects(() => assertMaintenanceArtifact(root, "auth"), withCode(code));
  }
});

test("auth requires only its exact compiled bootstrap runtime closure", async (t) => {
  for (const missing of [
    "dist/runtime-auth/bootstrap-super-admin.js",
    "dist/runtime-auth/email-normalizer.js"
  ]) {
    const root = await fixture(t, "auth");
    await rm(path.join(root, ...missing.split("/")));
    await assert.rejects(() => assertMaintenanceArtifact(root, "auth"), withCode("MAINTENANCE_REQUIRED_FILE_MISSING"));
  }
  for (const unexpected of [
    "dist/runtime-auth/identity-provider.js",
    "dist/runtime-auth/bootstrap-super-admin.ts",
    "dist/runtime-auth/nested/extra.js"
  ]) {
    const root = await fixture(t, "auth");
    await put(root, unexpected, "export {};\n");
    await assert.rejects(() => assertMaintenanceArtifact(root, "auth"), withCode("MAINTENANCE_UNEXPECTED_RUNTIME_PRESENT"));
  }
  const migrationRoot = await fixture(t, "migration");
  await put(migrationRoot, "dist/runtime-auth/bootstrap-super-admin.js", "export {};\n");
  await assert.rejects(
    () => assertMaintenanceArtifact(migrationRoot, "migration"),
    withCode("MAINTENANCE_UNEXPECTED_RUNTIME_PRESENT")
  );
});

test("rejects the e2e workspace and Playwright from maintenance artifacts", async (t) => {
  for (const file of [
    "apps/e2e/package.json",
    "node_modules/@meta-ads-performance/e2e/package.json",
    "node_modules/@playwright/test/index.js",
    "node_modules/playwright/index.js",
    "node_modules/playwright-core/index.js",
    "node_modules/.bin/playwright"
  ]) {
    const root = await fixture(t, "auth");
    await put(root, file, "x");
    await assert.rejects(() => assertMaintenanceArtifact(root, "auth"), withCode("MAINTENANCE_TEST_DEPENDENCY_PRESENT"));
  }
});

test("requires backup runtime modules and keeps AWS tooling backup-only", async (t) => {
  for (const missing of [
    "node_modules/@aws-sdk/client-s3/package.json",
    "node_modules/@aws-sdk/client-s3/dist-cjs/index.js",
    "node_modules/@prisma/client/package.json",
    "node_modules/@prisma/client/default.js",
    "node_modules/.prisma/client/index.js",
    "node_modules/.prisma/client/default.js"
  ]) {
    const root = await fixture(t, "backup");
    await rm(path.join(root, ...missing.split("/")));
    await assert.rejects(() => assertMaintenanceArtifact(root, "backup"), withCode("MAINTENANCE_REQUIRED_FILE_MISSING"));
  }
  for (const purpose of ["auth", "migration", "storage", "legacy"]) {
    const root = await fixture(t, purpose);
    await put(root, "node_modules/@aws-sdk/client-s3/package.json", "{}\n");
    await assert.rejects(() => assertMaintenanceArtifact(root, purpose), withCode("MAINTENANCE_BACKUP_TOOLING_PRESENT"));
  }
});

test("backup verifies its fixed pg_dump executable major without database credentials", async (t) => {
  const root = await fixture(t, "backup");
  const calls = [];
  const result = await assertMaintenanceArtifact(root, "backup", {
    execFileImpl: async (...args) => {
      calls.push(args);
      return { stdout: "pg_dump (PostgreSQL) 17.11 (Debian 17.11-1.pgdg12+2)\n", stderr: "" };
    }
  });
  assert.equal(result.pgDumpVersion, "17.11");
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "/usr/bin/pg_dump");
  assert.deepEqual(calls[0][1], ["--version"]);
  assert.deepEqual(calls[0][2], {
    encoding: "utf8", timeout: 5000, maxBuffer: 4096, windowsHide: true, shell: false,
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }
  });
});

test("backup rejects old, different-major, malformed and failed pg_dump version probes", async (t) => {
  const root = await fixture(t, "backup");
  for (const stdout of [
    "pg_dump (PostgreSQL) 15.19 (Debian 15.19-0+deb12u1)\n",
    "pg_dump (PostgreSQL) 18.6\n",
    "pg_dump (PostgreSQL) 170.1\n",
    "pg_dump (PostgreSQL) 17\n",
    "pg_dump (PostgreSQL) 17.11\nunexpected output\n",
    ""
  ]) {
    await assert.rejects(
      () => assertMaintenanceArtifact(root, "backup", { execFileImpl: async () => ({ stdout, stderr: "" }) }),
      withCode("MAINTENANCE_BACKUP_PG_DUMP_VERSION_INVALID")
    );
  }
  await assert.rejects(
    () => assertMaintenanceArtifact(root, "backup", {
      execFileImpl: async () => ({ stdout: "pg_dump (PostgreSQL) 17.11\n", stderr: "unexpected warning" })
    }),
    withCode("MAINTENANCE_BACKUP_PG_DUMP_VERSION_INVALID")
  );
  await assert.rejects(
    () => assertMaintenanceArtifact(root, "backup", {
      execFileImpl: async () => { throw new Error("version probe unavailable"); }
    }),
    withCode("MAINTENANCE_BACKUP_PG_DUMP_VERSION_UNAVAILABLE")
  );
});

test("non-backup artifacts never invoke PostgreSQL tooling", async (t) => {
  for (const purpose of MAINTENANCE_PURPOSES.filter((value) => value !== "backup")) {
    const root = await fixture(t, purpose);
    let calls = 0;
    await assertMaintenanceArtifact(root, purpose, {
      execFileImpl: async () => { calls += 1; throw new Error("unexpected version probe"); }
    });
    assert.equal(calls, 0);
  }
});

test("legacy carries exactly its two review schemas", async (t) => {
  for (const missing of [
    "contracts/legacy/legacy-provider-binding.v1.schema.json",
    "contracts/legacy/legacy-source-inventory-approval.v1.schema.json"
  ]) {
    const root = await fixture(t, "legacy");
    await rm(path.join(root, ...missing.split("/")));
    await assert.rejects(() => assertMaintenanceArtifact(root, "legacy"), withCode("MAINTENANCE_REQUIRED_FILE_MISSING"));
  }
  const root = await fixture(t, "legacy");
  await put(root, "contracts/legacy/unexpected.schema.json", "{}\n");
  await assert.rejects(() => assertMaintenanceArtifact(root, "legacy"), withCode("MAINTENANCE_UNEXPECTED_CONTRACT_PRESENT"));
});

test("rejects runtime mount payloads and verified legacy snapshots from immutable artifacts", async (t) => {
  for (const file of [
    `source-inventory-${"a".repeat(64)}.json`,
    "maintenance-output/legacy/evidence.json",
    "legacy-source/source-a/object.bin"
  ]) {
    const root = await fixture(t, "legacy");
    await put(root, file, "{}\n");
    await assert.rejects(
      () => assertMaintenanceArtifact(root, "legacy"),
      withCode("MAINTENANCE_RUNTIME_OUTPUT_PRESENT")
    );
  }
});

test("keeps Prisma and SQL payloads purpose-scoped", async (t) => {
  const authRoot = await fixture(t, "auth");
  await put(authRoot, "prisma/schema.prisma", "generator client {}\n");
  await assert.rejects(() => assertMaintenanceArtifact(authRoot, "auth"), withCode("MAINTENANCE_PRISMA_SCOPE_VIOLATION"));

  const backupRoot = await fixture(t, "backup");
  await put(backupRoot, "sql/storage-policy.sql", "select 1;\n");
  await assert.rejects(() => assertMaintenanceArtifact(backupRoot, "backup"), withCode("MAINTENANCE_SQL_SCOPE_VIOLATION"));

  const migrationRoot = await fixture(t, "migration");
  await rm(path.join(migrationRoot, "prisma", "migrations"), { recursive: true, force: false });
  await assert.rejects(() => assertMaintenanceArtifact(migrationRoot, "migration"), withCode("MAINTENANCE_MIGRATION_CHAIN_MISSING"));
});

test("maintenance dependency and runtime stages pin and verify the Bookworm PCRE2 security fix", async () => {
  const dockerfile = (await readFile(new URL("./maintenance.Dockerfile", import.meta.url), "utf8")).replace(/\r\n/gu, "\n");
  for (const stage of ["dependencies", "maintenance-base"]) {
    const section = dockerfile.split(new RegExp(`^FROM .* AS ${stage}\\r?\\n`, "mu"))[1]?.split(/^FROM /mu)[0];
    assert.ok(section, `Missing ${stage} stage`);
    assert.match(section, /apt-get install[^\n]*\blibpcre2-8-0=10\.42-1\+deb12u1(?:\s|$)/u);
    assert.match(section, /dpkg-query --show --showformat='\$\{Version\}\\n' libpcre2-8-0 \| grep -Fx '10\.42-1\+deb12u1'/u);
  }
});

test("backup alone installs exact PostgreSQL 17 client from checksum-bound signed Bookworm PGDG", async () => {
  const dockerfile = (await readFile(new URL("./maintenance.Dockerfile", import.meta.url), "utf8")).replace(/\r\n/gu, "\n");
  const backup = dockerfile.split(/^FROM maintenance-base AS backup\n/mu)[1]?.split(/^FROM /mu)[0];
  assert.ok(backup);
  assert.match(backup, /ADD --checksum=sha256:0144068502a1eddd2a0280ede10ef607d1ec592ce819940991203941564e8e76 --chmod=0644 https:\/\/www\.postgresql\.org\/media\/keys\/ACCC4CF8\.asc \/usr\/share\/keyrings\/postgresql-pgdg\.asc/u);
  assert.match(backup, /URIs: https:\/\/apt\.postgresql\.org\/pub\/repos\/apt/u);
  assert.match(backup, /Suites: bookworm-pgdg/u);
  assert.match(backup, /Components: main 17/u);
  assert.match(backup, /Signed-By: \/usr\/share\/keyrings\/postgresql-pgdg\.asc/u);
  assert.match(backup, /amd64\|arm64\|ppc64el/u);
  assert.match(backup, /postgresql-client-17=17\.11-1\.pgdg12\+2/u);
  assert.match(backup, /libpq5=17\.11-1\.pgdg12\+2/u);
  assert.match(backup, /postgresql-client-common=293\.pgdg12\+1/u);
  assert.match(backup, /dpkg-query --show --showformat='\$\{Version\}\\n' postgresql-client-17 \| grep -Fx '17\.11-1\.pgdg12\+2'/u);
  assert.match(backup, /dpkg-query --show --showformat='\$\{Version\}\\n' libpq5 \| grep -Fx '17\.11-1\.pgdg12\+2'/u);
  assert.doesNotMatch(dockerfile, /(?:\bpostgresql-client\s|apt-get\s+(?:dist-upgrade|upgrade)|--allow-unauthenticated|trusted=yes|curl[^\n]*\|[^\n]*sh)/u);
  assert.equal((dockerfile.match(/apt\.postgresql\.org\/pub\/repos\/apt/gu) ?? []).length, 1);
});

test("Dockerfile defines five isolated targets without credential build arguments or public ports", async () => {
  // Git archives may honor the Windows checkout line endings; compare logical Dockerfile lines.
  const dockerfile = (await readFile(new URL("./maintenance.Dockerfile", import.meta.url), "utf8")).replace(/\r\n/gu, "\n");
  for (const purpose of MAINTENANCE_PURPOSES) {
    assert.match(dockerfile, new RegExp(`FROM maintenance-base AS ${purpose}\\n`));
    assert.match(dockerfile, new RegExp(`io\\.meta-ads\\.maintenance\\.purpose=${purpose}`));
    assert.match(dockerfile, new RegExp(`dist-maintenance/${purpose} ./dist/${purpose}`));
  }
  assert.doesNotMatch(dockerfile, /^ARG\s+.*(?:SECRET|TOKEN|PASSWORD|DATABASE_URL|KEY)/imu);
  assert.doesNotMatch(dockerfile, /^EXPOSE\s+/mu);
  assert.doesNotMatch(dockerfile, /^HEALTHCHECK\s+/mu);
  assert.match(dockerfile, /npm install --omit=dev --legacy-peer-deps --no-save --package-lock=false prisma@6\.12\.0/u);
  assert.match(dockerfile, /apps\/api\/dist-maintenance\/shared \.\/dist\/shared/u);
  assert.match(dockerfile, /COPY apps\/e2e\/package\.json apps\/e2e\/package\.json/u);
  assert.match(dockerfile, /COPY packages\/shared\/package\.json packages\/shared\/package\.json/u);
  assert.match(dockerfile, /rm -rf node_modules\/@playwright node_modules\/playwright node_modules\/playwright-core node_modules\/@meta-ads-performance\/e2e/u);
  assert.match(dockerfile, /apps\/api\/dist\/auth\/bootstrap-super-admin\.js \.\/dist\/runtime-auth\/bootstrap-super-admin\.js/u);
  assert.match(dockerfile, /apps\/api\/dist\/auth\/email-normalizer\.js \.\/dist\/runtime-auth\/email-normalizer\.js/u);
  assert.match(dockerfile, /install -d -m 0700 -o node -g node \/run\/maintenance-output\/migration/u);
  assert.match(dockerfile, /install -d -m 0700 -o node -g node \/run\/maintenance-output\/backup/u);
  assert.match(dockerfile, /install -d -m 0700 -o node -g node \/run\/maintenance-output\/legacy/u);
  assert.match(dockerfile, /apt-get install --yes --no-install-recommends postgresql-client-17=17\.11-1\.pgdg12\+2/u);
  assert.match(dockerfile, /test -x \/usr\/bin\/pg_dump/u);
  assert.match(dockerfile, /test -x \/usr\/bin\/prlimit/u);
  assert.match(dockerfile, /require\('@aws-sdk\/client-s3'\)/u);
  assert.match(dockerfile, /Backup Prisma runtime closure invalid/u);
  assert.match(dockerfile, /Legacy Prisma runtime closure invalid/u);
  assert.match(dockerfile, /FROM production-dependencies AS runtime-dependencies\nRUN rm -rf node_modules\/@aws-sdk node_modules\/@smithy/u);
  assert.match(dockerfile, /FROM maintenance-base AS backup[\s\S]*COPY --from=production-dependencies --chown=node:node \/srv\/app\/node_modules \.\/node_modules/u);
  assert.equal((dockerfile.match(/COPY --from=production-dependencies --chown=node:node \/srv\/app\/node_modules \.\/node_modules/gu) ?? []).length, 1);
  assert.equal((dockerfile.match(/COPY --from=runtime-dependencies --chown=node:node \/srv\/app\/node_modules \.\/node_modules/gu) ?? []).length, 3);
  assert.match(dockerfile, /apps\/api\/maintenance\/legacy\/contracts \.\/contracts\/legacy/u);
  assert.doesNotMatch(dockerfile, /apps\/web\/(?:\.next|server\.js)/u);
  assert.doesNotMatch(dockerfile, /apps\/api\/dist(?:\s|\/)\.\/apps\/api\/dist/u);
});

async function fixture(t, purpose) {
  const root = await mkdtemp(path.join(os.tmpdir(), "maintenance-artifact-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await put(root, "purpose", `${purpose}\n`);
  await put(root, "maintenance-entrypoint.mjs", "export {};\n");
  await put(root, "dist/shared/index.js", "export {};\n");
  for (const file of cliByPurpose[purpose]) await put(root, file, "export {};\n");
  if (purpose === "auth") {
    await put(root, "dist/runtime-auth/bootstrap-super-admin.js", "export {};\n");
    await put(root, "dist/runtime-auth/email-normalizer.js", "export {};\n");
  }
  if (purpose === "backup" || purpose === "legacy") {
    await put(root, "node_modules/@prisma/client/package.json", "{}\n");
    await put(root, "node_modules/@prisma/client/default.js", "module.exports = {};\n");
    await put(root, "node_modules/.prisma/client/index.js", "module.exports = {};\n");
    await put(root, "node_modules/.prisma/client/default.js", "module.exports = {};\n");
  }
  if (purpose === "backup") {
    await put(root, "node_modules/@aws-sdk/client-s3/package.json", "{}\n");
    await put(root, "node_modules/@aws-sdk/client-s3/dist-cjs/index.js", "module.exports = {};\n");
  }
  if (purpose === "legacy") {
    await put(root, "contracts/legacy/legacy-provider-binding.v1.schema.json", "{}\n");
    await put(root, "contracts/legacy/legacy-source-inventory-approval.v1.schema.json", "{}\n");
  }
  if (purpose === "migration") {
    await put(root, "prisma/schema.prisma", "generator client {}\n");
    await put(root, "prisma/migrations/001_init/migration.sql", "select 1;\n");
  }
  if (purpose === "storage") await put(root, "sql/storage-policy.sql", "select 1;\n");
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
