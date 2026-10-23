// Synthetic artifact boundary tests. Fixtures are preserved as local evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {assertRuntimeClosure} from '../../../deploy/cloud/assert-runtime-closure.mjs';
const evidence='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/independent';
async function artifact(file,content='synthetic'){
 await mkdir(evidence,{recursive:true});const root=await mkdtemp(join(evidence,'closure-fixture-'));
 for(const path of ['apps/api/dist/main.js','apps/web/server.js','deploy/launch-bundle.mjs','deploy/cloud/ready-barrier.mjs']){await mkdir(dirname(join(root,path)),{recursive:true});await writeFile(join(root,path),'export {};',{flag:'wx'});}
 await mkdir(dirname(join(root,file)),{recursive:true});await writeFile(join(root,file),content,{flag:'wx'});return root;
}
const marker='-----BEGIN PRIVATE KEY-----';
test('root dependency private marker exception remains the existing rule',async()=>assert.equal((await assertRuntimeClosure(await artifact('node_modules/synthetic/key.js',marker))).result,'PASS'));
test('known API/Web workspace dependencies receive exactly the root dependency treatment',async()=>{
 for(const app of ['api','web']){const root=await artifact(`apps/${app}/node_modules/synthetic/key.js`,marker);assert.equal((await assertRuntimeClosure(root)).result,'PASS');}
});
test('arbitrary node_modules suffix cannot hide app private content',async()=>{
 await assert.rejects(assertRuntimeClosure(await artifact('apps/web/src/node_modules/synthetic/key.js',marker)),e=>e.code==='RUNTIME_PRIVATE_KEY_PRESENT');
 await assert.rejects(assertRuntimeClosure(await artifact('unapproved/node_modules/synthetic/value.js',marker)),e=>e.code==='RUNTIME_PRIVATE_KEY_PRESENT');
});
test('nested workspace dependencies still cannot include SQL, migrations or browser tooling',async()=>{
 for(const [file,code] of [['apps/web/node_modules/synthetic/schema.sql','RUNTIME_SQL_PRESENT'],['apps/api/node_modules/synthetic/prisma/migrations/test/file','RUNTIME_MIGRATION_ARTIFACT_PRESENT'],['apps/web/node_modules/@playwright/test/index.js','RUNTIME_TEST_DEPENDENCY_PRESENT'],['apps/web/node_modules/@aws-sdk/client-s3/index.js','RUNTIME_BACKUP_TOOLING_PRESENT']]){
  await assert.rejects(assertRuntimeClosure(await artifact(file)),e=>e.code===code);
 }
});
test('application source and private markers remain forbidden outside dependencies',async()=>{
 await assert.rejects(assertRuntimeClosure(await artifact('apps/web/source.ts')),e=>e.code==='RUNTIME_SOURCE_PRESENT');
 await assert.rejects(assertRuntimeClosure(await artifact('apps/api/dist/value.js',marker)),e=>e.code==='RUNTIME_PRIVATE_KEY_PRESENT');
});
