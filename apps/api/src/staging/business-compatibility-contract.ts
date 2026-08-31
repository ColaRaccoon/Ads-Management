import { createHash } from "node:crypto";

export const BUSINESS_COMPATIBILITY_CONTRACT_VERSION = 2;
const MAX_CANONICAL_BYTES = 64 * 1024 * 1024;
const MAX_ARRAY_ITEMS = 100_000;
const MAX_NODES = 1_000_000;
const MAX_DEPTH = 64;

export function businessCompatibilityDigest(value: unknown) {
  const budget = { arrayItems: 0, nodes: 0 };
  const normalized = normalize(value, budget, 0);
  const canonical = JSON.stringify(normalized);
  const canonicalBytes = Buffer.byteLength(canonical, "utf8");
  if (canonicalBytes > MAX_CANONICAL_BYTES) throw new Error("BUSINESS_COMPATIBILITY_CANONICAL_SIZE_LIMIT");
  return {
    digest: createHash("sha256").update(canonical).digest("hex"),
    canonicalBytes,
    arrayItems: budget.arrayItems,
    outputCapsVerified: true
  };
}

function normalize(value: unknown, budget: { arrayItems: number; nodes: number }, depth: number): unknown {
  budget.nodes += 1;
  if (budget.nodes > MAX_NODES) throw new Error("BUSINESS_COMPATIBILITY_NODE_LIMIT");
  if (depth > MAX_DEPTH) throw new Error("BUSINESS_COMPATIBILITY_DEPTH_LIMIT");
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    budget.arrayItems += value.length;
    if (budget.arrayItems > MAX_ARRAY_ITEMS) throw new Error("BUSINESS_COMPATIBILITY_ARRAY_LIMIT");
    return value.map((entry) => normalize(entry, budget, depth + 1));
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().flatMap((key) => {
      const entry = record[key];
      return entry === undefined ? [] : [[key, normalize(entry, budget, depth + 1)]];
    }));
  }
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("BUSINESS_COMPATIBILITY_NON_FINITE_NUMBER");
  return value;
}
