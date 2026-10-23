import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const destinationRoot = path.join(root, "deploy", "cafe24-test", ".build");
const sourcePaths = [
  ".npmrc", "package.json", "package-lock.json", "tsconfig.base.json",
  "apps/api/package.json", "apps/api/tsconfig.json", "apps/api/tsconfig.cafe24-test.json",
  "apps/api/prisma/cafe24-test.schema.prisma", "apps/api/prisma/schema.prisma",
  "apps/api/src/common/prisma-idle.ts", "apps/api/src/common/prisma.service.ts",
  "apps/api/src/daily-sync/sync-contract.ts",
  "apps/api/src/daily-sync/bounded-request.ts",
  "apps/api/src/daily-sync/cafe24-rate-limit.ts",
  "apps/api/src/daily-sync/cafe24-test-connection.service.ts",
  "apps/api/src/daily-sync/credential-vault.ts",
  "apps/api/src/daily-sync/cafe24-oauth.service.ts",
  "apps/api/src/daily-sync/cafe24-order-preflight.client.ts",
  "apps/api/src/daily-sync/cafe24-observed-revision.ts",
  "apps/api/src/daily-sync/cafe24-observation.service.ts",
  "apps/api/src/daily-sync/cafe24-railway-test.ts",
  "apps/api/src/security-audit/security-audit.types.ts",
  "packages/shared/package.json",
  "deploy/cafe24-test/init.sql", "deploy/cafe24-test/observe-additive.sql", "deploy/cafe24-test/live-additive.sql"
];
// Traverse only these two 06 entrypoints; the complete Prisma schema supplies
// generated type/metadata compatibility, not another provider's runtime code.
const pending=["apps/api/src/daily-sync/cafe24-railway-test.ts",
  "apps/api/src/daily-sync/cafe24-live-canonical.cli.ts"];
const visited=new Set();
while (pending.length) {
  const source=pending.pop();
  if (visited.has(source)) continue;
  visited.add(source);
  if (/(?:^|\/)(?:meta-|mappings\/|metrics\/)|\/uploads\/meta-/i.test(source))
    throw new Error(`Unrelated provider runtime in Cafe24 dependency graph: ${source}`);
  if (!sourcePaths.includes(source)) sourcePaths.push(source);
  const ast=ts.createSourceFile(source,readFileSync(path.join(root,source),"utf8"),ts.ScriptTarget.Latest,true);
  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
    const specifier=statement.moduleSpecifier;
    if (!specifier || !ts.isStringLiteral(specifier) || !specifier.text.startsWith(".")) continue;
    const base=path.posix.normalize(path.posix.join(path.posix.dirname(source),specifier.text));
    const target=[`${base}.ts`,`${base}/index.ts`].find((candidate) => existsSync(path.join(root,candidate)));
    if (!target || !target.startsWith("apps/api/src/")) throw new Error("Unsupported Cafe24 dependency boundary");
    pending.push(target);
  }
}
sourcePaths.sort();
const entries = sourcePaths.map((source) => {
  const bytes = readFileSync(path.join(root, source));
  return { source, bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
});
const docker = readFileSync(path.join(root, "deploy", "cafe24-test.Dockerfile"));
const inventory = [...entries.map(({ source, sha256 }) => ({ source, sha256 })),
  { source: "Dockerfile", sha256: createHash("sha256").update(docker).digest("hex") }];
const manifest = JSON.stringify(inventory);
const digest = createHash("sha256").update(manifest).digest("hex");
const destination = path.join(destinationRoot, digest);
const expectedFiles = [...sourcePaths, "Dockerfile", "manifest.json"].sort();
function verifyContext() {
  const found = [];
  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error("Cafe24 context contains a symlink");
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) found.push(path.relative(destination, full).replaceAll("\\", "/"));
      else throw new Error("Cafe24 context contains an unsupported entry");
    }
  }
  visit(destination);
  if (JSON.stringify(found.sort()) !== JSON.stringify(expectedFiles))
    throw new Error("Cafe24 context inventory mismatch");
  for (const entry of entries) {
    const actual = createHash("sha256").update(readFileSync(path.join(destination, entry.source))).digest("hex");
    if (actual !== entry.sha256) throw new Error("Cafe24 context source mismatch");
  }
  const dockerHash = createHash("sha256").update(readFileSync(path.join(destination, "Dockerfile"))).digest("hex");
  if (dockerHash !== inventory.at(-1).sha256 ||
      readFileSync(path.join(destination, "manifest.json"), "utf8") !== `${manifest}\n`)
    throw new Error("Cafe24 context manifest mismatch");
}
if (!existsSync(destination)) {
  mkdirSync(destination, { recursive: true });
  for (const entry of entries) {
    const target = path.join(destination, entry.source);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, entry.bytes, { flag: "wx" });
  }
  writeFileSync(path.join(destination, "Dockerfile"), docker, { flag: "wx" });
  writeFileSync(path.join(destination, "manifest.json"), `${manifest}\n`, { flag: "wx" });
}
verifyContext();
if (sourcePaths.some((source) => /(?:^|\/)(?:meta-|metrics\/|migrations\/)|\/uploads\/meta-/i.test(source)))
  throw new Error("Unrelated source in Cafe24 build context");
process.stdout.write(`${destination}\n`);
