// Offline Prisma 6 schema diff. The empty migration name was created by Supabase CLI.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from "node:fs";
import { resolve, basename } from "node:path";
const source = process.argv[2];
if (!source || !/^\d{14}_unified_performance_foundation\.sql$/.test(basename(source))) throw Error("Expected CLI-created empty migration.");
if (readFileSync(source, "utf8").trim()) throw Error("Refusing to replace nonempty SQL.");
const runtime = resolve(process.env.LOCALAPPDATA, "UnifiedPerformanceStage02");
const oldSchema = resolve(runtime, "before.prisma");
writeFileSync(oldSchema, execFileSync("git", ["show", "HEAD:apps/api/prisma/schema.prisma"], { encoding: "utf8" }));
const generated = execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "diff", "--from-schema-datamodel", oldSchema,
  "--to-schema-datamodel", "apps/api/prisma/schema.prisma", "--script"], { encoding: "utf8", windowsHide: true });
if (/DROP\s|ALTER TABLE\s+"(?!unified_)/i.test(generated)) throw Error("Unexpected legacy change.");
const directory = resolve("apps/api/prisma/migrations", basename(source, ".sql"));
if (existsSync(directory)) throw Error("Migration already exists.");
mkdirSync(directory);
renameSync(source, resolve(directory, "migration.sql"));
writeFileSync(resolve(directory, "migration.sql"), "-- Generated offline from the existing Prisma 6 schema; no source ownership changes.\n" + generated);
console.log(directory);
