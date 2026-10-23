// Standalone candidate only; never stages or commits the user's checkout.
import {assembleFullApp} from './assemble-full-app.mjs';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const E='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation',repo=process.cwd();
const previous=E+'/candidate-20261020-v5',output=E+'/candidate-20261020-v6';
const sha=b=>createHash('sha256').update(b).digest('hex');
const git=(cwd,args)=>execFileSync('git',args,{cwd,encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}).trim();
const base='9e9a1f82bb02346575565b031a43e17e13758dc8',branch='codex/daily-data-automation-01';
const allowedRuntime=new Set(['apps/api/prisma/schema.prisma','apps/api/prisma/migrations/20261020160000_cafe24_observation_epochs/migration.sql','apps/api/src/daily-sync/cafe24-observation-epoch.ts','apps/api/src/daily-sync/cafe24-order-preflight.client.ts','apps/api/src/daily-sync/cafe24-observation.service.ts']);
const allowedExtra=new Set(['deploy/cafe24-test/prepare-live-schema.mjs']);
const status=()=>execFileSync('git',['status','--porcelain=v1','-uall'],{cwd:repo,encoding:'utf8',windowsHide:true});
function guard(){const s=status();if(git(repo,['rev-parse','HEAD'])!==base||git(repo,['branch','--show-current'])!==branch||git(repo,['diff','--cached','--name-only'])!==''||s.split('\n').filter(v=>v.startsWith(' D ')).length!==240)throw Error('ORIGINAL_CHECKOUT_GUARD');return s;}
const beforeStatus=guard(),reviewed=JSON.parse(await readFile(process.argv[2],'utf8'));
if(reviewed.kind!=='REVIEWED_V6_ADDITIVE_OBSERVATION_EPOCH'||reviewed.baseSource!=='a10f3510c5f1e613579ca002f2ec8e05f57e69ff02c6862af4e111735adc05d2'||reviewed.remoteMigrationAuthorized!==false||reviewed.remoteActivationAuthorized!==false||!Array.isArray(reviewed.files)||reviewed.files.length!==6||new Set(reviewed.files.map(f=>f.name)).size!==6)throw Error('REVIEWED_EPOCH_SELECTION');
for(const f of reviewed.files)if(!allowedRuntime.has(f.name)&&!allowedExtra.has(f.name)||!/^[a-f0-9]{64}$/.test(f.sha256)||sha(await readFile(join(repo,f.name)))!==f.sha256)throw Error('REVIEWED_EPOCH_BYTES');
for(const name of [...allowedRuntime,...allowedExtra])if(!reviewed.files.some(f=>f.name===name))throw Error('REVIEWED_EPOCH_FILE_MISSING');
const old=JSON.parse(await readFile(previous+'/source-content-manifest.json','utf8'));
if(old.files.length!==493||old.sourceContentSha256!==reviewed.baseSource||sha(JSON.stringify(old.files))!==reviewed.baseSource)throw Error('PREVIOUS_MANIFEST');
const oldByName=new Map(old.files.map(f=>[f.name,f])),deltaExpected=reviewed.files.filter(f=>allowedRuntime.has(f.name));
for(const f of old.files){const expected=deltaExpected.find(v=>v.name===f.name)?.sha256??f.sha256;if(sha(await readFile(join(repo,f.name)))!==expected)throw Error('UNREVIEWED_RUNTIME_DRIFT');}
const result=await assembleFullApp(output,repo),manifest=JSON.parse(await readFile(output+'/source-content-manifest.json','utf8'));
const delta=manifest.files.filter(f=>oldByName.get(f.name)?.sha256!==f.sha256).map(f=>f.name).sort();
if(manifest.files.length!==495||JSON.stringify(delta)!==JSON.stringify(deltaExpected.map(f=>f.name).sort())||sha(JSON.stringify(manifest.files))!==result.sourceContentSha256)throw Error('EPOCH_CLOSURE_DELTA');
for(const f of manifest.files){const expected=deltaExpected.find(v=>v.name===f.name)?.sha256??oldByName.get(f.name)?.sha256;if(f.sha256!==expected||sha(await readFile(join(output,f.name)))!==expected)throw Error('POST_ASSEMBLE_BYTES');}
const dockerfile=await readFile(repo+'/deploy/Dockerfile');if(!dockerfile.equals(await readFile(previous+'/deploy/Dockerfile')))throw Error('PRODUCTION_DOCKERFILE_DRIFT');
await writeFile(output+'/deploy/Dockerfile',dockerfile,{flag:'wx'});
const migrations=manifest.files.filter(f=>/^apps\/api\/prisma\/migrations\/[^/]+\/migration\.sql$/.test(f.name));
if(migrations.length!==52)throw Error('MIGRATION_COUNT');
const extra=[];for(const f of reviewed.files.filter(f=>allowedExtra.has(f.name)))extra.push({...f,excludedFromRuntimeClosure:true,sha256:sha(await readFile(join(repo,f.name)))});
const selection={kind:'PHASE10_REVIEWED_ADDITIVE_EPOCH_SELECTION',base,branch,sourceContentSha256:result.sourceContentSha256,files:manifest.files,migrationCount:52,migrationDigest:sha(JSON.stringify(migrations)),changedSinceV5:delta,reviewedChanges:reviewed.files,separatelyReviewedTools:extra,extraProductionDockerfileUnchanged:true,originalStatusSha256:sha(beforeStatus),originalDeleted:240,originalCheckoutMutation:false,remoteMigrationApplied:false,remoteActivation:false,sharedCredentialChanges:0};
await writeFile(output+'/phase10-selection.json',JSON.stringify(selection,null,2)+'\n',{flag:'wx'});
git(output,['init','-b','codex/daily-data-automation-10-candidate']);git(output,['-c','core.autocrlf=false','add','--all']);git(output,['-c','user.name=Codex','-c','user.email=codex@local.invalid','commit','-m','Freeze phase10 additive observation epoch candidate']);
for(const f of manifest.files)if(sha(await readFile(join(output,f.name)))!==f.sha256)throw Error('POST_COMMIT_BYTES');
guard();const evidence={...result,commit:git(output,['rev-parse','HEAD']),base,branch,recordedAt:new Date().toISOString(),migrationCount:52,migrationDigest:selection.migrationDigest,changedSinceV5:delta,reviewedChanges:reviewed.files,separatelyReviewedTools:extra,extraProductionDockerfileSha256:sha(dockerfile),originalBranchUnchanged:true,originalHeadUnchanged:true,originalStagedEmpty:true,originalDeleted:240,standaloneCandidateRepository:true,remoteMigrationApplied:false,remoteActivation:false,sharedCredentialChanges:0,stages11And12Started:false};
await writeFile(E+'/evidence/candidate-20261020-v6.json',JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(evidence));
