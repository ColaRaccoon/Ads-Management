import { createHash } from "node:crypto";

/** Preserve legacy byte hashing; explicitly bound CSV files dedupe per account. */
export function scopedCsvFileHash(buffer: Buffer, sourceConnectionId?: string) {
  const rawHash = createHash("sha256").update(buffer).digest("hex");
  return {
    rawHash,
    dedupeHash: sourceConnectionId
      ? createHash("sha256").update(`${sourceConnectionId}:${rawHash}`).digest("hex")
      : rawHash
  };
}
