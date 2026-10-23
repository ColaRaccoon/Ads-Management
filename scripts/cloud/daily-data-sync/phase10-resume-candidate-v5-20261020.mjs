import {assembleFullApp} from './assemble-full-app.mjs';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const root='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation',repo=process.cwd();
const output=resolve(root+'/candidate-20261020-v5');
const hash=b=>createHash('sha256').update(b).digest('hex');
const git=(cwd,args)=>execFileSync('git',args,{cwd,encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}).trim();
const base=git(repo,['rev-parse','HEAD']),branch=git(repo,['branch','--show-current']);
if(base!=='9e9a1f82bb02346575565b031a43e17e13758dc8'||branch!=='codex/daily-data-automation-01'||git(repo,['diff','--cached','--name-only'])!=='')throw Error('ORIGINAL_CHECKOUT_GUARD');
const reviewed=JSON.parse(await readFile(process.argv[2],'utf8'));
const allowed=new Set([
 'apps/api/src/common/meta-source-read-coverage.ts',
 'apps/api/src/common/meta-collection-summary.ts',
 'apps/api/src/metrics/dashboard-metrics.service.ts',
 'apps/api/src/metrics/meta-adset-metric-decoration.service.ts',
 'apps/api/src/metrics/dashboard-decimal-metrics.ts',
 'apps/api/src/storefront/storefront-read.service.ts',
 'apps/api/src/storefront/storefront.spec.ts'
]);
if(reviewed.kind!=='REVIEWED_V5_QUERY_REDUCTION'||reviewed.baseSource!=='6f909c45723e80c390e4a2b07085044285a856c07657b8132f0240c99a3368a3'||!Array.isArray(reviewed.files)||reviewed.files.length<1||reviewed.files.length>allowed.size||new Set(reviewed.files.map(f=>f.name)).size!==reviewed.files.length)throw Error('REVIEWED_SELECTION');
for(const f of reviewed.files)if(!allowed.has(f.name)||!/^[a-f0-9]{64}$/.test(f.sha256)||hash(await readFile(join(repo,f.name)))!==f.sha256)throw Error('REVIEWED_BYTES');
if(hash(await readFile(join(repo,'apps/api/src/daily-sync/old-app-rollback-readiness.ts')))!=='f364f848560faef791bcf01470cd8d294966f6165ecf435dd87e795ee4891ade')throw Error('RETURN_SAFETY_GUARD');
const status=execFileSync('git',['status','--porcelain=v1','-uall'],{cwd:repo,encoding:'utf8',windowsHide:true});
const deleted=status.split('\n').filter(s=>s.startsWith(' D ')).length;if(deleted!==240)throw Error('DELETED_BASELINE_COUNT');
const old=JSON.parse(await readFile(root+'/candidate-20261020-v4/source-content-manifest.json','utf8'));
const oldByName=new Map(old.files.map(f=>[f.name,f]));
if(old.sourceContentSha256!==reviewed.baseSource||hash(JSON.stringify(old.files))!==reviewed.baseSource||old.files.length!==493||oldByName.size!==493)throw Error('PRIOR_MANIFEST');
// Check the complete expected runtime closure before assemble creates its immutable directory.
for(const f of old.files){const expected=reviewed.files.find(r=>r.name===f.name)?.sha256??f.sha256;if(hash(await readFile(join(repo,f.name)))!==expected)throw Error('UNREVIEWED_RUNTIME_DRIFT');}
const result=await assembleFullApp(output,repo);
const manifest=JSON.parse(await readFile(join(output,'source-content-manifest.json'),'utf8'));
const delta=manifest.files.filter(f=>oldByName.get(f.name)?.sha256!==f.sha256).map(f=>f.name).sort();
if(manifest.files.length!==493||manifest.files.some(f=>!oldByName.has(f.name))||JSON.stringify(delta)!==JSON.stringify(reviewed.files.map(f=>f.name).sort()))throw Error('REVIEWED_QUERY_REDUCTION_DELTA');
for(const f of manifest.files){const expected=reviewed.files.find(r=>r.name===f.name)?.sha256??oldByName.get(f.name).sha256;if(f.sha256!==expected||hash(await readFile(join(output,f.name)))!==expected)throw Error('POST_ASSEMBLE_REVIEWED_BYTES');}
const dockerfile=await readFile(join(repo,'deploy/Dockerfile'));if(!dockerfile.equals(await readFile(root+'/candidate-20261020-v4/deploy/Dockerfile')))throw Error('DOCKERFILE_DRIFT');
await writeFile(join(output,'deploy/Dockerfile'),dockerfile,{flag:'wx'});
const migrations=manifest.files.filter(f=>/^apps\/api\/prisma\/migrations\/[^/]+\/migration\.sql$/.test(f.name));
if(migrations.length!==51||hash(JSON.stringify(migrations))!=='57b68bf6bdf6290f9ac2f3a4ec3664d38e8b6ed7f6ed9c9da4de9cd1208139b0')throw Error('MIGRATION_GUARD');
await writeFile(join(output,'phase10-selection.json'),JSON.stringify({kind:'PHASE10_REVIEWED_QUERY_REDUCTION_SELECTION',base,branch,sourceContentSha256:result.sourceContentSha256,files:manifest.files,migrationDigest:hash(JSON.stringify(migrations)),migrationCount:51,changedSinceV4:delta,reviewedChanges:reviewed.files,extraProductionDockerfileUnchanged:true,originalStatusSha256:hash(status),originalDeleted:deleted,originalCheckoutMutation:false,productionWrites:0},null,2)+'\n',{flag:'wx'});
git(output,['init','-b','codex/daily-data-automation-10-candidate']);git(output,['-c','core.autocrlf=false','add','--all']);
git(output,['-c','user.name=Codex','-c','user.email=codex@local.invalid','commit','-m','Freeze phase10 query roundtrip reduction candidate']);
const commit=git(output,['rev-parse','HEAD']);for(const f of manifest.files)if(hash(await readFile(join(output,f.name)))!==f.sha256)throw Error('POST_COMMIT_SOURCE');
const evidence={...result,commit,base,migrationDigest:hash(JSON.stringify(migrations)),migrationCount:51,apiVersion:'0.1.0',recordedAt:new Date().toISOString(),originalBranchUnchanged:git(repo,['branch','--show-current'])===branch,originalHeadUnchanged:git(repo,['rev-parse','HEAD'])===base,originalStagedEmpty:git(repo,['diff','--cached','--name-only'])==='',standaloneCandidateRepository:true,changedSinceV4:delta,reviewedChanges:reviewed.files,extraProductionDockerfileUnchanged:true};
await writeFile(root+'/evidence/candidate-20261020-v5.json',JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(evidence));
