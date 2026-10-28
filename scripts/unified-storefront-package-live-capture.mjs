// Package reviewed, pseudonymized READ ONLY evidence without committing large raw JSON files.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";

const directory = "docs/product-performance/research";
const local = resolve(process.env.LOCALAPPDATA, "UnifiedPerformanceStage03Evidence/20261028");
const read = path => JSON.parse(readFileSync(path, "utf8"));
const prefix = read(resolve(local, "cafe24-prefix.json"));
const suffix = read(resolve(local, "cafe24-suffix.json"));
for (const capture of [prefix, suffix]) {
  assert.equal(capture.projectRef, "iygjmosbelbosfxidqxv");
  assert.equal(capture.connectionMode, "MANAGEMENT_READ_ONLY_NOT_RUNTIME_PROOF");
  assert.equal(capture.rowsChanged, 0);
}
const cafe = { ...prefix, queries: [...prefix.queries, ...suffix.queries] };
const cafeText = JSON.stringify(cafe, null, 2) + "\n";
writeFileSync(resolve(local, "03-live-cafe24-result-20261028.json"), cafeText, { flag: "wx" });
const adsText = readFileSync(`${directory}/03-live-ads-result-20261028.json`, "utf8");
for (const [platform, capture, text] of [["cafe24", cafe, cafeText], ["ads", JSON.parse(adsText), adsText]]) {
  const manifest = read(`${directory}/03-live-${platform}-queries-20261028.json`);
  assert.deepEqual(capture.queries.map(query => query.name), manifest.map(query => query.name));
  assert.equal(new Set(capture.queries.map(query => query.name)).size, manifest.length);
  assert(capture.queries.every(query => query.status === "SUCCESS"));
  const raw = Buffer.from(text, "utf8"), compressed = gzipSync(raw, { level: 9 });
  assert(gunzipSync(compressed).equals(raw));
  const output = `${directory}/03-live-${platform}-result-20261028.json.gz`;
  writeFileSync(output, compressed, { flag: "wx" });
  console.log(JSON.stringify({ platform, queries: manifest.length, bytes: raw.length, compressedBytes: compressed.length,
    sha256: createHash("sha256").update(raw).digest("hex"), output }));
}
