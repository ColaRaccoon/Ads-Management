import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,realpath} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,resolve,sep} from 'node:path';import {createHash} from 'node:crypto';
import {prepareRelay02Bundle,RELAY_V3_FILES,RELAY_V3_SOURCE_SHA} from './prepare-relay-restore02.mjs';
test('public v3 source bundle is immutable and exactly reviewed while active repository v3 source remains unchanged',async()=>{
 const parent=await mkdtemp(join(tmpdir(),'phase08-relay-v3-')),directory=join(parent,'v3');
 const active=await readFile(new URL('../../../supabase/functions/phase08-scheduled-relay/relay.mjs',import.meta.url));
 try{const out=await prepareRelay02Bundle(directory);assert.equal(out.sourceSha,RELAY_V3_SOURCE_SHA);assert.equal(out.remoteChanges,0);assert.equal(out.secretsIncluded,false);
 const manifest=JSON.parse(await readFile(join(directory,'source-manifest.json'),'utf8'));assert.equal(createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),RELAY_V3_SOURCE_SHA);
 for(const row of manifest)assert.equal(createHash('sha256').update(await readFile(join(directory,row.path))).digest('hex'),RELAY_V3_FILES[row.path]);
 await assert.rejects(prepareRelay02Bundle(directory));assert.deepEqual(await readFile(new URL('../../../supabase/functions/phase08-scheduled-relay/relay.mjs',import.meta.url)),active);
 const relay=await import('data:text/javascript;base64,'+(await readFile(join(directory,'relay.mjs'))).toString('base64'));assert.equal(relay.SCHEDULES[0].anchor,'2026-10-14T17:00:00.000Z');assert.equal(relay.PREVIOUS_TEST_SCHEDULES[0].anchor,'2026-10-15T01:00:00.000Z');
 }finally{const checked=await realpath(parent);if(!checked.startsWith(resolve(tmpdir())+sep)||!checked.includes('phase08-relay-v3-'))throw Error('cleanup-path');await rm(checked,{recursive:true});}
});
