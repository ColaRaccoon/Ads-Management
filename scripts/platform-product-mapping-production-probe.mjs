import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
const expected = '1117fb072ea6726e54c869f3e55033055ffa585a';
assert(process.env.INTERNAL_PROBE_TOKEN, 'PROBE_TOKEN_MISSING');
const response = await fetch('https://patimagroup-work.com/backend-api/health/ready', { redirect: 'error',
  headers: { 'x-internal-probe-token': process.env.INTERNAL_PROBE_TOKEN }, signal: AbortSignal.timeout(30000) });
assert(response.ok, 'READY_HTTP_FAILURE');
const body = await response.json(); assert.equal(body.status, 'ready'); assert.equal(body.releaseId, expected); assert(body.runtimeConfigFingerprint);
const page = await fetch('https://patimagroup-work.com/products/mappings', { redirect: 'error', signal: AbortSignal.timeout(30000) });
assert(page.ok, 'MAPPING_PAGE_HTTP_FAILURE');
const result = { status: 'PASS', checkedAt: new Date().toISOString(), release: body.releaseId, readyStatus: body.status,
  runtimeConfigFingerprint: body.runtimeConfigFingerprint, mappingsPageHttpStatus: page.status };
writeFileSync('reports/platform-product-mapping-audit-20261103/deployment/live-readiness.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
