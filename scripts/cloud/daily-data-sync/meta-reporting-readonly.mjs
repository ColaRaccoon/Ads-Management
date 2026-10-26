import { readFileSync } from 'node:fs';
import { MetaMcpAdsClient } from '../../../apps/api/src/daily-sync/meta-mcp-ads.client.ts';
import { META_REPORTING_FIELDS } from '../../../apps/api/src/domain/meta-reporting-measurements.ts';

// Reads one day only. No database, source selection, or publication entry point.
try {
  const day = process.env.META_REPORTING_PROBE_DAY;
  const accountId = process.env.META_REPORTING_PROBE_ACCOUNT;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? '') || !/^\d+$/.test(accountId ?? '')) throw new Error('input');
  const catalog = JSON.parse(readFileSync(process.env.DAILY_SYNC_META_MCP_CATALOG_PATH, 'utf8'));
  const reporting = JSON.parse(readFileSync(process.env.DAILY_SYNC_META_MCP_REPORTING_SCHEMA_PATH, 'utf8'));
  const client = new MetaMcpAdsClient(catalog, reporting);
  const snapshot = await client.fetchDay({ accountId, day, deadlineAt: Date.now() + 300000,
    accessToken: process.env.META_REPORTING_PROBE_TOKEN,
    settings: { actionReportTime: 'MCP_PROVIDER_DEFAULT_UNVERIFIED', attributionWindows: [] } });
  const fields = Object.fromEntries(Object.keys(META_REPORTING_FIELDS).map(field => [field, {
    observedRows: snapshot.ads.filter(row => row[field] != null).length,
    missingRows: snapshot.ads.filter(row => row[field] == null).length,
    positiveRows: snapshot.ads.filter(row => row[field] > 0).length
  }]));
  console.log(JSON.stringify({ status: 'READ_ONLY_VERIFIED', day, adRows: snapshot.ads.length,
    adsetRows: snapshot.adsets.length, pages: snapshot.pageCount, fields, databaseWrites: 0 }));
} catch (error) {
  const safeCode = typeof error?.safeCode === 'string' && /^[A-Z_]{1,60}$/.test(error.safeCode) ? error.safeCode : 'PROBE_FAILED';
  console.log(JSON.stringify({ status: 'READ_ONLY_FAILED', safeCode, databaseWrites: 0 }));
  process.exitCode = 1;
}
