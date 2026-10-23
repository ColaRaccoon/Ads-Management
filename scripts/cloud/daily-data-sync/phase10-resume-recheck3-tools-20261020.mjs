// The preceding candidate was prepared but never activated. Preserve it and all failed batches.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const root='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation';
const oldRoot=root+'/recheck-20261020-v2',nextRoot=root+'/recheck-20261020-v3';
const scripts=join(process.cwd(),'scripts/cloud/daily-data-sync'),candidate=root+'/candidate-20261020-v4';
const ev=JSON.parse(await readFile(root+'/evidence/candidate-20261020-v4.json','utf8'));
const manifest=JSON.parse(await readFile(candidate+'/source-content-manifest.json','utf8'));
const oldManifest=JSON.parse(await readFile(root+'/candidate-20261020-v3/source-content-manifest.json','utf8'));
const [image,release,source]=process.argv.slice(2),tag='meta-ads-phase10:20261020-v4';
const hash=b=>createHash('sha256').update(b).digest('hex');
const oldRelease='68e64b3d7156e3af81db421e5eb61b85b0fcf21b',oldSource='7dd0bd3275619a427db78a56580e56836fd8cd919e475057eda77bf21e485d84';
const oldImage='sha256:d26c57619dfbc9709c62d2f1d066343a8a8a02f7410fa33c5ff28ac2899d1fb3';
if(!/^sha256:[a-f0-9]{64}$/.test(image??'')||!/^[a-f0-9]{40}$/.test(release??'')||!/^[a-f0-9]{64}$/.test(source??'')||release===oldRelease||source===oldSource||ev.commit!==release||ev.sourceContentSha256!==source||manifest.sourceContentSha256!==source||ev.base!=='9e9a1f82bb02346575565b031a43e17e13758dc8'||ev.migrationCount!==51||ev.migrationDigest!=='57b68bf6bdf6290f9ac2f3a4ec3664d38e8b6ed7f6ed9c9da4de9cd1208139b0')throw Error('FRESH_IDENTITY_REQUIRED');
if(manifest.files.length!==493||oldManifest.files.length!==493||oldManifest.sourceContentSha256!==oldSource||hash(JSON.stringify(oldManifest.files))!==oldSource||hash(JSON.stringify(manifest.files))!==source||new Set(manifest.files.map(f=>f.name)).size!==493||new Set(oldManifest.files.map(f=>f.name)).size!==493)throw Error('CANONICAL_MANIFESTS');
const oldByName=new Map(oldManifest.files.map(f=>[f.name,f]));
const changes=manifest.files.filter(f=>oldByName.get(f.name)?.sha256!==f.sha256).map(f=>f.name);
if(changes.length!==1||changes[0]!=='apps/api/src/daily-sync/old-app-rollback-readiness.ts'||manifest.files.some(f=>!oldByName.has(f.name)))throw Error('ONLY_REVIEWED_RETURN_GUARD');
for(const name of ['bounded-plan-v2','bounded-plan-v3','activated','activated-read','submitted','ready','final-held'])if(existsSync(oldRoot+'/'+name+'.json'))throw Error('PRIOR_PREPARATION_CONSUMED');
for(const name of ['performance-recheck-20261020-v2','performance-recheck-20261020-v2-prep','performance-recheck-20261020-v3','performance-recheck-20261020-v3-prep'])if(existsSync('C:/Users/seong/AppData/Local/MetaAdsPhase08Runtime/incident-20261019/'+name+'.dpapi'))throw Error('PRIVATE_PREPARATION_ALREADY_EXISTS');
const priorTools=JSON.parse(await readFile(oldRoot+'/tools.json','utf8'));
if(priorTools.release!==oldRelease||priorTools.source!==oldSource||priorTools.image!==oldImage)throw Error('PRIOR_TOOL_IDENTITY');
const originals=['phase10-resume-recheck2-control-20261020.ps1','phase10-resume-recheck2-fingerprint-20261020.mjs','phase10-local-recheck2-bootstrap-20261020.cjs','phase10-resume-recheck2-local-container-20261020.ps1','phase10-resume-recheck2-light-load-20261020.ps1','phase10-resume-recheck2-load-telemetry-20261020.ps1','phase10-resume-recheck2-metrics-20261020.ps1'];
for(const name of originals){const p=join(scripts,name),proof=priorTools.files.filter(f=>f.path.replaceAll('\\','/').toLowerCase()===p.replaceAll('\\','/').toLowerCase()),b=await readFile(p);if(proof.length!==1||b.length!==proof[0].size||hash(b)!==proof[0].sha256)throw Error('PRIOR_TOOL_DRIFT');}
const dockerfile=await readFile(candidate+'/deploy/Dockerfile');if(!dockerfile.equals(await readFile(root+'/candidate-20261020-v3/deploy/Dockerfile')))throw Error('DOCKERFILE_DRIFT');
const inspected=execFileSync('docker',['image','inspect','--format','{{.Id}}|{{index .Config.Labels "org.opencontainers.image.revision"}}',tag],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}).trim();
if(inspected!==image+'|'+release)throw Error('IMAGE_IDENTITY');
for(const f of manifest.files){const b=await readFile(join(candidate,f.name));if(b.length!==f.size||hash(b)!==f.sha256)throw Error('CANDIDATE_BYTES');}
await mkdir(nextRoot,{recursive:false});const outputs=[];
async function save(path,b){await writeFile(path,b,{flag:'wx'});outputs.push({path,size:Buffer.byteLength(b),sha256:hash(b)});}
const mainPrivate='performance-recheck-20261020-v3',prepPrivate=mainPrivate+'-prep';
function common(s){return s.replaceAll(oldRoot,nextRoot).replaceAll(oldRelease,release).replaceAll(oldSource,source).replaceAll('meta-ads-phase10:20261020-v3',tag).replaceAll('performance-recheck-20261020-v2',mainPrivate);}
async function clone(from,to,transform=s=>s){await save(join(scripts,to),transform(common(await readFile(join(scripts,from),'utf8'))));}
const upload=root+'/upload-recheck-20261020-v3';await mkdir(upload,{recursive:false});const files=[];
for(const f of [...manifest.files,{name:'source-content-manifest.json'},{name:'deploy/Dockerfile'}]){const b=await readFile(join(candidate,f.name));await mkdir(join(upload,f.name,'..'),{recursive:true});await writeFile(join(upload,f.name),b,{flag:'wx'});files.push({name:f.name,size:b.length,sha256:hash(b)});}
if(files.length!==495)throw Error('UPLOAD_COUNT');
await save(join(nextRoot,'upload.json'),JSON.stringify({kind:'PHASE10_UPLOAD_CLOSURE_VERIFIED',commit:release,sourceContentSha256:source,fileCount:495,files,secretsIncluded:false,generatedFilesIncluded:false},null,2));
const acceptance=JSON.parse(await readFile(oldRoot+'/acceptance-read.json','utf8'));acceptance.recordedAt=new Date().toISOString();acceptance.changedCandidateRecheck=true;acceptance.previousFailedBatchPreserved=true;acceptance.sameCandidateAutomaticRetry=false;
await save(join(nextRoot,'acceptance-read.json'),JSON.stringify(acceptance,null,2));
const resourceBytes=await readFile(oldRoot+'/railway-resources-before.json');await save(join(nextRoot,'railway-resources-before.json'),resourceBytes);
const projectionBytes=await readFile(oldRoot+'/preload-meta-projection.json'),heldBytes=await readFile(oldRoot+'/previous-final-held.json');
const held=JSON.parse(heldBytes),baseline=JSON.parse(await readFile(root+'/recheck-20261020-v1/bounded-plan-v2.json','utf8'));
const oldMetric=baseline.snapshot.table_digests.find(t=>t.table==='meta_adset_daily_metrics'),heldMetric=held.snapshot.table_digests.find(t=>t.table==='meta_adset_daily_metrics');
if(held.status!=='PASS_CONTAINMENT_WITH_EXTERNAL_RESIDUALS'||held.deployment.id!=='7775ae68-c04c-4d9d-9861-bdfc3dea0b3b'||!oldMetric||!heldMetric||oldMetric.rows!==heldMetric.rows||oldMetric.md5!==heldMetric.md5)throw Error('HELD_PROJECTION_PRESERVATION');
await save(join(nextRoot,'preload-meta-projection.json'),JSON.stringify({...JSON.parse(projectionBytes),reusedFromSha256:hash(projectionBytes),reuseFinalHeldSha256:hash(heldBytes),reuseBusinessTableHash:heldMetric.md5,freshlyQueriedThisRecheck:false},null,2));
await save(join(nextRoot,'previous-final-held.json'),heldBytes);
await clone(originals[0],'phase10-resume-recheck3-control-20261020.ps1',s=>s.replaceAll('phase10-resume-recheck2-fingerprint-20261020.mjs','phase10-resume-recheck3-fingerprint-20261020.mjs').replaceAll(root+'/upload-recheck-20261020-v2',upload));
await clone(originals[1],'phase10-resume-recheck3-fingerprint-20261020.mjs');
const bootName='phase10-local-recheck3-bootstrap-20261020.cjs',oldBoot=await readFile(join(scripts,originals[2]),'utf8'),boot=common(oldBoot);await save(join(scripts,bootName),boot);
await clone(originals[3],'phase10-resume-recheck3-local-container-20261020.ps1',s=>s.replaceAll('meta-ads-phase10-20261020-recheck2-1gb','meta-ads-phase10-20261020-recheck3-1gb').replaceAll(oldImage,image).replaceAll(originals[2],bootName).replaceAll(hash(oldBoot),hash(boot)));
await clone(originals[4],'phase10-resume-recheck3-light-load-20261020.ps1');
await clone(originals[5],'phase10-resume-recheck3-load-telemetry-20261020.ps1',s=>s.replaceAll(originals[4],'phase10-resume-recheck3-light-load-20261020.ps1'));
await clone(originals[6],'phase10-resume-recheck3-metrics-20261020.ps1');
await save(join(nextRoot,'tools.json'),JSON.stringify({kind:'CHANGED_RETURN_GUARD_RECHECK_TOOLS_FROZEN',at:new Date().toISOString(),release,source,image,tag,base:ev.base,runtimeFiles:493,uploadFiles:495,changedSincePreparedV3:changes,previousCandidatePreparedOnly:true,previousPrivatePlanNeverCreated:'performance-recheck-20261020-v2',privateName:mainPrivate,prepPrivate,securityBaselineDeployment:'7775ae68-c04c-4d9d-9861-bdfc3dea0b3b',securityImage:'sha256:f1ffbe1208fa87980155d6ebc2cf4b6f468be7aacbe8bdf7852201cf871349f0',extraProductionDockerfileUnchanged:true,extraProductionDockerfileSha256:hash(dockerfile),previousFailedEvidenceModified:false,resourceBaselineReceiptSha256:hash(resourceBytes),files:outputs},null,2));
console.log(JSON.stringify({kind:'CHANGED_RETURN_GUARD_RECHECK_TOOLS_FROZEN',release,source,image,nextRoot,runtimeFiles:493,uploadFiles:495,tools:outputs.length}));
