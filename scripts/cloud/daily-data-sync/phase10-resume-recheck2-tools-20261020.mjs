// Fresh evidence and controls for a changed SQL candidate. Consumed attempts stay immutable.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const root='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation';
const oldRoot=root+'/recheck-20261020-v1',nextRoot=root+'/recheck-20261020-v2';
const scripts=join(process.cwd(),'scripts/cloud/daily-data-sync'),candidate=root+'/candidate-20261020-v3';
const ev=JSON.parse(await readFile(root+'/evidence/candidate-20261020-v3.json','utf8'));
const manifest=JSON.parse(await readFile(candidate+'/source-content-manifest.json','utf8'));
const oldManifest=JSON.parse(await readFile(root+'/candidate-20261020-v2/source-content-manifest.json','utf8'));
const [image,release,source]=process.argv.slice(2),tag='meta-ads-phase10:20261020-v3';
const hash=b=>createHash('sha256').update(b).digest('hex');
const oldRelease='8b0205842c01ace9d1fa09161059df093527d84f',oldSource='d2b9551f84812846108bdc559adad2c39e6693245f31474ecd3ec1fa9a028f01';
if(!/^sha256:[a-f0-9]{64}$/.test(image??'')||!/^([a-f0-9]{40})$/.test(release??'')||!/^([a-f0-9]{64})$/.test(source??'')||release===oldRelease||source===oldSource||ev.commit!==release||ev.sourceContentSha256!==source||source!==manifest.sourceContentSha256||manifest.files.length!==493||ev.base!=='9e9a1f82bb02346575565b031a43e17e13758dc8'||ev.migrationCount!==51||ev.migrationDigest!=='57b68bf6bdf6290f9ac2f3a4ec3664d38e8b6ed7f6ed9c9da4de9cd1208139b0')throw Error('FRESH_EXACT_IDENTITY_REQUIRED');
if(oldManifest.files.length!==493||oldManifest.sourceContentSha256!==oldSource||hash(JSON.stringify(oldManifest.files))!==oldSource||hash(JSON.stringify(manifest.files))!==source||new Set(oldManifest.files.map(f=>f.name)).size!==493||new Set(manifest.files.map(f=>f.name)).size!==493)throw Error('CANONICAL_UNIQUE_MANIFESTS');
const oldByName=new Map(oldManifest.files.map(f=>[f.name,f]));
const changes=manifest.files.filter(f=>!oldByName.has(f.name)||oldByName.get(f.name).sha256!==f.sha256).map(f=>f.name);
if(changes.length!==1||changes[0]!=='apps/api/src/common/meta-source-read-coverage.ts'||manifest.files.some(f=>!oldByName.has(f.name)))throw Error('ONE_REVIEWED_SQL_FILE_ONLY');
const priorTools=JSON.parse(await readFile(oldRoot+'/tools.json','utf8'));
if(priorTools.release!==oldRelease||priorTools.source!==oldSource||priorTools.image!=='sha256:5f2ef990196e4883f056217427b708738be275b3cb2d42d5f2c8911bc0bf6f08')throw Error('PRIOR_FROZEN_TOOL_IDENTITY');
for(const name of ['phase10-resume-recheck-control-20261020.ps1','phase10-resume-recheck-fingerprint-20261020.mjs','phase10-local-recheck-bootstrap-20261020.cjs','phase10-resume-recheck-local-container-20261020.ps1','phase10-resume-recheck-light-load-20261020.ps1','phase10-resume-recheck-load-telemetry-20261020.ps1','phase10-resume-recheck-metrics-20261020.ps1']){
 const p=join(scripts,name),matches=priorTools.files.filter(f=>f.path.replaceAll('\\','/').toLowerCase()===p.replaceAll('\\','/').toLowerCase());
 const b=await readFile(p);if(matches.length!==1||b.length!==matches[0].size||hash(b)!==matches[0].sha256)throw Error('PRIOR_FROZEN_TOOL_DRIFT');
}
const dockerfile=await readFile(candidate+'/deploy/Dockerfile'),priorDockerfile=await readFile(root+'/candidate-20261020-v2/deploy/Dockerfile');
if(!dockerfile.equals(priorDockerfile))throw Error('EXTRA_PRODUCTION_DOCKERFILE_DRIFT');
const inspected=execFileSync('docker',['image','inspect','--format','{{.Id}}|{{index .Config.Labels "org.opencontainers.image.revision"}}',tag],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}).trim();
if(inspected!==image+'|'+release)throw Error('IMAGE_IDENTITY');
for(const f of manifest.files){const b=await readFile(join(candidate,f.name));if(b.length!==f.size||hash(b)!==f.sha256)throw Error('CANDIDATE_BYTES');}
const mainPrivate='performance-recheck-20261020-v2',prepPrivate=mainPrivate+'-prep';
const outputs=[];await mkdir(nextRoot,{recursive:false});
async function save(path,b){await writeFile(path,b,{flag:'wx'});outputs.push({path,size:Buffer.byteLength(b),sha256:hash(b)});}
function common(s){return s.replaceAll(oldRoot,nextRoot).replaceAll(oldRelease,release).replaceAll(oldSource,source).replaceAll('meta-ads-phase10:20261020-v2',tag).replaceAll('performance-recheck-20261020-v1',mainPrivate);}
async function clone(from,to,transform=s=>s){await save(join(scripts,to),transform(common(await readFile(join(scripts,from),'utf8'))));}
const upload=root+'/upload-recheck-20261020-v2';await mkdir(upload,{recursive:false});const files=[];
for(const f of [...manifest.files,{name:'source-content-manifest.json'},{name:'deploy/Dockerfile'}]){const b=await readFile(join(candidate,f.name));await mkdir(join(upload,f.name,'..'),{recursive:true});await writeFile(join(upload,f.name),b,{flag:'wx'});files.push({name:f.name,size:b.length,sha256:hash(b)});}
if(files.length!==495)throw Error('UPLOAD_COUNT');
await save(join(nextRoot,'upload.json'),JSON.stringify({kind:'PHASE10_UPLOAD_CLOSURE_VERIFIED',commit:release,sourceContentSha256:source,fileCount:files.length,files,secretsIncluded:false,generatedFilesIncluded:false},null,2));
const acceptance=JSON.parse(await readFile(oldRoot+'/acceptance-read.json','utf8'));
acceptance.recordedAt=new Date().toISOString();acceptance.changedCandidateRecheck=true;acceptance.previousFailedBatchPreserved=true;acceptance.sameCandidateAutomaticRetry=false;
await save(join(nextRoot,'acceptance-read.json'),JSON.stringify(acceptance,null,2));
const resourceBytes=await readFile(oldRoot+'/railway-resources-before.json');await save(join(nextRoot,'railway-resources-before.json'),resourceBytes);
const projectionBytes=await readFile(oldRoot+'/preload-meta-projection.json'),heldBytes=await readFile(oldRoot+'/final-held.json');
const held=JSON.parse(heldBytes),baseline=JSON.parse(await readFile(oldRoot+'/bounded-plan-v2.json','utf8'));
const oldMetric=baseline.snapshot.table_digests.find(t=>t.table==='meta_adset_daily_metrics'),heldMetric=held.snapshot.table_digests.find(t=>t.table==='meta_adset_daily_metrics');
if(held.status!=='PASS_CONTAINMENT_WITH_EXTERNAL_RESIDUALS'||held.deployment.id!=='7775ae68-c04c-4d9d-9861-bdfc3dea0b3b'||!oldMetric||!heldMetric||oldMetric.rows!==heldMetric.rows||oldMetric.md5!==heldMetric.md5)throw Error('HELD_PROJECTION_PRESERVATION');
await save(join(nextRoot,'preload-meta-projection.json'),JSON.stringify({...JSON.parse(projectionBytes),reusedFromSha256:hash(projectionBytes),reuseFinalHeldSha256:hash(heldBytes),reuseBusinessTableHash:heldMetric.md5,freshlyQueriedThisRecheck:false},null,2));
await save(join(nextRoot,'previous-final-held.json'),heldBytes);
await clone('phase10-resume-recheck-control-20261020.ps1','phase10-resume-recheck2-control-20261020.ps1',s=>s
 .replaceAll('29edadd5-2df6-4b85-abd2-79c3faff9909','7775ae68-c04c-4d9d-9861-bdfc3dea0b3b')
 .replaceAll('phase10-resume-recheck-fingerprint-20261020.mjs','phase10-resume-recheck2-fingerprint-20261020.mjs')
 .replaceAll(root+'/upload-recheck-20261020-v1',upload));
