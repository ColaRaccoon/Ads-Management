import path from "node:path";
import { InvalidStorageKeyError } from "./file-storage";

const REFERENCE_PATTERN = /^([a-z][a-z0-9-]{0,31}):(.+)$/;

export type StorageReference = {
  provider: string;
  key: string;
};

export function storageReference(provider: string, key: string) {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(provider)) {
    throw new InvalidStorageKeyError();
  }
  return `${provider}:${normalizeStorageKey(key)}`;
}

export function parseStorageReference(value: string): StorageReference | null {
  const match = REFERENCE_PATTERN.exec(value);
  if (!match) return null;
  return { provider: match[1], key: normalizeStorageKey(match[2]) };
}

export function normalizeStorageKey(key: string) {
  if (
    !key ||
    key.length > 1_024 ||
    key.includes("\0") ||
    key.includes("\\") ||
    key.includes(":") ||
    /[\u0000-\u001f\u007f]/.test(key) ||
    path.posix.isAbsolute(key)
  ) {
    throw new InvalidStorageKeyError();
  }
  const normalized = path.posix.normalize(key);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized !== key ||
    normalized.split("/").some((segment) =>
      !segment || segment === "." || segment === ".." || /[. ]$/.test(segment) ||
      /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)
    )
  ) {
    throw new InvalidStorageKeyError();
  }
  return normalized;
}

export function legacyLocalPathToKey(workspacePath: string, storageRoot: string) {
  if (!workspacePath || workspacePath.includes("\0")) {
    throw new InvalidStorageKeyError();
  }
  const root = path.resolve(storageRoot);
  const absolutePath = path.resolve(process.cwd(), workspacePath);
  const relative = path.relative(root, absolutePath);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new InvalidStorageKeyError();
  }
  return normalizeStorageKey(relative.split(path.sep).join("/"));
}
