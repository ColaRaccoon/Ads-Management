import { createHash } from "node:crypto";
import { LocalFileStorage } from "./local-file-storage";
import { legacyLocalPathToKey, storageReference } from "./storage-reference";

export type LegacyStorageMigrationPlan = {
  sourceProvider: "local";
  sourceKey: string;
  sourceSize: number;
  sourceHashSha256: string;
  targetReference: string;
};

/**
 * Read-only migration planning primitive. It streams and hashes the legacy object,
 * and deliberately performs no target upload, DB update, or source deletion.
 */
export async function planLegacyLocalMigration(input: {
  workspacePath: string;
  source: LocalFileStorage;
  targetProvider: string;
  targetKey: string;
}): Promise<LegacyStorageMigrationPlan> {
  const sourceKey = legacyLocalPathToKey(input.workspacePath, input.source.rootPath);
  const source = await input.source.getStream(sourceKey);
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of source.stream) {
    size += chunk.length;
    hash.update(chunk);
  }
  if (size !== source.size) {
    throw new Error("The legacy storage object changed during inspection.");
  }
  return {
    sourceProvider: "local",
    sourceKey,
    sourceSize: size,
    sourceHashSha256: hash.digest("hex"),
    targetReference: storageReference(input.targetProvider, input.targetKey)
  };
}
