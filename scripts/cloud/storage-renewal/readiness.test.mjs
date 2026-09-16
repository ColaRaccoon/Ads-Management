import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkApplicationReadiness, requestTimeout, INVOCATION_BUDGET_MS, assertAppliedDeployment } from './readiness.mjs';

const ready = () => Response.json({ status: 'ready' });

test('applied current sleeping deployment can reach the waking readiness probe', async () => {
  const issuedAt = 1_800_000_000;
  for (const status of ['SUCCESS', 'SLEEPING']) {
    const f = fixture([new Response('waking', { status: 502 }), ready()]);
    assertAppliedDeployment([{ status, createdAt: new Date(issuedAt * 1000).toISOString() }], issuedAt);
    await checkApplicationReadiness(f.options);
    assert.equal(f.requests.length, 2);
  }
});

test('sleeping deployment must contain the current token; failed or pending deployment never qualifies', () => {
  const issuedAt = 1_800_000_000;
  const current = new Date(issuedAt * 1000).toISOString();
  const old = new Date(issuedAt * 1000 - 1).toISOString();
  for (const deployments of [
    undefined, [], [null], [{ status: 'SLEEPING', createdAt: old }],
    [{ status: 'SUCCESS', createdAt: old }, { status: 'FAILED', createdAt: current }],
    [{ status: 'SLEEPING', createdAt: 'invalid' }],
    ...['FAILED', 'CRASHED', 'DEPLOYING', 'BUILDING', 'REMOVED', 'QUEUED', 'UNKNOWN'].map(status => [{ status, createdAt: current }])
  ]) {
    assert.throws(() => assertAppliedDeployment(deployments, issuedAt), /DEPLOYMENT_NOT_APPLIED/);
  }
  assert.throws(() => assertAppliedDeployment([{ status: 'SUCCESS', createdAt: current }], NaN), /DEPLOYMENT_NOT_APPLIED/);
});

function fixture(responses) {
  let time = 0;
  const requests = [], waits = [];
  return {
    requests, waits,
    options: {
      token: 'fixture-probe', deadlineMs: INVOCATION_BUDGET_MS,
      now: () => time,
      sleep: async ms => { waits.push(ms); time += ms; },
      fetchImpl: async (url, options) => {
        requests.push({ url, ...options });
        const next = responses.shift();
        if (next instanceof Error) throw next;
        if (typeof next === 'function') return next(ms => { time += ms; });
        return next;
      }
    }
  };
}

test('cold gateway errors retry only the fixed protected GET, then verify readiness', async () => {
  const f = fixture([new Response('waking', { status: 502 }), new Response('unavailable', { status: 503 }), ready()]);
  await checkApplicationReadiness(f.options);
  assert.equal(f.requests.length, 3);
  assert.deepEqual(f.waits, [2000, 2000]);
  for (const request of f.requests) {
    assert.equal(request.url, 'https://patimagroup-work.com/backend-api/health/ready');
    assert.equal(request.redirect, 'manual');
    assert.equal(request.headers['x-internal-probe-token'], 'fixture-probe');
    assert.equal(request.method, undefined);
  }
});

test('network and per-attempt timeout errors can recover', async () => {
  const f = fixture([new TypeError('fetch failed'), new DOMException('timeout', 'TimeoutError'), ready()]);
  await checkApplicationReadiness(f.options);
  assert.equal(f.requests.length, 3);
});

test('auth, redirect, wrong endpoint and actual application failures never retry', async () => {
  for (const response of [
    new Response('', { status: 401 }), new Response('', { status: 403 }),
    new Response('', { status: 302 }), new Response('', { status: 404 }),
    new Response('', { status: 500 }),
    Response.json({ code: 'SERVICE_NOT_READY', details: null }, { status: 503 }),
    Response.json({ code: 'DATABASE_ERROR' }, { status: 502 }),
    Response.json({ status: 'live' }), new Response('<html>login</html>')
  ]) {
    const f = fixture([response, ready()]);
    await assert.rejects(checkApplicationReadiness(f.options));
    assert.equal(f.requests.length, 1);
    assert.deepEqual(f.waits, []);
  }
});

test('three gateway failures remain a failure', async () => {
  const f = fixture(Array.from({ length: 3 }, () => new Response('', { status: 502 })));
  await assert.rejects(checkApplicationReadiness(f.options), /APPLICATION_WAKE_TIMEOUT/);
  assert.equal(f.requests.length, 3);
});

test('readiness budget and remaining invocation budget bound retries', async () => {
  for (const [deadlineMs, elapsed] of [[80_000, 34_000], [5_000, 4_000]]) {
    const f = fixture([advance => { advance(elapsed); return new Response('', { status: 503 }); }, ready()]);
    f.options.deadlineMs = deadlineMs;
    await assert.rejects(checkApplicationReadiness(f.options), /APPLICATION_WAKE_TIMEOUT/);
    assert.equal(f.requests.length, 1);
    assert.deepEqual(f.waits, []);
  }
});

test('expired budget and missing probe configuration never send a request', async () => {
  assert.throws(() => requestTimeout(10, 20_000, 10), /INVOCATION_DEADLINE_EXCEEDED/);
  for (const options of [{ deadlineMs: 0 }, { token: '' }]) {
    const f = fixture([ready()]);
    Object.assign(f.options, options);
    await assert.rejects(checkApplicationReadiness(f.options));
    assert.equal(f.requests.length, 0);
  }
});

test('unknown errors and body read failures fail closed', async () => {
  for (const failure of [new Error('unexpected'), { status: 503, text: async () => { throw Error('body interrupted'); } }]) {
    const f = fixture([failure, ready()]);
    await assert.rejects(checkApplicationReadiness(f.options));
    assert.equal(f.requests.length, 1);
  }
});
