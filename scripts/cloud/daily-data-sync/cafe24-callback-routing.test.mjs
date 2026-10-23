import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import config from '../../../apps/web/next.config.mjs';
const require = createRequire(import.meta.url);
const { matchHas } = require('next/dist/shared/lib/router/utils/prepare-destination.js');
const phase08 = 'phase08-daily-data-sync-production.up.railway.app';
const legacy = 'grand-fascination-staging.up.railway.app';
const steps = ['callback', 'complete', 'failed'];

test('production callbacks for the exact isolated host reach the unprefixed Nest endpoints', async () => {
  const before = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const routes = await config.rewrites();
    for (const step of steps) {
      const source = `/backend-api/integrations/cafe24/oauth/${step}`;
      const matches = routes.filter(route => route.source === source && matchHas({ headers: { host: phase08 } }, {}, route.has));
      assert.equal(matches.length, 1);
      assert.equal(matches[0].destination, `http://127.0.0.1:4200/integrations/cafe24/oauth/${step}`);
    }
    assert.deepEqual(routes.at(-1), { source: '/backend-api/:path*', destination: 'http://127.0.0.1:4200/api/:path*' });
  } finally { if (before === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = before; }
});

test('the three legacy callback rewrites remain identical', async () => {
  const routes = await config.rewrites();
  const target = process.env.NODE_ENV === 'production' ? 'http://127.0.0.1:4200' : (process.env.API_PROXY_TARGET ?? 'http://localhost:4100/api').replace(/\/api$/, '');
  assert.deepEqual(routes.slice(0, 3), steps.map(step => ({
    source: `/backend-api/integrations/cafe24/oauth/${step}`,
    has: [{ type: 'host', value: legacy }],
    destination: `${target}/integrations/cafe24/oauth/${step}`
  })));
});

test('isolated callback host matching rejects lookalikes and unrelated routes', async () => {
  const isolated = (await config.rewrites()).slice(3, 6);
  for (const host of ['patimagroup-work.com', 'localhost', `${phase08}.evil.example`, 'phase08-daily-data-sync-productionXupXrailwayXapp']) {
    for (const route of isolated) assert.equal(matchHas({ headers: { host } }, {}, route.has), false);
  }
  assert.equal(isolated.some(route => route.source === '/backend-api/cafe24/connections/any/authorize'), false);
  assert.equal(isolated.some(route => route.source.startsWith('/backend-api/internal/')), false);
});
