import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED_PUBLIC_FILES = Object.freeze([
  "apps/api/dist/main.js",
  "apps/web/server.js",
  "deploy/launch-bundle.mjs",
  "deploy/cloud/ready-barrier.mjs"
]);

export async function assertRuntimeClosure(root) {
  const absoluteRoot = path.resolve(root);
  const entries = await walk(absoluteRoot);
  const files = new Set(entries.filter((entry) => entry.type === "file").map((entry) => entry.relative));
  for (const required of REQUIRED_PUBLIC_FILES) {
    if (!files.has(required)) fail("RUNTIME_REQUIRED_FILE_MISSING");
  }

  for (const entry of entries) {
    const relative = entry.relative;
    const lower = relative.toLowerCase();
    const basename = path.posix.basename(lower);
    const dependencyPath = relative.startsWith("node_modules/");
    if (entry.type === "symlink" && !dependencyPath) fail("RUNTIME_SYMLINK_FORBIDDEN");
    if (isTestOnlyDependency(lower)) fail("RUNTIME_TEST_DEPENDENCY_PRESENT");
    if (isBackupOnlyDependency(lower)) fail("RUNTIME_BACKUP_TOOLING_PRESENT");
    if (isMaintenancePath(lower)) fail("RUNTIME_MAINTENANCE_ARTIFACT_PRESENT");
    if (/(?:^|\/)prisma\/(?:schema\.prisma|migrations(?:\/|$))/u.test(lower)) fail("RUNTIME_MIGRATION_ARTIFACT_PRESENT");
    if (!dependencyPath && /(?:^|\/)[^/]+\.cli\.js$/u.test(lower)) fail("RUNTIME_MAINTENANCE_CLI_PRESENT");
    if (/(?:^|\/)sql\//u.test(lower) || lower.endsWith(".sql")) fail("RUNTIME_SQL_PRESENT");
    if (!dependencyPath && isDotenv(relative)) fail("RUNTIME_DOTENV_PRESENT");
    if (!dependencyPath && isPrivateKeyName(basename)) fail("RUNTIME_PRIVATE_KEY_PRESENT");
    if (!dependencyPath && /\.(?:ts|tsx|map)$/iu.test(relative)) fail("RUNTIME_SOURCE_PRESENT");
  }

  await assertNoPrivateKeyContent(absoluteRoot, entries);
  return Object.freeze({ result: "PASS", fileCount: files.size });
}

function isTestOnlyDependency(lower) {
  return /(?:^|\/)(?:apps\/e2e|node_modules\/(?:@meta-ads-performance\/e2e|@playwright|playwright(?:-core)?|\.bin\/playwright))(?:\/|$)/u.test(lower);
}

function isBackupOnlyDependency(lower) {
  return /(?:^|\/)node_modules\/(?:@aws-sdk|@smithy)(?:\/|$)/u.test(lower);
}

function isMaintenancePath(lower) {
  return lower === "maintenance" || lower.startsWith("maintenance/") ||
    lower.includes("/maintenance/") || lower.includes("dist-maintenance") ||
    /(?:^|\/)maintenance(?:-entrypoint|-artifact|-runtime)?(?:\.|-|\/)/u.test(lower) ||
    /(?:^|\/)assert-maintenance-artifact\.mjs$/u.test(lower);
}

async function assertNoPrivateKeyContent(root, entries) {
  const privateKeyMarkers = ["PRIVATE", "RSA PRIVATE", "EC PRIVATE"]
    .map((kind) => Buffer.from(`-----BEGIN ${kind} KEY-----`));
  for (const entry of entries) {
    if (entry.type !== "file" || entry.relative.startsWith("node_modules/") || entry.size > 1_048_576) continue;
    const value = await readFile(path.join(root, ...entry.relative.split("/")));
    if (privateKeyMarkers.some((marker) => value.includes(marker))) fail("RUNTIME_PRIVATE_KEY_PRESENT");
  }
}

async function walk(root) {
  const output = [];
  async function visit(directory, relativeDirectory = "") {
    let children;
    try {
      children = await readdir(directory, { withFileTypes: true });
    } catch {
      fail("RUNTIME_ROOT_UNREADABLE");
    }
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      const relative = path.posix.join(relativeDirectory, child.name);
      const absolute = path.join(directory, child.name);
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) output.push({ relative, type: "symlink", size: stat.size });
      else if (stat.isDirectory()) {
        output.push({ relative, type: "directory", size: stat.size });
        await visit(absolute, relative);
      } else if (stat.isFile()) output.push({ relative, type: "file", size: stat.size });
      else fail("RUNTIME_SPECIAL_FILE_FORBIDDEN");
    }
  }
  await visit(root);
  return output;
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
  const [root, ...extra] = process.argv.slice(2);
  if (!root || extra.length > 0) fail("RUNTIME_ASSERT_ARGUMENT_INVALID");
  const evidence = await assertRuntimeClosure(root);
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    const code = typeof error?.code === "string" ? error.code : "RUNTIME_CLOSURE_ASSERT_FAILED";
    process.stderr.write(`${JSON.stringify({ event: "runtime-closure-assert", result: "FAIL", code })}\n`);
    process.exitCode = 1;
  });
}
