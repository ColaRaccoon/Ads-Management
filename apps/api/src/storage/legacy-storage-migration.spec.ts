import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { planLegacyLocalMigration } from "./legacy-storage-migration";
import { LocalFileStorage } from "./local-file-storage";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("legacy storage migration planning", () => {
  it("reports only provider/key/size/hash metadata and makes no target or delete change", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "legacy-storage-"));
    roots.push(root);
    const source = new LocalFileStorage(root);
    const body = Buffer.from("legacy safe fixture");
    await source.put({ key: "2026/08/legacy-report", body });
    const legacyPath = path.join(root, "2026", "08", "legacy-report");

    const plan = await planLegacyLocalMigration({
      workspacePath: legacyPath,
      source,
      targetProvider: "candidate",
      targetKey: "reports/server-generated-key"
    });

    expect(plan).toEqual({
      sourceProvider: "local",
      sourceKey: "2026/08/legacy-report",
      sourceSize: body.length,
      sourceHashSha256: createHash("sha256").update(body).digest("hex"),
      targetReference: "candidate:reports/server-generated-key"
    });
    expect(await source.exists("2026/08/legacy-report")).toBe(true);
  });
});
