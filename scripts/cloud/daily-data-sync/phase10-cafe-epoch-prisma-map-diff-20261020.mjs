// Public generated source only. This never reads an environment value or opens a DB.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const E = 'C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/cafe-epoch-20261020-v1';
const BEFORE = E + '/prisma-before-c7';
const sha = value => createHash('sha256').update(value).digest('hex');
const map = ', map: "cafe24_epoch_revisions_checkpoint_fkey"';
function stripMap(value) {
  const matches = value.split(map);
  if (matches.length !== 2) throw Error('MAP_CARDINALITY');
  return matches.join('');
}
function property(text, name) {
  const match = text.match(new RegExp('"' + name + '": ("(?:\\\\.|[^"\\\\])*")'));
  if (!match) throw Error('GENERATED_PROPERTY');
  return JSON.parse(match[1]);
}
function runtimeModel(text) {
  const match = text.match(/config\.runtimeDataModel = JSON\.parse\(("(?:\\.|[^"\\])*")\)/);
  if (!match) throw Error('RUNTIME_MODEL');
  return JSON.parse(match[1]);
}
function normalizeGenerated(text) {
  return text.replace(/"inlineSchema": ("(?:\\.|[^"\\])*")/, '"inlineSchema": "REVIEWED_MAP_ONLY"')
    .replace(/"inlineSchemaHash": "[a-f0-9]{64}"/, '"inlineSchemaHash": "REVIEWED_MAP_ONLY"');
}
export function comparePrismaMap() {
  const beforeBytes = fs.readFileSync(BEFORE + '/pins.json');
  if (sha(beforeBytes) !== 'cb71e28084d67e4c7b8cac16ec43e9ab21595201d01188753a5f4fc879cad962')
    throw Error('BEFORE_PINS_REJECTED');
  const before = JSON.parse(beforeBytes.toString('utf8'));
  const report = { kind: 'CAFE24_EPOCH_C7_GENERATED_PRISMA_MAP_ONLY_DIFF', status: 'FAIL',
    createdAt: new Date().toISOString(), sourceBeforeSha256: before.sourceSchemaSha256,
    files: [], remoteRequests: 0, databaseRequests: 0, actualProviderRequests: 0,
    generatedSourceOnly: true, rawSourceReturned: false };
  const actual = [];
  function walk(dir, prefix = '') {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if (item.isDirectory()) walk(path.join(dir, item.name), prefix + item.name + '/');
      else if (item.isFile()) actual.push(prefix + item.name);
    }
  }
  try {
    walk('node_modules/.prisma/client');
    if (JSON.stringify(actual.sort()) !== JSON.stringify(before.generatedFiles.map(x => x.name).sort()))
      throw Error('GENERATED_INVENTORY');
    const sourceAfter = fs.readFileSync('apps/api/prisma/schema.prisma');
    report.sourceAfterSha256 = sha(sourceAfter);
    const sourceBefore = fs.readFileSync(BEFORE + '/source-schema.prisma', 'utf8');
    if (sha(Buffer.from(sourceBefore)) !== before.sourceSchemaSha256 ||
        stripMap(sourceAfter.toString('utf8')) !== sourceBefore) throw Error('SOURCE_MAP_ONLY');
    for (const original of before.generatedFiles) {
      const value = fs.readFileSync('node_modules/.prisma/client/' + original.name);
      const entry = { name: original.name, beforeSha256: original.sha256, afterSha256: sha(value),
        byteIdentical: sha(value) === original.sha256 };
      if (!entry.byteIdentical) {
        if (!original.textSnapshot) throw Error('ENGINE_CHANGED');
        const previous = fs.readFileSync(BEFORE + '/files/' + original.name, 'utf8');
        if (sha(Buffer.from(previous)) !== original.sha256) throw Error('BEFORE_TEXT_DRIFT');
        const current = value.toString('utf8');
        if (original.name === 'schema.prisma') {
          if (stripMap(current) !== previous) throw Error('GENERATED_SCHEMA_CHANGED');
          entry.onlyRelationMapAdded = true;
        } else if (['index.js', 'edge.js'].includes(original.name)) {
          if (normalizeGenerated(previous) !== normalizeGenerated(current) ||
              stripMap(property(current, 'inlineSchema')) !== property(previous, 'inlineSchema') ||
              runtimeModel(current) !== runtimeModel(previous)) throw Error('GENERATED_JS_CHANGED');
          entry.onlyInlineSchemaAndSchemaHashChanged = true;
          entry.runtimeDataModelByteIdentical = true;
          entry.inlineSchemaBeforeHash = property(previous, 'inlineSchemaHash');
          entry.inlineSchemaAfterHash = property(current, 'inlineSchemaHash');
          if (!/^[a-f0-9]{64}$/.test(entry.inlineSchemaBeforeHash) ||
              !/^[a-f0-9]{64}$/.test(entry.inlineSchemaAfterHash)) throw Error('INLINE_HASH_SHAPE');
        } else throw Error('UNEXPECTED_GENERATED_CHANGE');
      }
      report.files.push(entry);
    }
    if (report.files.filter(x => !x.byteIdentical).length !== 3) throw Error('EXPECTED_THREE_FILES');
    report.changedFiles = report.files.filter(x => !x.byteIdentical).map(x => x.name);
    report.sourceMapOnly = true;
    report.runtimeDataModelByteIdentical = true;
    report.generatedTypesAndEngineByteIdentical = true;
    report.status = 'PASS';
  } catch (error) {
    const allowed = new Set(['MAP_CARDINALITY', 'GENERATED_PROPERTY', 'RUNTIME_MODEL',
      'GENERATED_INVENTORY', 'SOURCE_MAP_ONLY', 'ENGINE_CHANGED', 'BEFORE_TEXT_DRIFT',
      'GENERATED_SCHEMA_CHANGED', 'GENERATED_JS_CHANGED', 'INLINE_HASH_SHAPE',
      'UNEXPECTED_GENERATED_CHANGE', 'EXPECTED_THREE_FILES']);
    report.safeCode = allowed.has(error.message) ? error.message : 'LOCAL_PROJECTION_REJECTED';
    report.rawErrorSuppressed = true;
  }
  return report;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = comparePrismaMap();
    fs.writeFileSync(E + '/prisma-map-only-diff-c7.json', JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    process.stdout.write(JSON.stringify({ status: report.status, changedFiles: report.changedFiles ?? [],
      safeCode: report.safeCode ?? null, remoteRequests: 0 }) + '\n');
    if (report.status !== 'PASS') process.exitCode = 1;
  } catch {
    process.stdout.write('{"status":"FAIL","safeCode":"PRISMA_MAP_DIFF_REJECTED","rawErrorSuppressed":true,"remoteRequests":0}\n');
    process.exitCode = 1;
  }
}
