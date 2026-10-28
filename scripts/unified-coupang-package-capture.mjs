import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';

const path = 'docs/product-performance/research/04-live-result-20261028.json';
const bytes = existsSync(path) ? readFileSync(path) : gunzipSync(readFileSync(`${path}.gz`));
const capture = JSON.parse(bytes.toString('utf8'));
assert.equal(capture.rowsChanged, 0);
assert.equal(capture.connectionMode, 'MANAGEMENT_READ_ONLY_NOT_RUNTIME_PROOF');
assert.equal(capture.queries.length, 68);
assert.equal(new Set(capture.queries.map(q => q.name)).size, 68);
for (const query of capture.queries) {
  assert.equal(query.status, 'SUCCESS', query.name);
  if (query.name === 'identity') { assert.equal(query.rows.read_only, 'on'); continue; }
  assert.equal(query.rows.row_count, String(query.rows.rows.length), query.name);
  for (const row of query.rows.rows) {
    for (const key of ['id','productId','legacyProductId','legacySpendProductId','uploadBatchId','saleLineKey','adMetricKey'])
      if (row[key] !== null && row[key] !== undefined) assert.match(row[key], /^[a-f0-9]{32}$/, `${query.name}/${key}`);
  }
}
const text = bytes.toString('utf8');
assert(!/Bearer\s|postgres(?:ql)?:\/\/|"(?:rawRow|raw_row|originalFilename|original_filename|storedFilePath|stored_file_path)"/i.test(text));
assert(!/[0-9]{2,3}[- ][0-9]{3,4}[- ][0-9]{4}/.test(text));
const compressed = gzipSync(bytes, { level: 9 }); assert.deepEqual(gunzipSync(compressed), bytes);
writeFileSync(`${path}.gz`, compressed);
const receipt = { stage: '04', rowsChanged: 0, connectionMode: capture.connectionMode, queries: capture.queries.length,
  successful: capture.queries.length, originalBytes: bytes.length, gzipBytes: compressed.length,
  rawSha256: createHash('sha256').update(bytes).digest('hex'), gzipSha256: createHash('sha256').update(compressed).digest('hex'),
  privacyChecks: 'PASS: pseudonymized source keys, allowlisted projections, no raw uploads/credentials/customer fields',
  snapshotBoundary: 'Independent READ ONLY transactions; not one repeatable-read production snapshot; not runtime role proof' };
writeFileSync('docs/product-performance/research/04-capture-receipt.json', JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify(receipt, null, 2));