await clone('phase10-resume-recheck-fingerprint-20261020.mjs','phase10-resume-recheck2-fingerprint-20261020.mjs');
const bootName='phase10-local-recheck2-bootstrap-20261020.cjs';
const boot=common(await readFile(join(scripts,'phase10-local-recheck-bootstrap-20261020.cjs'),'utf8'));await save(join(scripts,bootName),boot);
await clone('phase10-resume-recheck-local-container-20261020.ps1','phase10-resume-recheck2-local-container-20261020.ps1',s=>s
 .replaceAll('meta-ads-phase10-20261020-recheck1-1gb','meta-ads-phase10-20261020-recheck2-1gb')
 .replaceAll('sha256:5f2ef990196e4883f056217427b708738be275b3cb2d42d5f2c8911bc0bf6f08',image)
 .replaceAll('phase10-local-recheck-bootstrap-20261020.cjs',bootName)
 .replaceAll('31d16502e71509319bc2afd38e879b2243f0f78e11ce96a0362e52ccd12cb7a7',hash(boot)));
await clone('phase10-resume-recheck-light-load-20261020.ps1','phase10-resume-recheck2-light-load-20261020.ps1');
await clone('phase10-resume-recheck-load-telemetry-20261020.ps1','phase10-resume-recheck2-load-telemetry-20261020.ps1',s=>s.replaceAll('phase10-resume-recheck-light-load-20261020.ps1','phase10-resume-recheck2-light-load-20261020.ps1'));
await clone('phase10-resume-recheck-metrics-20261020.ps1','phase10-resume-recheck2-metrics-20261020.ps1');
await save(join(nextRoot,'tools.json'),JSON.stringify({kind:'CHANGED_SQL_SOURCE_RECHECK_TOOLS_FROZEN',at:new Date().toISOString(),release,source,image,tag,base:ev.base,runtimeFiles:493,uploadFiles:495,changedRuntimeFiles:changes,extraProductionDockerfileUnchanged:true,extraProductionDockerfileSha256:hash(dockerfile),privateName:mainPrivate,prepPrivate,securityBaselineDeployment:'7775ae68-c04c-4d9d-9861-bdfc3dea0b3b',securityImage:'sha256:f1ffbe1208fa87980155d6ebc2cf4b6f468be7aacbe8bdf7852201cf871349f0',previousFailedEvidenceModified:false,resourceBaselineReceiptSha256:hash(resourceBytes),files:outputs},null,2));
console.log(JSON.stringify({kind:'CHANGED_SQL_SOURCE_RECHECK_TOOLS_FROZEN',release,source,image,nextRoot,runtimeFiles:493,uploadFiles:495,tools:outputs.length}));
