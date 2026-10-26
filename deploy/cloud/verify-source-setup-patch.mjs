import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
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
  for (const name of ['daily-sync/canonical-api-writer.service.js', 'daily-sync/meta-mcp-ads.client.js',
    'daily-sync/meta-mcp-capture.js', 'daily-sync/meta-mcp-purchase.js', 'daily-sync/meta-mcp-wire-reader.js',
    'domain/meta-current-metadata.js', 'domain/meta-reporting-measurements.js',
    'metrics/meta-ad-metrics-read.service.js', 'metrics/meta-creative-lifetimes.js']) expected.add(name);
}
if (!baseline || !compiled) throw Error('Two compiled directories required');
let checked = 0, changed = 0;
async function visit(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    if (item.isDirectory()) { await visit(path); continue; }
    if (!item.isFile() || !item.name.endsWith('.js')) continue;
    const name = relative(compiled, path).replaceAll('\\', '/');
    const next = await readFile(path, 'utf8');
    let before;
    try { before = await readFile(join(baseline, name), 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    checked++;
    if (next.replaceAll('\r\n', '\n') !== before?.replaceAll('\r\n', '\n')) {
      if (!expected.delete(name)) throw Error(`Unreviewed C7 API change: ${name}`);
      changed++;
    }
  }
}
await visit(compiled);
if (expected.size) throw Error('Expected patch changes missing');
console.log(JSON.stringify({ event: 'c7-api-patch-verified', checked, changed }));
