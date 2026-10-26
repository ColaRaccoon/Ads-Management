import test from 'node:test';
import assert from 'node:assert/strict';
import { metaPurchaseWire, metaPurchaseCatalog } from './meta-day-batch.fixtures.mjs';
import { metaMcpFields, validateMetaMcpCatalog } from '../../../apps/api/src/daily-sync/meta-mcp-wire-reader.ts';
import { META_REPORTING_FIELDS, metaReportingFields } from '../../../apps/api/src/domain/meta-reporting-measurements.ts';
import { createMetaMcpPurchaseResidualProof } from '../../../apps/api/src/daily-sync/meta-mcp-purchase.ts';
import { normalizeMetaMcpPurchaseSnapshot } from '../../../apps/api/src/daily-sync/meta-mcp-ads.client.ts';
import { validCurrentMetadata } from '../../../apps/api/src/domain/meta-current-metadata.ts';
import { CanonicalApiWriterService } from '../../../apps/api/src/daily-sync/canonical-api-writer.service.ts';
import { aggregateMetaVideoMetrics } from '../../../apps/api/src/domain/meta-video-metrics.ts';
import { aggregateCreativeLifetimes, creativeLifetimeKey } from '../../../apps/api/src/metrics/meta-creative-lifetimes.ts';
import { selectMetaMcpDay } from '../../../apps/api/src/daily-sync/meta-mcp-capture.ts';

function fixture(profile = 'REPORTING_V2') {
  const wire = metaPurchaseWire(); wire.profile = profile;
  for (const [level, rows] of Object.entries(wire.levels)) {
    wire.queries[level].fields = [...metaMcpFields(profile)[level]];
    if (profile === 'REPORTING_V2' && ['ad', 'adset'].includes(level)) {
      for (const row of rows) for (const field of metaReportingFields(level === 'ad')) row[META_REPORTING_FIELDS[field]] = '7';
    }
    for (const row of rows) { row.amount_spent.value = '10'; row.impressions = '100'; row.reach = '80'; }
  }
  const catalog = metaPurchaseCatalog(wire);
  const allFields = [...new Set(Object.values(metaMcpFields(profile)).flat())];
  for (const name of allFields) if (!catalog.fields.some(f => f.name === name))
    catalog.fields.push({ name, type: 'INTEGER', is_metric: true, levels: Object.keys(wire.levels).filter(level => metaMcpFields(profile)[level].includes(name)) });
  return { wire, catalog };
}
function normalize({ wire, catalog }) {
  return normalizeMetaMcpPurchaseSnapshot(wire, { version: 1, transport: 'META_ADS_MCP', purchaseProof: createMetaMcpPurchaseResidualProof(wire, catalog) }, catalog);
}

test('V2 preserves source counts, source-default context and purchase reconciliation; old V1 captures remain readable', () => {
  const input = fixture(), original = JSON.stringify(input.wire), snapshot = normalize(input);
  const ad = snapshot.ads[0];
  assert.equal(ad.videoPlay25Count, 7); assert.equal(ad.addToCartCount, 7);
  assert.equal(ad.landingPageViews, 7); assert.equal(ad.shopClicks, 7);
  assert.equal(ad.costPerLandingPageViewUsd, '1.4286');
  assert.equal(ad.purchaseCount, 0); assert.equal(ad.videoPlay3sCount, null);
  assert.equal(ad.metricUnavailableReasons.videoPlay3sCount, 'UNSUPPORTED_FIELD');
  assert.equal(ad.metricUnavailableReasons.videoPlay25Count, undefined);
  assert.equal(ad.attributionSetting, null); assert.equal(ad.actionReportTime, 'MCP_PROVIDER_DEFAULT_UNVERIFIED');
  for (const row of [...snapshot.ads, ...snapshot.adsets]) assert.equal(validCurrentMetadata(row.currentMetadata), true);
  assert.equal(JSON.stringify(input.wire), original);
  assert.equal(aggregateMetaVideoMetrics(snapshot.ads).videoPlay25RatePct, 8.75);
  assert.equal(aggregateMetaVideoMetrics([ad, ad]).videoPlay25RatePct, null);
  const legacy = normalize(fixture('PURCHASE_V1')).ads[0];
  assert.equal(legacy.videoPlay25Count, null); assert.equal(legacy.currentMetadata.sourceContext.reportingMeasurement, undefined);
});

