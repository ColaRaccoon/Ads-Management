import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { assertRuntimeClosure } from '../../../deploy/cloud/assert-runtime-closure.mjs';
const required=['apps/api/dist/main.js','apps/web/server.js','deploy/launch-bundle.mjs','deploy/cloud/ready-barrier.mjs'];
async function fixture(extra,action){
 const root=await mkdtemp(join(tmpdir(),'phase10-closure-'));
 try{for(const [name,value] of [...required.map(n=>[n,'// runtime']),...extra]){await mkdir(dirname(join(root,name)),{recursive:true});await writeFile(join(root,name),value)}await action(root)}finally{await rm(root,{recursive:true,force:true})}
}
test('hoisted and exact API/Web workspace dependency layouts keep identical exceptions',async()=>{
 for(const prefix of ['node_modules/next','apps/api/node_modules/example','apps/web/node_modules/next']){
  await fixture([[prefix+'/dist/cache-key.js','// public dependency code'] ,[prefix+'/example.js',['-----BEGIN','PRIVATE KEY-----'].join(' ')]],async root=>assert.equal((await assertRuntimeClosure(root)).result,'PASS'));
 }
});
test('arbitrary nested modules and application secrets remain blocked',async()=>{
 for(const [name,value] of [['foo/node_modules/example/cache-key.js','// not an approved dependency root'],['apps/web/src/signing-key.js','// application'],['apps/api/dist/secret.txt',['-----BEGIN','PRIVATE KEY-----'].join(' ')]]){
  await fixture([[name,value]],async root=>assert.rejects(assertRuntimeClosure(root),{code:'RUNTIME_PRIVATE_KEY_PRESENT'}));
 }
});
test('SQL, migrations, test runners, backup and maintenance stay forbidden in nested dependencies',async()=>{
 for(const [name,code] of [['apps/web/node_modules/example/query.sql','RUNTIME_SQL_PRESENT'],['apps/api/node_modules/example/prisma/schema.prisma','RUNTIME_MIGRATION_ARTIFACT_PRESENT'],['apps/web/node_modules/playwright/index.js','RUNTIME_TEST_DEPENDENCY_PRESENT'],['apps/api/node_modules/@aws-sdk/client-s3/index.js','RUNTIME_BACKUP_TOOLING_PRESENT'],['apps/web/node_modules/example/maintenance/file.js','RUNTIME_MAINTENANCE_ARTIFACT_PRESENT']]){
  await fixture([[name,'// forbidden']],async root=>assert.rejects(assertRuntimeClosure(root),{code}));
 }
});
