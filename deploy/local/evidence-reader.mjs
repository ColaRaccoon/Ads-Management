import { lstatSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

export function readJsonEvidence(value, { label = "EVIDENCE", allowMissingLeaf = false } = {}) {
  if (typeof value !== "string" || !value) return null;
  const bytes = readBoundedEvidence(value, 1_048_576, label, allowMissingLeaf);
  return bytes === null ? null : JSON.parse(bytes.toString("utf8"));
}

export function readJsonEvidenceSnapshot(value, { label = "EVIDENCE" } = {}) {
  if (typeof value !== "string" || !value) return null;
  const bytes = readBoundedEvidence(value, 1_048_576, label, false);
  return { bytes, value: JSON.parse(bytes.toString("utf8")), sha256: createHash("sha256").update(bytes).digest("hex") };
}

function readBoundedEvidence(value, maximumBytes, label, allowMissingLeaf) {
  const resolved = path.resolve(value);
  const root = path.parse(resolved).root;
  const segments = resolved.slice(root.length).split(path.sep).filter(Boolean);
  let cursor = root;
  for (let index = 0; index < segments.length; index += 1) {
    cursor = path.join(cursor, segments[index]);
    let stat;
    try {
      stat = lstatSync(cursor);
    } catch (error) {
      if (allowMissingLeaf && index === segments.length - 1 && error?.code === "ENOENT") return null;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`${label}_REPARSE_REJECTED`);
    if (index === segments.length - 1 && (!stat.isFile() || stat.size < 1 || stat.size > maximumBytes)) {
      throw new Error(`${label}_FILE_INVALID`);
    }
  }
  return readFileSync(resolved);
}