test('null remains unknown, explicit zero remains zero; malformed values, wrong profile and changed proof fail', () => {
  const input = fixture(); input.wire.levels.ad[0].video_p25_watched_actions = null;
  input.wire.levels.ad[0].omni_add_to_cart = '0';
  const ad = normalize(input).ads[0];
  assert.equal(ad.videoPlay25Count, null); assert.equal(ad.metricUnavailableReasons.videoPlay25Count, 'PARTIAL_METRIC');
  assert.equal(ad.addToCartCount, 0); assert.equal(ad.metricUnavailableReasons.addToCartCount, undefined);
  for (const value of ['-1', '0.5', '2147483648', {}, true]) {
    const bad = fixture(); bad.wire.levels.ad[0].video_p25_watched_actions = value;
    assert.throws(() => normalize(bad));
  }
  const wrong = fixture(); wrong.wire.profile = 'PURCHASE_V1'; assert.throws(() => normalize(wrong));
  const proof = createMetaMcpPurchaseResidualProof(input.wire, input.catalog);
  input.wire.levels.ad[0].video_p50_watched_actions = '8';
  assert.throws(() => normalizeMetaMcpPurchaseSnapshot(input.wire, { version: 1, transport: 'META_ADS_MCP', purchaseProof: proof }, input.catalog));
});

test('zero-basic projection cannot silently discard positive optional reporting actions', () => {
  const { wire } = fixture();
  for (const [level, rows] of Object.entries(wire.levels)) for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      if (value && typeof value === 'object' && 'unit' in value) value.value = '0';
      if (['impressions', 'clicks', 'reach', 'frequency', 'link_click', 'omni_purchase', 'offsite_conversion_fb_pixel_purchase', ...Object.values(META_REPORTING_FIELDS)].includes(key)) row[key] = '0';
    }
    if (level === 'adset') for (const key of ['impressions', 'clicks', 'reach', 'frequency', 'link_click', 'omni_purchase', 'omni_purchase_values', 'offsite_conversion_fb_pixel_purchase', 'offsite_conversion_fb_pixel_purchase_values']) row[key] = null;
  }
  assert.equal(selectMetaMcpDay(wire).wire.levels.ad.length, 0);
  for (const [level, key] of [['ad', 'omni_add_to_cart'], ['ad', 'video_p25_watched_actions'], ['adset', 'landing_page_view']]) {
    const bad = structuredClone(wire); bad.levels[level][0][key] = '1';
    assert.throws(() => selectMetaMcpDay(bad));
  }
  const unreferenced = structuredClone(wire); unreferenced.levels.ad = [];
  unreferenced.levels.adset[0].shop_clicks = '1';
  assert.throws(() => selectMetaMcpDay(unreferenced));
});

