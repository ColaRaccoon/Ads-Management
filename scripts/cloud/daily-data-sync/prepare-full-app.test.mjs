import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertPreparationIdentity, transformMigration, prepareFullApp, APP_PROJECT_REF, APP_SCHEMA, APP_RUNTIME, APP_MIGRATION } from './prepare-full-app.mjs';

const identity = { projectRef: APP_PROJECT_REF, database: 'postgres', schema: APP_SCHEMA,
  runtimeRole: APP_RUNTIME, migrationRole: APP_MIGRATION, existingSchema: false, existingRoles: false, operatingTarget: false };
test('fresh staging schema requires explicit identity; operating ref and preserved schema are rejected', () => {
  assert.equal(assertPreparationIdentity(identity).schema, 'phase08_meta_ads');
  for (const patch of [{ projectRef: 'iygjmosbelbosfxidqxv' }, { schema: 'meta_ads' }, { runtimeRole: 'meta_ads_stg_runtime' },
    { existingSchema: true }, { existingRoles: true }, { operatingTarget: true }, { existingRoles: undefined }])
    assert.throws(() => assertPreparationIdentity({ ...identity, ...patch }));
});
test('transformation changes only qualified schema and known grant roles; rejects new schema creation', () => {
  const source = `CREATE SCHEMA IF NOT EXISTS "public";\nALTER TABLE "meta_ads"."meta_ads" ADD COLUMN x integer;
SELECT 'meta_ads_stg_runtime','meta_ads_stg_migration','meta_ads_prod_runtime','meta_ads_prod_migration';`;
  const result = transformMigration(source);
  assert.match(result, /"phase08_meta_ads"\."meta_ads"/);
  assert.match(result, /'phase08_runtime','phase08_migration'/);
  assert.doesNotMatch(result, /meta_ads_prod_runtime|CREATE SCHEMA/);
  assert.throws(() => transformMigration('CREATE SCHEMA hidden;'));
});
test('historical wrappers cannot commit the outer transaction or reset local schema', () => {
  const source = 'BEGIN;\nDO $body$\nBEGIN\n  PERFORM 1;\nEND;\n$body$;\nCOMMIT;';
  const result = transformMigration(source);
  assert.doesNotMatch(result, /^BEGIN;|^COMMIT;/m);
  assert.match(result, /BEGIN\n  PERFORM 1;\nEND;/);
  assert.throws(() => transformMigration('ROLLBACK;'));
  assert.throws(() => transformMigration('BEGIN TRANSACTION;'));
  assert.throws(() => transformMigration('COMMIT AND CHAIN;'));
  assert.throws(() => transformMigration('SET search_path=public;'));
  assert.throws(() => transformMigration('DO $$ BEGIN'));
});
test('full local schema package preserves source migration fingerprints and refuses overwrite', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'phase08-preparation-test-'));
  try {
    const output = join(directory, 'prepared');
    const result = await prepareFullApp(identity, output);
    assert.ok(result.migrations >= 51); assert.equal(result.remoteChanges, 0);
    const sql = await readFile(join(output, 'full-app-schema.sql'), 'utf8');
    const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
    assert.equal(manifest.preparationOnly, true); assert.equal(manifest.identity.projectRef, APP_PROJECT_REF);
    assert.match(sql, /NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS/);
    assert.match(sql, /SET LOCAL search_path=phase08_meta_ads,pg_catalog/);
    assert.match(sql, /20261012170000_scheduled_unit_checkpoints/);
    assert.doesNotMatch(sql, /"meta_ads"\./);
    assert.equal((sql.match(/^BEGIN;$/gm) ?? []).length, 1);
    assert.equal((sql.match(/^COMMIT;$/gm) ?? []).length, 1);
    assert.equal(manifest.migrations.every(item => /^[a-f0-9]{64}$/.test(item.sourceSha256) && /^[a-f0-9]{64}$/.test(item.preparedSha256)), true);
    await assert.rejects(prepareFullApp(identity, output));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
