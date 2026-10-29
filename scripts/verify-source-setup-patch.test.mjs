import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const verifier = fileURLToPath(new URL('../deploy/cloud/verify-source-setup-patch.mjs', import.meta.url));
// Fixture intentionally names every reviewed change, independently of the guard.
const existing = ['cafe24-manual-preparation', 'cafe24-oauth.service', 'cafe24-test-connection.service',
  'daily-sync.controller', 'daily-sync.dto', 'google-connection-verifier.service', 'meta-credential-binding.service',
  'source-connections.service', 'sync-contract', 'meta-credential-resolver', 'meta-protected-credential-resolver',
  'cafe24-reviewed-parity', 'cafe24-activation-evidence', 'cafe24-scheduled-review', 'cafe24-scheduled-activation',
  'daily-sync.module', 'scheduled-sync.service', 'scheduled-checkpoint', 'cafe24-sync-runner.service',
  'schedule-definition', 'scheduled-occurrence', 'sync-foundation.service', 'provider-run-scope'].map(n => `daily-sync/${n}.js`)
  .concat(['storefront/storefront-read.service.js', 'exchange-rates/exchange-rate-provider.js', 'auth/machine-sync.guard.js']);
const reporting = ['daily-sync/canonical-api-writer.service.js', 'daily-sync/meta-mcp-ads.client.js',
  'daily-sync/meta-mcp-capture.js', 'daily-sync/meta-mcp-purchase.js', 'daily-sync/meta-mcp-wire-reader.js',
  'domain/meta-current-metadata.js', 'domain/meta-reporting-measurements.js',
  'metrics/meta-ad-metrics-read.service.js', 'metrics/meta-creative-lifetimes.js'];
const google = ['app.module.js', 'google/google-access.js', 'google/google-mappings.service.js',
  'google/google-campaign-matcher.js', 'google/google-campaign-matcher.test.js',
  'google/google-performance.js', 'google/google-read.service.js', 'google/google-sale-configuration.js',
  'google/google.controller.js', 'google/google.dto.js', 'google/google.module.js',
  'google/google-performance.test.js', 'google/google.service.test.js'];
const cafe24 = ['daily-sync/cafe24-canonical-fingerprint.js', 'daily-sync/cafe24-canonical-writer.service.js',
  'daily-sync/cafe24-option-backfill.js', 'daily-sync/cafe24-order-adapter.js', 'daily-sync/cafe24-rule-loader.js',
  'domain/cafe24-csv.js', 'domain/cafe24-matcher.js', 'sales/cafe24-uploads.service.js', 'sales/dto/sales-transport.dto.js'];
const preserved = ['metrics/metrics.service.js', 'sales/sales-metrics.service.js',
  'coupang/coupang.service.js', 'domain/margin-calculator.js'];
const metaMappings = ['mappings/mappings.service.js', 'mappings/mappings.controller.js', 'mappings/dto/mappings-transport.dto.js'];

async function fixture(run, profile = 'reporting') {
  const root = await mkdtemp(join(tmpdir(), 'google-c7-guard-'));
  const baseline = join(root, 'baseline'), compiled = join(root, 'compiled');
  const put = async (dir, name, value) => { const path = join(dir, name); await mkdir(dirname(path), { recursive: true }); await writeFile(path, value); };
  try {
    for (const name of [...existing, ...(profile === 'reporting' ? reporting : [])]) {
      await put(baseline, name, 'old\n'); await put(compiled, name, 'reviewed\n');
    }
    if (profile === 'reporting') for (const name of google) {
      if (name === 'app.module.js') await put(baseline, name, 'old root module\n');
      await put(compiled, name, 'reviewed Google module\n');
    }
    if (profile === 'reporting') for (const name of cafe24) {
      if (name !== 'daily-sync/cafe24-option-backfill.js') await put(baseline, name, 'old Cafe24 module\n');
      await put(compiled, name, 'reviewed Cafe24 option mapping module\n');
    }
    if (profile === 'reporting') for (const name of metaMappings) {
      await put(baseline, name, 'old mapping module\n'); await put(compiled, name, 'reviewed editable mapping module\n');
    }
    for (const name of preserved) { await put(baseline, name, 'legacy\r\n'); await put(compiled, name, 'legacy\n'); }
    const verify = (selected = profile) => spawnSync(process.execPath,
      [verifier, baseline, compiled, ...(selected ? [selected] : [])], { encoding: 'utf8', windowsHide: true });
    await run({ baseline, compiled, put, verify });
  } finally {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('google-c7-guard-'));
    await rm(root, { recursive: true, force: true });
  }
}

