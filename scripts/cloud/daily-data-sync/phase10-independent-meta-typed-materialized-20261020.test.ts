import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { validatedMetaApiDays } from '../../../apps/api/src/common/meta-source-read-coverage';

const file = 'apps/api/src/common/meta-source-read-coverage.ts';
const helper = 'scripts/cloud/daily-data-sync/phase10-meta-explain-readonly-v2-20261020.ps1';
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

test('final SQL differs from frozen v2 only by typed values and materialized CTE', () => {
  const current = readFileSync(file);
  assert.equal(sha(current), 'bc0317e906783044ac4dc53b5ec52f02dedef75a11cad9652cf096c30c0700dc');
  const previous = readFileSync('C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/candidate-20261020-v2/' + file, 'utf8');
  const expected = previous.replace('WITH current_counts AS (', 'WITH current_counts AS MATERIALIZED (')
    .replaceAll('r.data_kind::text = ${dataKind}', 'r.data_kind = ${dataKind}::"SourceDataKind"')
    .replaceAll('c.data_kind::text = ${dataKind}', 'c.data_kind = ${dataKind}::"SourceDataKind"')
    .replaceAll("r.source::text = 'API'", "r.source = 'API'::\"SourceKind\"")
    .replaceAll("m.source::text = 'API'", "m.source = 'API'::\"SourceKind\"")
    .replaceAll("c.source::text = 'API'", "c.source = 'API'::\"SourceKind\"")
    .replaceAll("u.status::text = 'SUCCEEDED'", "u.status = 'SUCCEEDED'::\"RunUnitStatus\"");
  assert.equal(current.toString('utf8').replaceAll('\r\n','\n'), expected.replaceAll('\r\n','\n'));
});

test('actual diagnosed materialized SQL matches final Prisma query for both kinds and ranges', async () => {
  assert.equal(sha(readFileSync(helper)), 'd1a2ddc96b3b070f2cd761c92e093c23fcf618ee47b0fba3b8c1e36ad45eac5b');
  const id = '00000000-0000-4000-8000-000000000001';
  // Import function definitions only. No -Execute, provider, management, or protected material read.
  const script = `. './${helper}'; $rows=@();foreach($kind in @('META_AD','META_ADSET')){foreach($range in @(@('2026-10-13','2026-10-14'),@('2026-10-09','2026-10-15'))){$rows+=@{kind=$kind;from=$range[0];to=$range[1];sql=(New-ExplainSql '${id}' $kind $range[0] $range[1] TYPED_MATERIALIZED)}}}; ConvertTo-Json -InputObject $rows -Compress`;
  const templates = JSON.parse(execFileSync('pwsh',['-NoProfile','-Command',script], {encoding:'utf8',windowsHide:true}));
  assert.equal(templates.length,4);
  for (const row of templates) {
    let captured: any;
    await validatedMetaApiDays({$queryRaw:async(sql:any)=>{captured=sql;return [];}} as any, row.kind,[id],new Date(row.from+'T00:00:00Z'),new Date(row.to+'T00:00:00Z'));
    const rendered = captured.strings.reduce((text:string,part:string,i:number) => text+part+
      (i<captured.values.length ? `'${String(captured.values[i]).replaceAll("'","''")}'` : ''),'');
    assert.equal(row.sql.replace(/\s/g,''),rendered.replace(/\s/g,''),row.kind+'/'+row.from+'/'+row.to);
  }
});
