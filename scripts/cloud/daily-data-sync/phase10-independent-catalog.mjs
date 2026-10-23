import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation';
const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const paths={operating:`${root}/evidence/operating-schema.json`,local:`${root}/api-baseline-catalog-20261019-catalog-v1/local-baseline-schema.json`,developer:`${root}/api-baseline-catalog-20261019-catalog-v1/result.json`};
const [operatingText,localText,developerText]=await Promise.all(Object.values(paths).map(p=>readFile(p,'utf8')));
const operating=JSON.parse(operatingText),local=JSON.parse(localText),developer=JSON.parse(developerText);
assert.equal(operating.kind,'PHASE10_OPERATING_SCHEMA_READ_ONLY');assert.equal(local.kind,'PHASE10_LOCAL_BASELINE_SCHEMA_METADATA');
assert.equal(hash(operatingText),developer.sourceReceiptSha256);
assert.equal(hash(operating.metadata),operating.schemaMetadataSha256);assert.equal(hash(local.metadata),local.schemaMetadataSha256);
const keys={tables:r=>r.name,columns:r=>`${r.table_name}.${r.column_name}`,indexes:r=>`${r.tablename}.${r.indexname}`};
const counts={},structural={};
for(const [kind,key]of Object.entries(keys)){
 const a=operating.metadata[kind],b=local.metadata[kind];assert.equal(new Set(a.map(key)).size,a.length);assert.equal(new Set(b.map(key)).size,b.length);
 const aa=new Map(a.map(row=>[key(row),row])),bb=new Map(b.map(row=>[key(row),row]));
 assert.deepEqual([...aa.keys()].sort(),[...bb.keys()].sort());for(const[k,v]of aa)assert.deepEqual(v,bb.get(k));
 counts[kind]=a.length;structural[kind]=a;
}
assert.deepEqual(counts,{tables:54,columns:808,indexes:218});
const structuralSha256=hash(structural);assert.equal(structuralSha256,developer.operatingStructuralSha256);assert.equal(structuralSha256,developer.localStructuralSha256);
assert.equal(developer.baselineCommit,'9e9a1f82bb02346575565b031a43e17e13758dc8');assert.equal(developer.baselineMigrationCount,37);assert.equal(developer.postgresStopExit,0);
const out={kind:'PHASE10_INDEPENDENT_BASELINE_CATALOG_REVIEW',observedAt:new Date().toISOString(),baselineCommit:developer.baselineCommit,counts,sourceReceiptSha256:hash(operatingText),structuralSha256,semanticDifferenceCount:0,duplicateKeys:0,metadataHashesRecomputed:true,identityDifferenceExplicit:{operating:operating.identity,local:local.metadata.identity},limits:'No defaults, function bodies, triggers, grants, constraints, sequences, database version or business row-volume comparison; no claim of entire production schema equality.',productionConnections:0,productionWrites:0,providerRequests:0};
await writeFile(`${root}/independent/baseline-catalog-20261019.json`,JSON.stringify(out,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(out));
