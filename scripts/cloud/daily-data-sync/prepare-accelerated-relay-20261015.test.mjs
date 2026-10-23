import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {createHash} from 'node:crypto';
import {prepareAcceleratedRelayBundle,RELAY_V4_SOURCE_SHA,RELAY_V4_FILES} from './prepare-accelerated-relay-20261015.mjs';
test('new public immutable bundle contains exactly reviewed two source files and manifest; collision cannot overwrite',async()=>{
 const temp=await mkdtemp(join(tmpdir(),'phase08-relay-v4-')),directory=join(temp,'bundle');
 try{const result=await prepareAcceleratedRelayBundle(directory);assert.equal(result.remoteChanges,0);assert.equal(result.secretsIncluded,false);assert.equal(result.sourceSha,RELAY_V4_SOURCE_SHA);assert.deepEqual((await readdir(directory)).sort(),['index.ts','relay.mjs','source-manifest.json']);
 const manifest=JSON.parse(await readFile(join(directory,'source-manifest.json'),'utf8'));assert.equal(createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),RELAY_V4_SOURCE_SHA);
 for(const [file,expected]of Object.entries(RELAY_V4_FILES))assert.equal(createHash('sha256').update(await readFile(join(directory,file))).digest('hex'),expected);
 await assert.rejects(prepareAcceleratedRelayBundle(directory));assert.equal(JSON.stringify(JSON.parse(await readFile(join(directory,'source-manifest.json'),'utf8'))),JSON.stringify(manifest));
 }finally{assert(resolve(temp).startsWith(resolve(tmpdir())));await rm(temp,{recursive:true,force:true});}
});
