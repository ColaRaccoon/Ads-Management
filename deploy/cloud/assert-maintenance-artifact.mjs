import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MAINTENANCE_PURPOSES = Object.freeze(["auth", "migration", "storage", "backup", "legacy"]);

const REQUIRED_CLI = Object.freeze({
  auth: ["dist/auth/user-disposition.cli.js"],
  migration: ["dist/migration/migration.cli.js"],
  storage: ["dist/storage/policy.cli.js", "dist/storage/token-artifact.cli.js"],
  backup: ["dist/backup/backup.cli.js"],
  legacy: ["dist/legacy/legacy.cli.js"]
});
const AUTH_RUNTIME_FILES = Object.freeze([
  "dist/runtime-auth/bootstrap-super-admin.js",
  "dist/runtime-auth/email-normalizer.js"
]);
const PRISMA_RUNTIME_FILES = Object.freeze([
  "node_modules/@prisma/client/package.json",
  "node_modules/@prisma/client/default.js",
  "node_modules/.prisma/client/index.js",
  "node_modules/.prisma/client/default.js"
]);
const LEGACY_CONTRACT_FILES = Object.freeze([
  "contracts/legacy/legacy-provider-binding.v1.schema.json",
  "contracts/legacy/legacy-source-inventory-approval.v1.schema.json"
]);

export async function assertMaintenanceArtifact(root, purpose) {
  if (!MAINTENANCE_PURPOSES.includes(purpose)) fail("MAINTENANCE_PURPOSE_INVALID");
  const absoluteRoot = path.resolve(root);
  const entries = await walk(absoluteRoot);
  const files = new Set(entries.filter((entry) => entry.type === "file").map((entry) => entry.relative));
  const directories = new Set(entries.filter((entry) => entry.type === "directory").map((entry) => entry.relative));

  await requirePurposeMarker(absoluteRoot, purpose);
  requireFile(files, "maintenance-entrypoint.mjs");
  requireDirectory(directories, "dist/shared");
  requireDirectory(directories, `dist/${purpose}`);
  for (const cli of REQUIRED_CLI[purpose]) requireFile(files, cli);
  if (purpose === "auth") {
    requireDirectory(directories, "dist/runtime-auth");
    for (const runtimeFile of AUTH_RUNTIME_FILES) requireFile(files, runtimeFile);
  }
  if (purpose === "backup" || purpose === "legacy") {
    for (const runtimeFile of PRISMA_RUNTIME_FILES) requireFile(files, runtimeFile);
  }
  if (purpose === "backup") {
    requireFile(files, "node_modules/@aws-sdk/client-s3/package.json");
    requireFile(files, "node_modules/@aws-sdk/client-s3/dist-cjs/index.js");
  }
  if (purpose === "legacy") {
    requireDirectory(directories, "contracts");
    requireDirectory(directories, "contracts/legacy");
    for (const contractFile of LEGACY_CONTRACT_FILES) requireFile(files, contractFile);
  }

  const allowedAuthRuntimeEntries = new Set(["dist/runtime-auth", ...AUTH_RUNTIME_FILES]);
  const allowedLegacyContractEntries = new Set(["contracts", "contracts/legacy", ...LEGACY_CONTRACT_FILES]);
  for (const entry of entries) {
    if (entry.relative === "dist/runtime-auth" || entry.relative.startsWith("dist/runtime-auth/")) {
      if (purpose !== "auth" || !allowedAuthRuntimeEntries.has(entry.relative)) {
        fail("MAINTENANCE_UNEXPECTED_RUNTIME_PRESENT");
      }
    }
    if (entry.relative === "contracts" || entry.relative.startsWith("contracts/")) {
      if (purpose !== "legacy" || !allowedLegacyContractEntries.has(entry.relative)) {
        fail("MAINTENANCE_UNEXPECTED_CONTRACT_PRESENT");
      }
    }
  }

  for (const foreignPurpose of MAINTENANCE_PURPOSES) {
    if (foreignPurpose !== purpose && hasPath(entries, `dist/${foreignPurpose}`)) {
      fail("MAINTENANCE_FOREIGN_PURPOSE_PRESENT");
    }
  }

  for (const entry of entries) {
    const relative = entry.relative;
    const lower = relative.toLowerCase();
    const basename = path.posix.basename(lower);
    const dependencyPath = relative.startsWith("node_modules/");
    if (entry.type === "symlink" && !dependencyPath) fail("MAINTENANCE_SYMLINK_FORBIDDEN");
    if (isTestOnlyDependency(lower)) fail("MAINTENANCE_TEST_DEPENDENCY_PRESENT");
    if (isBackupOnlyDependency(lower) && purpose !== "backup") fail("MAINTENANCE_BACKUP_TOOLING_PRESENT");
    if (/(?:^|\/)(?:maintenance-output|legacy-source)(?:\/|$)/u.test(lower) ||
        /^source-inventory-[a-f0-9]{64}\.json$/u.test(basename)) {
      fail("MAINTENANCE_RUNTIME_OUTPUT_PRESENT");
    }
    if (/^(?:apps\/web\/server\.js|apps\/api\/dist\/main\.js|server\.js|deploy\/launch-bundle\.mjs)$/u.test(relative)) {
      fail("MAINTENANCE_PUBLIC_RUNTIME_PRESENT");
    }
    if (!dependencyPath && isDotenv(relative)) fail("MAINTENANCE_DOTENV_PRESENT");
    if (!dependencyPath && isPrivateKeyName(basename)) fail("MAINTENANCE_PRIVATE_KEY_PRESENT");
    if (!dependencyPath && /\.(?:ts|tsx|map)$/iu.test(relative)) {
      fail("MAINTENANCE_SOURCE_PRESENT");
    }
    if (!dependencyPath && relative.endsWith(".cli.js") && !REQUIRED_CLI[purpose].includes(relative)) {
      fail("MAINTENANCE_UNEXPECTED_CLI_PRESENT");
    }
  }

  if (purpose === "migration") {
    requireFile(files, "prisma/schema.prisma");
    if (![...files].some((file) => /^prisma\/migrations\/[^/]+\/migration\.sql$/u.test(file))) {
      fail("MAINTENANCE_MIGRATION_CHAIN_MISSING");
    }
  } else if (hasPath(entries, "prisma")) {
    fail("MAINTENANCE_PRISMA_SCOPE_VIOLATION");
  }

  if (purpose === "storage") {
    requireFile(files, "sql/storage-policy.sql");
    const extraSql = [...files].filter((file) => file.startsWith("sql/") && file !== "sql/storage-policy.sql");
    if (extraSql.length > 0) fail("MAINTENANCE_SQL_SCOPE_VIOLATION");
  } else if (hasPath(entries, "sql")) {
    fail("MAINTENANCE_SQL_SCOPE_VIOLATION");
  }

  await assertNoPrivateKeyContent(absoluteRoot, entries);
  return Object.freeze({ purpose, fileCount: files.size, result: "PASS" });
}

