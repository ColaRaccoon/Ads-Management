import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertExactKeys,
  canonicalJson,
  canonicalSha256,
  readProtectedJsonFile
} from "./strict-json";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("strict maintenance JSON", () => {
  it("reads one bounded regular JSON file", async () => {
    const directory = await makeTemporaryDirectory();
    const filePath = path.join(directory, "manifest.json");
    await writeFile(filePath, JSON.stringify({ version: "v1" }), { flag: "wx" });
    await expect(readProtectedJsonFile(filePath, 128)).resolves.toEqual({ version: "v1" });
  });

  it("rejects symlinks, invalid JSON, oversize input, and unknown keys", async () => {
    const directory = await makeTemporaryDirectory();
    const regularPath = path.join(directory, "regular.json");
    const linkPath = path.join(directory, "link.json");
    await writeFile(regularPath, "{not-json", { flag: "wx" });
    if (process.platform === "win32") await mkdir(linkPath);
    else await symlink(regularPath, linkPath);

    await expect(readProtectedJsonFile(linkPath)).rejects.toThrow("PROTECTED_JSON_FILE_INVALID");
    await expect(readProtectedJsonFile(regularPath)).rejects.toThrow("PROTECTED_JSON_PARSE_FAILED");
    await expect(readProtectedJsonFile(regularPath, 4)).rejects.toThrow("PROTECTED_JSON_SIZE_INVALID");
    expect(() => assertExactKeys({ version: "v1", unexpected: true }, ["version"]))
      .toThrow("OBJECT_KEYS_INVALID");
  });

  it("canonicalizes recursively before hashing", () => {
    expect(canonicalJson({ z: 1, a: { y: 2, b: 3 } })).toBe('{"a":{"b":3,"y":2},"z":1}');
    expect(canonicalSha256({ b: 2, a: 1 })).toBe(canonicalSha256({ a: 1, b: 2 }));
  });
});

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "cloud-maintenance-json-"));
  temporaryDirectories.push(directory);
  return directory;
}
