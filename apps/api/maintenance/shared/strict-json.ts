import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

export const DEFAULT_PROTECTED_JSON_MAX_BYTES = 1024 * 1024;

export async function readProtectedJsonFile(
  filePath: string,
  maxBytes = DEFAULT_PROTECTED_JSON_MAX_BYTES
): Promise<unknown> {
  if (!filePath || filePath.includes("\0")) throw new Error("PROTECTED_JSON_PATH_INVALID");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("PROTECTED_JSON_LIMIT_INVALID");

  const pathMetadata = await lstat(filePath);
  if (pathMetadata.isSymbolicLink() || !pathMetadata.isFile()) throw new Error("PROTECTED_JSON_FILE_INVALID");
  if (pathMetadata.size < 2 || pathMetadata.size > maxBytes) throw new Error("PROTECTED_JSON_SIZE_INVALID");

  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | noFollow);
    const before = await handle.stat();
    assertSameFile(pathMetadata, before);
    if (!before.isFile() || before.size < 2 || before.size > maxBytes) {
      throw new Error("PROTECTED_JSON_SIZE_INVALID");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    assertSameFile(before, after);
    if (bytes.byteLength !== before.size || bytes.byteLength !== after.size || bytes.byteLength > maxBytes) {
      throw new Error("PROTECTED_JSON_FILE_CHANGED");
    }
    try {
      return JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error("PROTECTED_JSON_PARSE_FAILED");
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("PROTECTED_JSON_")) throw error;
    throw new Error("PROTECTED_JSON_FILE_INVALID");
  } finally {
    await handle?.close();
  }
}

export function asRecord(value: unknown, code = "OBJECT_REQUIRED"): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

export function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  code = "OBJECT_KEYS_INVALID"
): void {
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  if (actual.length !== allowed.length || actual.some((key, index) => key !== allowed[index])) {
    throw new Error(code);
  }
}

export function asStrictString(
  value: unknown,
  code = "STRING_INVALID",
  pattern?: RegExp,
  maximumLength = 512
): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximumLength || value !== value.trim()) {
    throw new Error(code);
  }
  if (pattern && !pattern.test(value)) throw new Error(code);
  return value;
}

export function asSafeInteger(
  value: unknown,
  code = "INTEGER_INVALID",
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(code);
  }
  return value as number;
}

export function asIsoTimestamp(value: unknown, code = "TIMESTAMP_INVALID"): string {
  const normalized = asStrictString(value, code, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/);
  if (!Number.isFinite(Date.parse(normalized))) throw new Error(code);
  return normalized;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalSha256(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortValue(item)])
  );
}

function assertSameFile(
  expected: { dev: number; ino: number; size: number; mtimeMs: number },
  actual: { dev: number; ino: number; size: number; mtimeMs: number }
): void {
  if (expected.dev !== actual.dev || expected.ino !== actual.ino || expected.size !== actual.size ||
      expected.mtimeMs !== actual.mtimeMs) {
    throw new Error("PROTECTED_JSON_FILE_CHANGED");
  }
}
