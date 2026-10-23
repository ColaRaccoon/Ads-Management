import {readFileSync,writeFileSync} from 'node:fs';
import {spawnSync,execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
const E='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation',root=E+'/portable-build-20261020-v3';
const sha=v=>createHash('sha256').update(v).digest('hex');
const build=JSON.parse(readFileSync(root+'/result.json','utf8')),compiled=JSON.parse(readFileSync(root+'/compiled-proof.json','utf8'));
const file=path.resolve('scripts/cloud/daily-data-sync/phase10-cafe-epoch-compiled-smoke-20261020.cjs');
assert.equal(sha(readFileSync(file)),'688358ee9c45476849738a919f57d21e85023aeb02028b5c1ffb2a93d7eac78a');
assert.equal(build.status,'PASS_BUILD_ONLY');assert.equal(compiled.image,build.image.id);assert.equal(compiled.release,build.release);
const revision=execFileSync('docker',['image','inspect',build.image.id,'--format','{{index .Config.Labels "org.opencontainers.image.revision"}}'],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}).trim();assert.equal(revision,build.release);
const result=spawnSync('docker',['run','--rm','--name','phase10-c7-smoke-'+randomUUID(),'--network','none','--read-only','--memory','1000000000','--memory-swap','1000000000','--cpus','1','--pids-limit','64','--cap-drop','ALL','--security-opt','no-new-privileges','--log-driver','none','--mount',`type=bind,src=${file},dst=/tmp/epoch-smoke.cjs,readonly`,build.image.id,'node','/tmp/epoch-smoke.cjs'],{encoding:'utf8',windowsHide:true,timeout:60000,maxBuffer:1048576});
let smoke;try{smoke=JSON.parse(result.stdout);}catch{smoke={status:'FAIL',rawErrorSuppressed:true};}
if(result.status!==0||smoke.status!=='PASS'||smoke.passed!==6||smoke.networkAttempts!==0)throw Error('C7_COMPILED_SMOKE_REJECTED');
for(const f of smoke.compiledModules)assert.equal(compiled.files.find(v=>v.name==='daily-sync/'+f.name)?.sha256,f.sha256);
const proof={kind:'C7_IMAGE_COMPILED_EPOCH_SMOKE',status:'PASS',at:new Date().toISOString(),release:build.release,source:build.source,image:build.image.id,smoke,probeSha256:sha(readFileSync(file)),compiledProofSha256:sha(readFileSync(root+'/compiled-proof.json')),network:'none',readOnly:true,memoryBytes:1000000000,cpu:1,credentialsInjected:0,remoteRequests:0,providerRequests:0,actualEpochDatabasePathExercised:false};
writeFileSync(root+'/epoch-image-smoke.json',JSON.stringify(proof,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({status:'PASS',cases:6,image:build.image.id,remoteRequests:0}));
