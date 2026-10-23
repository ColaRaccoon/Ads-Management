// Create new, immutable tools and evidence for a changed candidate; never reuses a consumed attempt.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const root='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation';
const oldRoot=root+'/continuation-20261020',nextRoot=root+'/recheck-20261020-v1';
const scripts=join(process.cwd(),'scripts/cloud/daily-data-sync');
const candidate=join(root,'candidate-20261020-v2');
const ev=JSON.parse(await readFile(join(root,'evidence/candidate-20261020-v2.json'),'utf8'));
const manifest=JSON.parse(await readFile(join(candidate,'source-content-manifest.json'),'utf8'));
const image=process.argv[2],tag='meta-ads-phase10:20261020-v2';
const hash=b=>createHash('sha256').update(b).digest('hex');
if(!/^sha256:[a-f0-9]{64}$/.test(image??'')||ev.commit!=='8b0205842c01ace9d1fa09161059df093527d84f'||ev.sourceContentSha256!=='d2b9551f84812846108bdc559adad2c39e6693245f31474ecd3ec1fa9a028f01'||ev.sourceContentSha256!==manifest.sourceContentSha256||manifest.files.length!==493||ev.base!=='9e9a1f82bb02346575565b031a43e17e13758dc8')throw Error('NEW_IDENTITY_REQUIRED');
const inspected=execFileSync('docker',['image','inspect','--format','{{.Id}}|{{index .Config.Labels "org.opencontainers.image.revision"}}',tag],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}).trim();
if(inspected!==`${image}|${ev.commit}`)throw Error('IMAGE_IDENTITY');
for(const f of manifest.files){const bytes=await readFile(join(candidate,f.name));if(bytes.length!==f.size||hash(bytes)!==f.sha256)throw Error('CANDIDATE_BYTES');}
await mkdir(nextRoot,{recursive:false});
const oldRelease='177315f2e89ccdf87443086ec9987589efcd934c',oldSource='bb35f2a9563ce80ff9477fb17eb9db568ca268dd273fff506e8fb76136aac8d2';
const mainPrivate='performance-recheck-20261020-v1',prepPrivate=mainPrivate+'-prep';
const outputs=[];
async function save(path,bytes){await writeFile(path,bytes,{flag:'wx'});outputs.push({path,size:Buffer.byteLength(bytes),sha256:hash(bytes)});}
function common(s){return s.replaceAll(oldRoot,nextRoot).replaceAll(oldRelease,ev.commit).replaceAll(oldSource,ev.sourceContentSha256).replaceAll('meta-ads-phase10:20261020-v1',tag);}
async function clone(from,to,transform=s=>s){const input=await readFile(join(scripts,from),'utf8');await save(join(scripts,to),transform(common(input)));}
const upload=root+'/upload-recheck-20261020-v1';await mkdir(upload,{recursive:false});const files=[];
for(const f of [...manifest.files,{name:'source-content-manifest.json'},{name:'deploy/Dockerfile'}]){const bytes=await readFile(join(candidate,f.name));await mkdir(join(upload,f.name,'..'),{recursive:true});await writeFile(join(upload,f.name),bytes,{flag:'wx'});files.push({name:f.name,size:bytes.length,sha256:hash(bytes)});}
if(files.length!==495)throw Error('UPLOAD_COUNT');
await save(join(nextRoot,'upload.json'),JSON.stringify({kind:'PHASE10_UPLOAD_CLOSURE_VERIFIED',commit:ev.commit,sourceContentSha256:ev.sourceContentSha256,fileCount:files.length,files,secretsIncluded:false,generatedFilesIncluded:false},null,2));
const acceptance=JSON.parse(await readFile(join(oldRoot,'acceptance-read.json'),'utf8'));acceptance.recordedAt=new Date().toISOString();acceptance.changedCandidateRecheck=true;acceptance.previousFailedBatchPreserved=true;acceptance.sameCandidateAutomaticRetry=false;
await save(join(nextRoot,'acceptance-read.json'),JSON.stringify(acceptance,null,2));
const resourceBytes=await readFile(join(oldRoot,'railway-resources-before.json'));
await save(join(nextRoot,'railway-resources-before.json'),resourceBytes);
const projectionBytes=await readFile(join(oldRoot,'preload-meta-projection.json'));
const heldBytes=await readFile(join(oldRoot,'final-held.json'));
const held=JSON.parse(heldBytes),baseline=JSON.parse(await readFile(join(oldRoot,'bounded-plan-v2.json'),'utf8'));
const oldMetric=baseline.snapshot.table_digests.find(t=>t.table==='meta_adset_daily_metrics');
const heldMetric=held.snapshot.table_digests.find(t=>t.table==='meta_adset_daily_metrics');
if(held.status!=='PASS_CONTAINMENT_WITH_EXTERNAL_RESIDUALS'||!oldMetric||!heldMetric||oldMetric.rows!==heldMetric.rows||oldMetric.md5!==heldMetric.md5)throw Error('PROJECTION_BUSINESS_PRESERVATION');
await save(join(nextRoot,'preload-meta-projection.json'),JSON.stringify({...JSON.parse(projectionBytes),reusedFromSha256:hash(projectionBytes),reuseFinalHeldSha256:hash(heldBytes),reuseBusinessTableHash:heldMetric.md5,freshlyQueriedThisRecheck:false},null,2));
await save(join(nextRoot,'previous-final-held.json'),heldBytes);
await clone('phase10-resume-control-20261020.ps1','phase10-resume-recheck-control-20261020.ps1',s=>s
 .replaceAll('906da6a9-09cd-411a-981b-833b4640abd6','29edadd5-2df6-4b85-abd2-79c3faff9909')
 .replace("$privateName='resume-20261020-v3'",`$privateName=if($Mode -cin @('Prepare','Activate','AbortPrepare')){'${prepPrivate}'}else{'${mainPrivate}'}`)
 .replaceAll("Read-IncidentPrivate 'resume-20261020-v2'",`Read-IncidentPrivate '${prepPrivate}'`)
 .replace("$stage='PREPARE_FRESH_BASELINE';", "$stage='PREPARE_FRESH_BASELINE';$priorHeld=Read-Resume 'previous-final-held';if((Get-IncidentHash $snap.table_digests) -cne (Get-IncidentHash $priorHeld.snapshot.table_digests)){throw 'PREVIOUS_HELD_TABLE_CAS'};")
 .replaceAll("'AbortBeforeSubmit','Submit'","'AbortBeforeSubmit','AbortPrepare','Submit'")
 .replace("$Mode -ceq 'AbortBeforeSubmit'","$Mode -cin @('AbortBeforeSubmit','AbortPrepare')")
 .replaceAll('phase10-resume-fingerprint-20261020.mjs','phase10-resume-recheck-fingerprint-20261020.mjs')
 .replaceAll(root+'/upload-20261020-v1',upload)
 .replace('$proof.fileCount -ne 495',`$proof.fileCount -ne ${files.length}`)
 .replaceAll("supersedesPlan='bounded-plan.json: auth principal not attested'","supersedesPlan='FRESH_CHANGED_CANDIDATE_RECHECK_BASELINE'")
 .replaceAll("supersedes='v2 featurefalse excludes API rows; no local/cloud candidate or auth test executed under v2'","supersedes='PREPARATION_ONLY_NO_CANDIDATE_HTTP; NEW_CHANGED_SOURCE_NOT_A_RETRY'")
 );
