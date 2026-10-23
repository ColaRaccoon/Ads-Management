'use strict';
// Entirely invented data. No protected file, provider credential or remote request is read.
const assert = require('node:assert/strict');
const ACCOUNT = '900000000000001';
const CONVERSATION = 'SyntheticMixedA01234';
const COUNT_DEFINITION = "The number of purchase events attributed to your ads, based on information received from one or more of your connected Meta Business Tools, or that occur directly on Meta technologies. This doesn't include purchases from messaging ads delivered to and from Europe and Japan.";
function makeFixtures(fields, delayMs = 5) {
  const counts = { meta: 0, google: 0, cafe: 0, nonFixtureRequests: 0 };
  let version = 1, fault = null;
  const levels = ['ad', 'adset', 'campaign', 'ad_account'];
  const names = [...new Set(Object.values(fields).flat())];
  const catalog = { version: 1, server: 'https://mcp.facebook.com/ads', tool: 'ads_get_field_context', client_conversation_id: CONVERSATION,
    fields: names.map(name => ({ name, levels: levels.filter(l => fields[l].includes(name)), is_metric: true,
      type: name === 'omni_purchase' ? 'INTEGER' : 'CURRENCY', description: name === 'omni_purchase' ? COUNT_DEFINITION : name === 'omni_purchase_values' ? 'The total value of purchases.' : 'Synthetic field metadata' })) };
  const reporting = { server: catalog.server, reportingTool: { name: 'ads_get_ad_entities', annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: { properties: Object.fromEntries(['ad_account_id','fields','level','time_range','time_increment','object_state','include_additional_context','client_conversation_id','cursor','limit'].map(k => [k, { type: k === 'limit' ? 'integer' : 'string' }])) },
    outputSchema: { properties: { ad_entities: { type: 'string' } } } } };
  const money = value => ({ value: String(value), unit: 'USD' });
  function metaRows(level, day) {
    const n = level === 'ad' ? 523 : level === 'adset' ? 200 : 1;
    return Array.from({ length: n }, (_, i) => {
      const number = level === 'ad' ? 100000 + i : level === 'adset' ? 200000 + i : level === 'campaign' ? 300000 : Number(ACCOUNT);
      const children = level === 'ad' ? 1 : level === 'adset' ? Math.floor((522 - i) / 200) + 1 : 523;
      const r = Object.fromEntries(fields[level].map(k => [k, null]));
      Object.assign(r, { id: String(number), name: level === 'ad' ? `1019_Synthetic_${i}_01_IG` : `Synthetic ${level} ${i}`, account_id: ACCOUNT,
        status: 'ACTIVE', effective_status: 'ACTIVE', amount_spent: money(children * version), impressions: String(children * 100),
        link_click: '0', clicks: '0', reach: String(children * 100), frequency: '1', omni_purchase: '0', offsite_conversion_fb_pixel_purchase: '0',
        omni_purchase_values: money(0), offsite_conversion_fb_pixel_purchase_values: money(0), date_start: day, date_stop: day });
      if (level === 'ad_account') { delete r.account_id; delete r.status; delete r.effective_status; r.timezone_name = 'Asia/Seoul'; }
      if (level === 'ad' || level === 'adset') Object.assign(r, { campaign_id: '300000', campaign_name: 'Synthetic campaign 0' });
      if (level === 'ad') Object.assign(r, { adset_id: String(200000 + i % 200), adset_name: `Synthetic adset ${i % 200}` });
      // Only permitted wire fields are emitted.
      return Object.fromEntries(Object.entries(r).filter(([k]) => fields[level].includes(k) || ['date_start','date_stop'].includes(k)));
    });
  }
  const itemCount = index => index < 36 ? 2 : 1;
  function order(index, day) { return { order_id: `SYNTHETIC_${index}`, shop_no: 1, order_date: `${day}T12:00:00+09:00`, currency: 'KRW',
    payment_amount: String(itemCount(index) * 100 * version), payment_method: ['card'],
    actual_order_amount: { order_price_amount: String(itemCount(index) * 100 * version), payment_amount: String(itemCount(index) * 100 * version), shipping_fee: '0' } }; }
  function items(index) { return Array.from({ length: itemCount(index) }, (_, j) => ({ order_item_code: `SYNTHETIC_${index}_${j}`, product_no: '9000',
    product_name: 'Synthetic product', option_value: 'S', quantity: '1', product_price: String(100*version), order_status: 'N30' })); }
  async function request(raw, init = {}) {
    const url = new URL(String(raw));
    await new Promise(r => setTimeout(r, delayMs));
    let body;
    if (url.href === 'https://mcp.facebook.com/ads') {
      counts.meta++; const args = JSON.parse(init.body).params.arguments;
      assert.equal(args.ad_account_id, ACCOUNT); assert.equal(args.client_conversation_id, CONVERSATION);
      const day = JSON.parse(args.time_range).since, rows = metaRows(args.level, day);
      if (fault === 'META_REQUIRED_FIELD') delete rows[0].amount_spent;
      if (fault === 'META_NULL_FREQUENCY') rows[0].frequency=null;
      body = { jsonrpc: '2.0', id: 1, result: { structuredContent: { ad_entities: JSON.stringify(rows), client_conversation_id: CONVERSATION, summary: { total_count: rows.length } } } };
    } else if (url.origin === 'https://googleads.googleapis.com' && /^\/v25\/customers\/9000000001\/googleAds:search$/.test(url.pathname)) {
      counts.google++; const query = JSON.parse(init.body).query;
      if (fault === 'GOOGLE_401') return new Response(JSON.stringify({ error: { message: 'SYNTHETIC' } }), { status: 401, headers: { 'Content-Type': 'application/json' } });
      const day = query.match(/segments.date = '([0-9-]+)'/)?.[1];
      const nonzero = day && Number(day.slice(-2)) % 2 === 0;
      if (query.includes('FROM campaign')) body = { results: nonzero ? [1,2,3].map(i => ({ campaign: { id: String(400000 + i), name: `Synthetic Google ${i}`, advertisingChannelType: 'SEARCH' }, segments: { date: day }, metrics: { costMicros: String(1000000*version), impressions: '100', clicks: '1' } })) : [] };
      else if (day) body = { results: nonzero ? [{ segments: { date: day }, metrics: { costMicros: String(3000000*version) } }] : [] };
      else body = { results: [{ customer: { id: '9000000001', currencyCode: 'KRW', timeZone: 'Asia/Seoul' } }] };
    } else if (url.origin === 'https://didadi0729.cafe24api.com') {
      counts.cafe++;
      if (url.pathname.endsWith('/orders/count')) body = { count: 343 };
      else if (/\/orders\/SYNTHETIC_\d+\/items$/.test(url.pathname)) body = { items: items(Number(url.pathname.match(/SYNTHETIC_(\d+)/)[1])) };
      else if (url.pathname.endsWith('/orders')) {
        const offset = Number(url.searchParams.get('offset') || 0), day = url.searchParams.get('start_date');
        body = { orders: Array.from({ length: Math.max(0, Math.min(100, 343-offset)) }, (_, i) => order(offset+i, day)) };
      } else throw Error('FIXTURE_CAFE_PATH');
    } else { counts.nonFixtureRequests++; throw Error('NON_FIXTURE_NETWORK_REQUEST_DENIED'); }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return { request, counts, catalog, reporting, metaRows, order, items, setVersion(n) { assert([1,2].includes(n)); version=n; }, setFault(v) { fault=v; } };
}
module.exports = { makeFixtures, ACCOUNT, CONVERSATION };