test('writer permits only source-bound V2 measurements and rejects forged or missing provenance before publication', async () => {
  const oldTransport = process.env.DAILY_SYNC_META_TRANSPORT, oldUseCase = process.env.DAILY_SYNC_META_MCP_USE_CASE;
  process.env.DAILY_SYNC_META_TRANSPORT = 'MCP'; process.env.DAILY_SYNC_META_MCP_USE_CASE = 'OWN_ACCOUNT_INTERNAL_REPORTING';
  let calls = 0;
  const writer = new CanonicalApiWriterService({}, { publishUnit: async () => { calls++; return 'validated'; } }, {}, {}, {});
  const input = { ...normalize(fixture()), connectionId: '11111111-1111-4111-8111-111111111111', metricDate: new Date('2026-10-08T00:00:00Z'), expectedMetaTransport: 'MCP' };
  try {
    assert.equal(await writer.publishMetaDay(input), 'validated');
    for (const change of [
      r => { r.videoPlay25Count = 99; },
      r => { delete r.currentMetadata.sourceContext.reportingMeasurement; },
      r => { r.currentMetadata.sourceContext.reportingMeasurement.values.videoPlay3sCount = 1; r.videoPlay3sCount = 1; },
      r => { r.metricUnavailableReasons.videoPlay25Count = 'PARTIAL_METRIC'; },
      r => { r.resultCount = 7; }
    ]) {
      const bad = structuredClone(input); change(bad.ads[0]);
      await assert.rejects(() => writer.publishMetaDay(bad));
    }
    assert.equal(calls, 1);
  } finally {
    if (oldTransport === undefined) delete process.env.DAILY_SYNC_META_TRANSPORT; else process.env.DAILY_SYNC_META_TRANSPORT = oldTransport;
    if (oldUseCase === undefined) delete process.env.DAILY_SYNC_META_MCP_USE_CASE; else process.env.DAILY_SYNC_META_MCP_USE_CASE = oldUseCase;
  }
});

test('same-day view restores full scoped lifetime, joins matching legacy campaign and excludes other accounts and future observations', () => {
  const row = (connectionId, campaign, from, to) => ({ connectionId, metaCampaignId: campaign, creative: { creativeKey: 'same-name' }, firstSeenOn: new Date(from), lastSeenOn: new Date(to) });
  const placements = [row('A', '1', '2026-10-07', '2026-10-30'), row(null, '1', '2026-09-01', '2026-10-06'), row('B', '2', '2026-01-01', '2026-10-25'), row(null, '3', '2025-01-01', '2026-10-06'), row('A', '4', '2026-11-01', '2026-11-30')];
  const lifetimes = aggregateCreativeLifetimes(placements, new Date('2026-10-25'));
  assert.equal(lifetimes.get(creativeLifetimeKey('A', 'same-name')).firstSeenOn.toISOString().slice(0, 10), '2026-09-01');
  assert.equal(lifetimes.get(creativeLifetimeKey('A', 'same-name')).lastSeenOn.toISOString().slice(0, 10), '2026-10-25');
  placements.push(row('B', '1', '2026-10-07', '2026-10-25'));
  assert.equal(aggregateCreativeLifetimes(placements, new Date('2026-10-25')).get(creativeLifetimeKey('A', 'same-name')).firstSeenOn.toISOString().slice(0, 10), '2026-10-07');
});

test('catalog validation requires advertised integer fields at the correct level; ad 3-second count is never requested', () => {
  const { wire, catalog } = fixture();
  const reporting = { server: catalog.server, reportingTool: { name: 'ads_get_ad_entities', annotations: { readOnlyHint: true, destructiveHint: false }, inputSchema: { properties: Object.fromEntries(['ad_account_id', 'fields', 'level', 'time_range', 'time_increment', 'object_state', 'include_additional_context', 'client_conversation_id', 'cursor', 'limit'].map(k => [k, { type: k === 'limit' ? 'integer' : 'string' }])) }, outputSchema: { properties: { ad_entities: { type: 'string' } } } } };
  validateMetaMcpCatalog(catalog, reporting, wire.clientConversationId, 'REPORTING_V2');
  assert.equal(metaMcpFields('REPORTING_V2').ad.includes('3_second_video_plays'), false);
  for (const mutation of [f => { f.levels = ['adset']; }, f => { f.type = 'FLOAT'; }, f => { f.is_metric = false; }]) {
    const bad = structuredClone(catalog); mutation(bad.fields.find(f => f.name === 'video_p25_watched_actions'));
    assert.throws(() => validateMetaMcpCatalog(bad, reporting, wire.clientConversationId, 'REPORTING_V2'));
  }
});
