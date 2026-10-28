import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
const expected = new Set(['cafe24-manual-preparation', 'cafe24-oauth.service', 'cafe24-test-connection.service',
  'daily-sync.controller', 'daily-sync.dto', 'google-connection-verifier.service', 'meta-credential-binding.service',
  'source-connections.service', 'sync-contract', 'meta-credential-resolver',
  'meta-protected-credential-resolver', 'cafe24-reviewed-parity', 'cafe24-activation-evidence',
  'cafe24-scheduled-review', 'cafe24-scheduled-activation', 'daily-sync.module',
  'scheduled-sync.service', 'scheduled-checkpoint', 'cafe24-sync-runner.service',
  'schedule-definition', 'scheduled-occurrence', 'sync-foundation.service', 'provider-run-scope'].map(name => `daily-sync/${name}.js`));
expected.add('storefront/storefront-read.service.js');
expected.add('exchange-rates/exchange-rate-provider.js');
expected.add('auth/machine-sync.guard.js');
const [baseline, compiled, profile] = process.argv.slice(2);
if (profile !== undefined && profile !== 'reporting') throw Error('Unknown patch profile');
if (profile === 'reporting') {
  // Cafe24 now retains provider option_value separately and applies explicit
  // product/option predicates. Keep the reviewed scope exact; financial
  // calculators, coupons, other sources and deleted modules stay protected.
  for (const name of ['daily-sync/cafe24-canonical-fingerprint.js',
    'daily-sync/cafe24-canonical-writer.service.js', 'daily-sync/cafe24-option-backfill.js',
    'daily-sync/cafe24-order-adapter.js', 'daily-sync/cafe24-rule-loader.js',
    'domain/cafe24-csv.js', 'domain/cafe24-matcher.js',
    'sales/cafe24-uploads.service.js', 'sales/dto/sales-transport.dto.js']) expected.add(name);
  for (const name of ['daily-sync/canonical-api-writer.service.js', 'daily-sync/meta-mcp-ads.client.js',
    'daily-sync/meta-mcp-capture.js', 'daily-sync/meta-mcp-purchase.js', 'daily-sync/meta-mcp-wire-reader.js',
    'domain/meta-current-metadata.js', 'domain/meta-reporting-measurements.js',
    'metrics/meta-ad-metrics-read.service.js', 'metrics/meta-creative-lifetimes.js']) expected.add(name);
  // Google is an additive, reviewed feature in the reporting image. Keep each
  // generated module explicit: a new google/*.js file still requires review.
  for (const name of ['app.module.js',
    'google/google-access.js', 'google/google-mappings.service.js', 'google/google-campaign-matcher.js',
    'google/google-performance.js', 'google/google-read.service.js',
    'google/google-sale-configuration.js', 'google/google.controller.js',
    'google/google.dto.js', 'google/google.module.js',
    // The existing build excludes *.spec.ts, but emits these *.test.ts files.
    'google/google-performance.test.js', 'google/google.service.test.js', 'google/google-campaign-matcher.test.js']) expected.add(name);
}
if (!baseline || !compiled) throw Error('Two compiled directories required');
let checked = 0, changed = 0;
const compiledNames = new Set();
const protectedLegacy = { meta: [], cafe24: [], coupang: [], margin: [] };
const reviewedChanges = new Set(expected);
function protectedGroup(name) {
  if (reviewedChanges.has(name)) return null;
  if (/^(metrics|decisions|reports)\//.test(name)) return 'meta';
  if (name.startsWith('sales/') || ['domain/cafe24-sales-calculator.js', 'domain/cafe24-coupon-matcher.js'].includes(name)) return 'cafe24';
  if (name.startsWith('coupang/') || /^domain\/coupang[^/]*\.js$/.test(name)) return 'coupang';
  if (name === 'domain/margin-calculator.js') return 'margin';
  return null;
}
async function visit(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    if (item.isDirectory()) { await visit(path); continue; }
    if (!item.isFile() || !item.name.endsWith('.js')) continue;
    const name = relative(compiled, path).replaceAll('\\', '/');
    compiledNames.add(name);
    const next = await readFile(path, 'utf8');
    let before;
    try { before = await readFile(join(baseline, name), 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    checked++;
    if (next.replaceAll('\r\n', '\n') !== before?.replaceAll('\r\n', '\n')) {
      if (!expected.delete(name)) throw Error(`Unreviewed C7 API change: ${name}`);
      changed++;
    }
    const group = protectedGroup(name);
    if (group) protectedLegacy[group].push([name, createHash('sha256').update(next.replaceAll('\r\n', '\n')).digest('hex')]);
  }
}
await visit(compiled);
// An additive patch may not silently omit a compiled legacy module. Checking
// only the new tree would miss deletions, even though changes are allowlisted.
async function verifyBaselineFiles(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    if (item.isDirectory()) { await verifyBaselineFiles(path); continue; }
    if (!item.isFile() || !item.name.endsWith('.js')) continue;
    const name = relative(baseline, path).replaceAll('\\', '/');
    if (!compiledNames.has(name)) throw Error(`Removed C7 API module: ${name}`);
  }
}
await verifyBaselineFiles(baseline);
if (expected.size) throw Error('Expected patch changes missing');
const protectedUnchanged = Object.fromEntries(Object.entries(protectedLegacy).map(([group, entries]) => {
  entries.sort(([a], [b]) => a.localeCompare(b));
  return [group, { files: entries.length, sha256: createHash('sha256').update(JSON.stringify(entries)).digest('hex') }];
}));
console.log(JSON.stringify({ event: 'c7-api-patch-verified', checked, changed, protectedUnchanged }));
