'use strict';
// Public, synthetic-only CJS probe for the compiled image. No application starts,
// Prisma client is never constructed, and no database/provider transport is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const tls = require('node:tls');
const { createRequire } = require('node:module');
const { createHash, randomBytes } = require('node:crypto');
let stage = 'START', networkAttempts = 0;
const fail = () => { throw Error('COMPILED_EPOCH_SMOKE_REJECTED'); };
const denyNetwork = () => { networkAttempts++; fail(); };
const original = { fetch: globalThis.fetch, socket: net.Socket.prototype.connect, tls: tls.connect };
globalThis.fetch = denyNetwork;
net.Socket.prototype.connect = denyNetwork;
tls.connect = denyNetwork;
const cases = [];
const run = (name, callback) => { stage = name; callback(); cases.push({ name, status: 'PASS' }); };
try {
  const args = process.argv.slice(2);
  let root = '/srv/app/apps/api/dist';
  if (args.length) {
    if (args.length !== 1 || !args[0].startsWith('--local-compiled-root=')) fail();
    root = args[0].slice('--local-compiled-root='.length).replaceAll('\\', '/');
    if (root !== 'C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/cafe-epoch-20261020-v1/compiled-smoke') fail();
  }
  const names = ['cafe24-observation-epoch.js', 'cafe24-observation.service.js', 'cafe24-order-preflight.client.js'];
  const files = names.map(name => ({ name, absolute: path.join(root, 'daily-sync', name) }));
  stage = 'COMPILED_IMPORT';
  const compiledRequire = createRequire(path.resolve(root, '../../..', 'epoch-smoke-probe.cjs'));
  compiledRequire('reflect-metadata');
  const helper = require(files[0].absolute);
  const { Cafe24ObservationService } = require(files[1].absolute);
  const { Cafe24OrderPreflightClient } = require(files[2].absolute);
  const { Prisma } = compiledRequire('@prisma/client');
  const connectionId = 'c52af7cb-2f90-48a5-a21c-18ca2ea677fa';
  const day = '2026-10-16';
  const scope = { connectionId, keyVersion: 2, epochReference: 'ec1f51e8-c568-45a2-8e4d-7cae5441b53a',
    epochStartedAt: new Date(Date.now() - 10000), baselineApprovalSha256: 'a'.repeat(64),
    sourceClosureSha256: 'b'.repeat(64), approvedDay: day, explicitManualDay: true };
  const baseKey = randomBytes(32);
  const env = { DAILY_SYNC_CAFE24_OBSERVATION_REBASELINE_REQUIRED: 'false',
    DAILY_SYNC_CAFE24_OBSERVATION_KEY_VERSION: '2',
    DAILY_SYNC_CAFE24_OBSERVATION_KEY_B64: baseKey.toString('base64'),
    DAILY_SYNC_CAFE24_OBSERVATION_EPOCH_CONNECTION_ID: connectionId,
    DAILY_SYNC_CAFE24_OBSERVATION_EPOCH_REFERENCE: scope.epochReference,
    DAILY_SYNC_CAFE24_OBSERVATION_EPOCH_STARTED_AT: scope.epochStartedAt.toISOString(),
    DAILY_SYNC_CAFE24_OBSERVATION_EPOCH_APPROVAL_SHA256: scope.baselineApprovalSha256,
    DAILY_SYNC_CAFE24_OBSERVATION_EPOCH_SOURCE_SHA256: scope.sourceClosureSha256,
    DAILY_SYNC_CAFE24_OBSERVATION_EPOCH_APPROVED_DAY: day };
  const material = (s = scope, e = env) => helper.cafe24ObservationEpochKey(connectionId, day, s, e);
  run('COMPILED_IMPORT_AND_GENERATED_MODELS', () => {
    assert.equal(typeof Cafe24ObservationService.prototype.observeEpochDay, 'function');
    assert.equal(typeof Cafe24OrderPreflightClient.prototype.readDayObservedRevision, 'function');
    for (const model of ['Cafe24ObservedEpochOrderRevision', 'Cafe24ObservedEpochDayCheckpoint'])
      assert.ok(Prisma.dmmf.datamodel.models.some(row => row.name === model));
  });
  run('EXPLICIT_SCOPE_DETERMINISTIC_DOMAIN_SEPARATION', () => {
    const a = material(), b = material();
    try { assert.equal(a.version, 2); assert.equal(a.key.length, 32);
      assert.deepEqual(a.key, b.key); assert.notDeepEqual(a.key, baseKey);
      assert.match(a.metadata.keyCommitment, /^[a-f0-9]{64}$/);
      assert.match(a.metadata.keyIdentityCommitment, /^[a-f0-9]{64}$/);
      assert.equal(a.metadata.connectionId, connectionId);
    } finally { a.key.fill(0); b.key.fill(0); }
  });
  run('EPOCH_AND_VERSION_DOMAIN_BOUNDARIES', () => {
    const reference = 'ec1f51e8-c568-45a2-8e4d-7cae5441b53b';
    const a = material(), b = material({ ...scope, epochReference: reference },
      { ...env, DAILY_SYNC_CAFE24_OBSERVATION_EPOCH_REFERENCE: reference });
    const c = material({ ...scope, keyVersion: 3, epochReference: reference },
      { ...env, DAILY_SYNC_CAFE24_OBSERVATION_KEY_VERSION: '3', DAILY_SYNC_CAFE24_OBSERVATION_EPOCH_REFERENCE: reference });
    try { assert.notDeepEqual(a.key, b.key); assert.notDeepEqual(b.key, c.key);
      assert.equal(a.metadata.keyCommitment, b.metadata.keyCommitment);
      assert.notEqual(a.metadata.keyCommitment, c.metadata.keyCommitment);
      assert.equal(a.metadata.keyIdentityCommitment, c.metadata.keyIdentityCommitment);
    } finally { a.key.fill(0); b.key.fill(0); c.key.fill(0); }
  });
  run('TRUSTED_APPROVAL_SCOPE_MISSING_OR_CHANGED_REJECTED', () => {
    for (const name of Object.keys(env).filter(name => name.includes('_EPOCH_'))) {
      const missing = { ...env }; delete missing[name]; assert.throws(() => material(scope, missing));
      assert.throws(() => material(scope, { ...env, [name]: 'wrong' }));
    }
    for (const s of [undefined, null, {}, { ...scope, explicitManualDay: false },
      { ...scope, approvedDay: '2026-10-17' }, { ...scope, epochReference: scope.epochReference.toUpperCase() },
      { ...scope, epochStartedAt: new Date(Date.now() + 60000) }])
      assert.throws(() => helper.cafe24ObservationEpochKey(connectionId, day, s, env));
  });
  run('QUARANTINE_AND_KEY_PURPOSE_REUSE_REJECTED', () => {
    const hold = () => material(scope, { ...env, DAILY_SYNC_CAFE24_OBSERVATION_REBASELINE_REQUIRED: 'true' });
    assert.throws(hold, error => error.safeCode === 'FIELD_UNSUPPORTED' && error.retryable === false);
    for (const name of ['DAILY_SYNC_CREDENTIAL_KEY_V2', 'DAILY_SYNC_CHECKPOINT_KEY_B64'])
      assert.throws(() => material(scope, { ...env, [name]: env.DAILY_SYNC_CAFE24_OBSERVATION_KEY_B64 }));
  });
  run('ROW_AND_CHECKPOINT_SEALS_COVER_MUTABLE_HISTORY', () => {
    const k = material();
    try {
      const at = new Date(), row = { ...k.metadata, orderDate: new Date(day + 'T00:00:00Z'),
        orderKeyHash: 'c'.repeat(64), revision: 1, contentHash: 'd'.repeat(64),
        firstObservedAt: at, lastObservedAt: at, observationId: scope.epochReference, isCurrent: true };
      const rowSeal = helper.cafe24EpochRevisionIntegrity(k.key, row);
      for (const delta of [{ isCurrent: false }, { revision: 2 }, { contentHash: 'e'.repeat(64) },
        { lastObservedAt: new Date(+at + 1) }, { keyIdentityCommitment: 'f'.repeat(64) }])
        assert.notEqual(rowSeal, helper.cafe24EpochRevisionIntegrity(k.key, { ...row, ...delta }));
      const checkpoint = { ...k.metadata, orderDate: row.orderDate, queryStartedAt: at, completedAt: at,
        observationId: scope.epochReference, checkpointRevision: 1, orderCount: 1, itemCount: 1,
        snapshotHash: 'e'.repeat(64) };
      const checkpointSeal = helper.cafe24EpochCheckpointIntegrity(k.key, checkpoint);
      assert.notEqual(rowSeal, checkpointSeal);
      for (const delta of [{ checkpointRevision: 2 }, { orderCount: 0 }, { itemCount: 2 },
        { baselineApprovalSha256: 'f'.repeat(64) }])
        assert.notEqual(checkpointSeal, helper.cafe24EpochCheckpointIntegrity(k.key, { ...checkpoint, ...delta }));
    } finally { k.key.fill(0); }
  });
  baseKey.fill(0);
  assert.equal(networkAttempts, 0);
  process.stdout.write(JSON.stringify({ kind: 'CAFE24_COMPILED_EPOCH_SMOKE', status: 'PASS',
    environment: args.length ? 'LOCAL_COMPILED_COPY' : 'IMAGE_COMPILED_CJS', cases,
    passed: cases.length, failed: 0, compiledModules: files.map(file => ({ name: file.name,
      sha256: createHash('sha256').update(fs.readFileSync(file.absolute)).digest('hex') })),
    prismaClientConstructed: false, databaseRequests: 0, actualProviderRequests: 0,
    networkAttempts, syntheticOnly: true, continuityRestored: false }) + '\n');
} catch {
  process.stdout.write(JSON.stringify({ kind: 'CAFE24_COMPILED_EPOCH_SMOKE', status: 'FAIL',
    safeStage: stage, passed: cases.length, networkAttempts, rawErrorSuppressed: true }) + '\n');
  process.exitCode = 1;
} finally {
  globalThis.fetch = original.fetch;
  net.Socket.prototype.connect = original.socket;
  tls.connect = original.tls;
}
