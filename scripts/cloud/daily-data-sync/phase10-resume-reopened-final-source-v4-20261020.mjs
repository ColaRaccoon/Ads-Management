import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {existsSync,readFileSync,statSync,writeFileSync} from 'node:fs';
import path from 'node:path';
const repo='C:/Users/seong/Desktop/workspace/Meta-Ads-Performance';
const candidate='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/candidate-20261020-v7';
const output='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/continuation-20261020/reopened-final-source-v4.json';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const git=args=>{const r=spawnSync('git',args,{cwd:repo,encoding:'utf8',windowsHide:true,maxBuffer:4*1024*1024});assert.equal(r.status,0);return r.stdout.trim();};
try {
 assert(!existsSync(output),'EVIDENCE_CONSUMED');
 const manifest=JSON.parse(readFileSync(path.join(candidate,'source-content-manifest.json'),'utf8'));
 const candidateHead=spawnSync('git',['rev-parse','HEAD'],{cwd:candidate,encoding:'utf8',windowsHide:true});assert.equal(candidateHead.status,0);assert.equal(candidateHead.stdout.trim(),'a49bec345f995ec71f25f9e569caa5fe20578235');
 assert.equal(manifest.sourceContentSha256,'70a7c8cd00c2dd592f632dd35312e283011ef648c5926b5aac4273edb8cea6f2');
 assert.equal(manifest.files.length,495);assert.equal(new Set(manifest.files.map(f=>f.name)).size,495);
 for(const file of manifest.files){
  assert(typeof file.name==='string'&&!path.isAbsolute(file.name)&&!file.name.split(/[\\/]/).includes('..'));
  assert(/^[a-f0-9]{64}$/.test(file.sha256)&&Number.isSafeInteger(file.size)&&file.size>=0);
  for(const root of [repo,candidate]){const p=path.join(root,file.name);assert.equal(statSync(p).size,file.size);assert.equal(hash(readFileSync(p)),file.sha256);}
 }
 const head=git(['rev-parse','HEAD']),branch=git(['branch','--show-current']);
 assert.equal(head,'9e9a1f82bb02346575565b031a43e17e13758dc8');assert.equal(branch,'codex/daily-data-automation-01');assert.equal(git(['diff','--cached','--name-only']),'');
 const deleted=git(['diff','--name-only','--diff-filter=D','-z']).split('\0').filter(Boolean);assert.equal(deleted.length,240);
 const migrations=manifest.files.filter(f=>/^apps\/api\/prisma\/migrations\/[^/]+\/migration\.sql$/.test(f.name));assert.equal(migrations.length,52);
 const result={kind:'PHASE10_REOPENED_LOCAL_SOURCE_CLOSURE',status:'PASS',at:new Date().toISOString(),head,branch,staged:0,deleted:240,deletedPathSetSha256:hash(JSON.stringify(deleted.sort())),
  filesMatchedCandidateAndWorkspace:495,candidateRelease:'a49bec345f995ec71f25f9e569caa5fe20578235',candidateSource:manifest.sourceContentSha256,migrationCount:52,
  operationSourceMutations:0,operatingChanges:0,sharedCredentialChanges:0,stages11And12Started:false,rawValuesReturned:0};
 writeFileSync(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({status:'PASS',runtimeFiles:495,migrations:52,staged:0,deleted:240,evidence:output}));
}catch{console.log(JSON.stringify({status:'FAIL',rawErrorSuppressed:true,operationSourceMutations:0}));process.exitCode=1;}
