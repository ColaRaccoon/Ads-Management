import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
const root = 'docs/product-performance/research/';
const source = root + '05-live-result-20261028-v2.json';
const destination = root + '05-live-result-20261028.json.gz';
const bytes = readFileSync(source), capture = JSON.parse(bytes);
assert.equal(capture.rowsChanged, 0); assert.equal(capture.queries.length, 32);
assert(capture.queries.every(q => q.status === 'SUCCESS'));
const identifiers = ['id','storeId','externalProductOrderId','orderSourceSignatureId','canonicalSalesUnitId','productId','parentSalesUnitId','snapshotId','sourceUploadId','campaignId','orderId','packageNumber','replacedUploadId'];
let rows = 0;
for (const query of capture.queries.filter(q => q.name.includes(':'))) {
  assert.equal(String(query.rows.rows.length), query.rows.row_count);
  rows += query.rows.rows.length;
  for (const row of query.rows.rows) {
    assert(!Object.keys(row).some(key => /rawPayload|receiver|customer(?:Name|Phone|Address|Id)|phone|address|credential|token|secret|originalFileName/i.test(key)), query.name);
    for (const key of identifiers) if (row[key] != null) assert.match(row[key], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  }
}
const compressed = gzipSync(bytes, { level: 9 }); writeFileSync(destination, compressed);
writeFileSync(root + '05-capture-receipt.json', JSON.stringify({ realBusinessData: true, sourceRowsChanged: 0, queries: 32,
  projectedRows: rows, sha256: createHash('sha256').update(bytes).digest('hex'), gzipSha256: createHash('sha256').update(compressed).digest('hex'),
  file: destination, rawBytes: bytes.length, gzipBytes: compressed.length, identifiersHashedOnServer: true,
  runtimeAccessProof: false, readMode: 'MANAGEMENT_READ_ONLY_NOT_RUNTIME_PROOF', atomicRemoteSnapshot: false }, null, 2) + '\n');
// Only this script's two explicitly named, generated captures are removed after successful validation/compression.
unlinkSync(source);
const first = root + '05-live-result-20261028.json'; if (existsSync(first)) unlinkSync(first);
console.log(JSON.stringify({ file: destination, projectedRows: rows, gzipBytes: compressed.length }));
