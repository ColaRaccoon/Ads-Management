import { constants as fsConstants } from "node:fs";
import { copyFile, lstat, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { packageLocalRelease } from "./package-local-release.mjs";
import {
  FORBIDDEN_RELEASE_FILES,
  LOCAL_HOST_TOOL_FILES,
  WINDOWS_HOST_FILES,
  allowedReleaseFile
} from "./verify-local-release.mjs";

export async function assembleLocalRelease(sourceRootValue, releaseRootValue) {
  const sourceRoot = path.resolve(sourceRootValue ?? "");
  const releaseRoot = path.resolve(releaseRootValue ?? "");
  if (!sourceRootValue || !releaseRootValue || sourceRoot === releaseRoot) throw new Error("RELEASE_ASSEMBLY_ROOT_INVALID");
  const sourceInfo = await lstat(sourceRoot);
  const releaseParent = path.dirname(releaseRoot);
  const parentInfo = await lstat(releaseParent);
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink() || !parentInfo.isDirectory() || parentInfo.isSymbolicLink()) {
    throw new Error("RELEASE_ASSEMBLY_ROOT_INVALID");
  }

  let copied = 0;
  async function copyOne(sourceRelative, targetRelative = sourceRelative) {
    const normalized = targetRelative.split(path.sep).join("/");
    if (!allowedReleaseFile(normalized) || FORBIDDEN_RELEASE_FILES.includes(normalized)) return;
    const sourcePath = contained(sourceRoot, sourceRelative);
    const sourceFileInfo = await lstat(sourcePath);
    if (!sourceFileInfo.isFile() || sourceFileInfo.isSymbolicLink()) throw new Error("RELEASE_ASSEMBLY_SOURCE_INVALID");
    const targetPath = contained(releaseRoot, normalized);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await copyFile(sourcePath, targetPath, fsConstants.COPYFILE_EXCL);
    copied += 1;
  }

  async function copyTree(sourceDirectory, targetPrefix) {
    const absoluteSource = contained(sourceRoot, sourceDirectory);
    const sourceDirectoryInfo = await lstat(absoluteSource);
    if (!sourceDirectoryInfo.isDirectory() || sourceDirectoryInfo.isSymbolicLink()) throw new Error("RELEASE_ASSEMBLY_SOURCE_INVALID");
    const pending = [{ source: absoluteSource, relative: targetPrefix }];
    while (pending.length > 0) {
      const current = pending.pop();
      const entries = await readdir(current.source, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
      for (const entry of entries) {
        const sourcePath = path.join(current.source, entry.name);
        const relative = path.posix.join(current.relative.split(path.sep).join("/"), entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) pending.push({ source: sourcePath, relative });
        else if (entry.isFile()) await copyOne(path.relative(sourceRoot, sourcePath), relative);
        else throw new Error("RELEASE_ASSEMBLY_SOURCE_INVALID");
      }
    }
  }

  await mkdir(releaseRoot, { recursive: false });
  await copyTree("apps/api/dist", "api/dist");
  await copyOne("apps/api/package.json", "api/package.json");
  await copyTree("apps/api/prisma", "api/prisma");
  await copyTree("node_modules", "api/node_modules");
  await copyTree("apps/web/.next/standalone/apps/web", "web");
  await copyTree("node_modules", "web/node_modules");
  await copyTree("apps/web/.next/static", "web/.next/static");
  try {
    await copyTree("apps/web/public", "web/public");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  for (const relative of [...LOCAL_HOST_TOOL_FILES, ...WINDOWS_HOST_FILES]) await copyOne(relative);
  return Object.freeze({ releaseRoot, copied });
}

function contained(root, relative) {
  if (typeof relative !== "string" || relative.length < 1 || path.isAbsolute(relative) || path.win32.isAbsolute(relative)) {
    throw new Error("RELEASE_ASSEMBLY_PATH_INVALID");
  }
  const candidate = path.resolve(root, ...relative.replace(/\\/g, "/").split("/"));
  const relation = path.relative(root, candidate);
  if (!relation || relation === ".." || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    throw new Error("RELEASE_ASSEMBLY_PATH_INVALID");
  }
  return candidate;
}

function argumentsMap(values) {
  return new Map(values.map((argument) => {
    const separator = argument.indexOf("=");
    if (!argument.startsWith("--") || separator < 3) throw new Error("ARGUMENT_INVALID");
    return [argument.slice(2, separator), argument.slice(separator + 1)];
  }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = argumentsMap(process.argv.slice(2));
  const sourceRoot = args.get("source-root") ?? process.cwd();
  const releaseRoot = args.get("root");
  const releaseId = args.get("release-id") ?? "";
  const assembled = await assembleLocalRelease(sourceRoot, releaseRoot);
  const verified = await packageLocalRelease(assembled.releaseRoot, releaseId);
  process.stdout.write(`${JSON.stringify({
    event: "local-release.assembled-and-packaged",
    releaseId,
    copied: assembled.copied,
    fileCount: verified.fileCount,
    manifestSha256: verified.manifestSha256,
    migrationDigest: verified.migrationDigest,
    appliedMigrationDigest: verified.appliedMigrationDigest
  })}\n`);
}