function isTestOnlyDependency(lower) {
  return /(?:^|\/)(?:apps\/e2e|node_modules\/(?:@meta-ads-performance\/e2e|@playwright|playwright(?:-core)?|\.bin\/playwright))(?:\/|$)/u.test(lower);
}

function isBackupOnlyDependency(lower) {
  return /(?:^|\/)node_modules\/(?:@aws-sdk|@smithy)(?:\/|$)/u.test(lower);
}

async function requirePurposeMarker(root, expected) {
  let actual;
  try {
    actual = (await readFile(path.join(root, "purpose"), "utf8")).trim();
  } catch {
    fail("MAINTENANCE_PURPOSE_MARKER_MISSING");
  }
  if (actual !== expected) fail("MAINTENANCE_PURPOSE_MARKER_MISMATCH");
}

async function assertNoPrivateKeyContent(root, entries) {
  const privateKeyMarkers = ["PRIVATE", "RSA PRIVATE", "EC PRIVATE"]
    .map((kind) => Buffer.from(`-----BEGIN ${kind} KEY-----`));
  for (const entry of entries) {
    if (entry.type !== "file" || entry.relative.startsWith("node_modules/") || entry.size > 1_048_576) continue;
    const value = await readFile(path.join(root, ...entry.relative.split("/")));
    if (privateKeyMarkers.some((marker) => value.includes(marker))) {
      fail("MAINTENANCE_PRIVATE_KEY_PRESENT");
    }
  }
}

async function walk(root) {
  const output = [];
  async function visit(directory, relativeDirectory = "") {
    let children;
    try {
      children = await readdir(directory, { withFileTypes: true });
    } catch {
      fail("MAINTENANCE_ARTIFACT_ROOT_UNREADABLE");
    }
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      const relative = path.posix.join(relativeDirectory, child.name);
      const absolute = path.join(directory, child.name);
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) {
        output.push({ relative, type: "symlink", size: stat.size });
      } else if (stat.isDirectory()) {
        output.push({ relative, type: "directory", size: stat.size });
        await visit(absolute, relative);
      } else if (stat.isFile()) {
        output.push({ relative, type: "file", size: stat.size });
      } else {
        fail("MAINTENANCE_SPECIAL_FILE_FORBIDDEN");
      }
    }
  }
  await visit(root);
  return output;
}

function hasPath(entries, prefix) {
  return entries.some((entry) => entry.relative === prefix || entry.relative.startsWith(`${prefix}/`));
}

function requireFile(files, file) {
  if (!files.has(file)) fail("MAINTENANCE_REQUIRED_FILE_MISSING");
}

function requireDirectory(directories, directory) {
  if (!directories.has(directory)) fail("MAINTENANCE_REQUIRED_DIRECTORY_MISSING");
}

function isDotenv(relative) {
  return relative.split("/").some((part) => part === ".env" || part.startsWith(".env."));
}

function isPrivateKeyName(basename) {
  return /(?:^|[._-])(?:private|signing)?[._-]?key(?:$|[._-])/iu.test(basename) || /\.(?:pem|key|p12|pfx|jks)$/iu.test(basename);
}

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

async function main() {
  const [root, purpose, ...extra] = process.argv.slice(2);
  if (!root || !purpose || extra.length > 0) fail("MAINTENANCE_ASSERT_ARGUMENT_INVALID");
  const evidence = await assertMaintenanceArtifact(root, purpose);
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    const code = typeof error?.code === "string" ? error.code : "MAINTENANCE_ARTIFACT_ASSERT_FAILED";
    process.stderr.write(`${JSON.stringify({ event: "maintenance-artifact-assert", result: "FAIL", code })}\n`);
    process.exitCode = 1;
  });
}