await clone('phase10-resume-fingerprint-20261020.mjs','phase10-resume-recheck-fingerprint-20261020.mjs');
const bootName='phase10-local-recheck-bootstrap-20261020.cjs';const bootstrap=common(await readFile(join(scripts,'phase10-local-bootstrap-20261020.cjs'),'utf8'));await save(join(scripts,bootName),bootstrap);
await clone('phase10-resume-local-container-v3-20261020.ps1','phase10-resume-recheck-local-container-20261020.ps1',s=>s
 .replaceAll('meta-ads-phase10-20261020-v3-1gb','meta-ads-phase10-20261020-recheck1-1gb')
 .replaceAll('local-container-v3.json','local-container.json')
 .replaceAll("Read-IncidentPrivate 'resume-20261020-v3'",`Read-IncidentPrivate '${mainPrivate}'`)
 .replaceAll('sha256:65b9a82660e3db019902e5a7ebeddcbebed803e3327882934c95828f5f8887e8',image)
 .replaceAll('phase10-local-bootstrap-20261020.cjs',bootName)
 .replaceAll('0c6559ab5742d27f2e78f8a9bc163df4b9c9f9868da7581c84a12d49207fbc45',hash(bootstrap)));
await clone('phase10-resume-light-load-20261020.ps1','phase10-resume-recheck-light-load-20261020.ps1',s=>s.replaceAll('resume-20261020-v3',mainPrivate));
await clone('phase10-resume-load-telemetry-20261020.ps1','phase10-resume-recheck-load-telemetry-20261020.ps1',s=>s.replaceAll('phase10-resume-light-load-20261020.ps1','phase10-resume-recheck-light-load-20261020.ps1'));
await clone('phase10-resume-metrics-20261020.ps1','phase10-resume-recheck-metrics-20261020.ps1',s=>s.replaceAll('sampleRateSeconds:5,averagingWindowSeconds:5','sampleRateSeconds:60,averagingWindowSeconds:60').replaceAll('requestedSampleSeconds=5','requestedSampleSeconds=60'));
await save(join(nextRoot,'tools.json'),JSON.stringify({kind:'CHANGED_SOURCE_RECHECK_TOOLS_FROZEN',at:new Date().toISOString(),release:ev.commit,source:ev.sourceContentSha256,image,tag,base:ev.base,runtimeFiles:manifest.files.length,uploadFiles:files.length,privateName:mainPrivate,prepPrivate,securityBaselineDeployment:'29edadd5-2df6-4b85-abd2-79c3faff9909',securityImage:'sha256:f1ffbe1208fa87980155d6ebc2cf4b6f468be7aacbe8bdf7852201cf871349f0',previousFailedEvidenceModified:false,resourceBaselineReceiptSha256:hash(resourceBytes),files:outputs},null,2));
console.log(JSON.stringify({kind:'CHANGED_SOURCE_RECHECK_TOOLS_FROZEN',release:ev.commit,source:ev.sourceContentSha256,image,runtimeFiles:manifest.files.length,uploadFiles:files.length,nextRoot,tools:outputs.length}));