test('reporting accepts the complete reviewed Google and Cafe24 patch and proves legacy groups unchanged', () => fixture(async ({ verify }) => {
  const result = verify(); assert.equal(result.status, 0, result.stderr);
  const proof = JSON.parse(result.stdout);
  assert.equal(proof.changed, existing.length + reporting.length + google.length + cafe24.length + metaMappings.length);
  for (const name of ['meta', 'cafe24', 'coupang', 'margin']) {
    assert.equal(proof.protectedUnchanged[name].files, 1);
    assert.match(proof.protectedUnchanged[name].sha256, /^[a-f0-9]{64}$/);
  }
}));

test('another Google module cannot bypass the exact allowlist', () => fixture(async ({ compiled, put, verify }) => {
  await put(compiled, 'google/unreviewed-helper.js', 'unexpected');
  const result = verify(); assert.notEqual(result.status, 0); assert.match(result.stderr, /Unreviewed C7 API change: google\/unreviewed-helper.js/);
}));

test('Meta and Coupang calculation mutations remain blocked', async () => {
  for (const name of ['sales/sales-metrics.service.js', 'coupang/coupang.service.js', 'domain/margin-calculator.js', 'domain/cafe24-sales-calculator.js', 'domain/cafe24-coupon-matcher.js'])
    await fixture(async ({ compiled, put, verify }) => { await put(compiled, name, 'regression'); const result = verify();
      assert.notEqual(result.status, 0); assert.ok(result.stderr.includes(`Unreviewed C7 API change: ${name}`)); });
});

test('missing reviewed Cafe24 module and unreviewed helpers fail closed', async () => {
  await fixture(async ({ compiled, verify }) => { await rm(join(compiled, 'daily-sync/cafe24-option-backfill.js'));
    const result = verify(); assert.notEqual(result.status, 0); assert.match(result.stderr, /Expected patch changes missing/); });
  await fixture(async ({ compiled, put, verify }) => { await put(compiled, 'daily-sync/cafe24-unreviewed.js', 'unexpected');
    const result = verify(); assert.notEqual(result.status, 0); assert.match(result.stderr, /Unreviewed C7 API change/); });
});

test('missing reviewed Google patch and removed legacy module fail closed', async () => {
  await fixture(async ({ compiled, verify }) => { await rm(join(compiled, 'google/google-read.service.js'));
    const result = verify(); assert.notEqual(result.status, 0); assert.match(result.stderr, /Expected patch changes missing/); });
  await fixture(async ({ compiled, verify }) => { await rm(join(compiled, 'coupang/coupang.service.js'));
    const result = verify(); assert.notEqual(result.status, 0); assert.match(result.stderr, /Removed C7 API module: coupang\/coupang.service.js/); });
});

test('original source setup profile keeps its old scope and rejects Google additions', () => fixture(async ({ compiled, put, verify }) => {
  const original = verify(); assert.equal(original.status, 0, original.stderr);
  await put(compiled, 'google/google-read.service.js', 'Google');
  const expanded = verify(); assert.notEqual(expanded.status, 0); assert.match(expanded.stderr, /Unreviewed C7 API change/);
}, ''));
