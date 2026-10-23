import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join,win32} from 'node:path';
import {execFileSync} from 'node:child_process';
const root='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation';
const oldRoot=root+'/recheck-20261020-v3',nextRoot=root+'/recheck-20261020-v4';
const scripts=join(process.cwd(),'scripts/cloud/daily-data-sync');
const release='7e6e03ed8a72c3c7c7cac57ec965e87d4c697c3b',source='a10f3510c5f1e613579ca002f2ec8e05f57e69ff02c6862af4e111735adc05d2';
const image='sha256:d819ad1665148db480bdef6a24767970af8742c6cb623020ce3281d5228ffcf5';
const oldRelease='971bf5ffaec0abd8869c9b8568e0193a9fbfaff9',oldSource='6f909c45723e80c390e4a2b07085044285a856c07657b8132f0240c99a3368a3';
const hash=b=>createHash('sha256').update(b).digest('hex');
const json=async p=>JSON.parse(await readFile(p,'utf8'));
const tools=await json(nextRoot+'/tools.json'),oldTools=await json(oldRoot+'/tools.json');
const checks={identity:tools.release===release&&tools.source===source&&tools.image===image&&tools.runtimeFiles===493&&tools.uploadFiles===495,
 private:tools.privateName==='performance-recheck-20261020-v4'&&tools.prepPrivate==='performance-recheck-20261020-v4-prep',
 security:tools.securityBaselineDeployment==='58aebafe-e551-4316-a962-7bbe7ffe5f5b'&&tools.securityImage==='sha256:f1ffbe1208fa87980155d6ebc2cf4b6f468be7aacbe8bdf7852201cf871349f0'};
for(const f of tools.files){const b=await readFile(win32.normalize(f.path));if(b.length!==f.size||hash(b)!==f.sha256)throw Error('NEW_TOOL_CLOSURE');}
checks.toolClosure12=tools.files.length===12;
const pairs=[['phase10-resume-recheck3-control-20261020.ps1','phase10-resume-recheck4-control-20261020.ps1'],['phase10-resume-recheck3-fingerprint-20261020.mjs','phase10-resume-recheck4-fingerprint-20261020.mjs'],['phase10-local-recheck3-bootstrap-20261020.cjs','phase10-local-recheck4-bootstrap-20261020.cjs'],['phase10-resume-recheck3-local-container-20261020.ps1','phase10-resume-recheck4-local-container-20261020.ps1'],['phase10-resume-recheck3-light-load-20261020.ps1','phase10-resume-recheck4-light-load-20261020.ps1'],['phase10-resume-recheck3-load-telemetry-20261020.ps1','phase10-resume-recheck4-load-telemetry-20261020.ps1'],['phase10-resume-recheck3-metrics-20261020.ps1','phase10-resume-recheck4-metrics-20261020.ps1']];
const common=s=>s.replaceAll(oldRoot,nextRoot).replaceAll(oldRelease,release).replaceAll(oldSource,source).replaceAll('meta-ads-phase10:20261020-v4','meta-ads-phase10:20261020-v5').replaceAll('performance-recheck-20261020-v3','performance-recheck-20261020-v4');
const bootstrap=await readFile(join(scripts,pairs[2][1]));
let astFiles=0;
for(const [from,to] of pairs){
 const old=await readFile(join(scripts,from));
 const pin=oldTools.files.find(f=>win32.normalize(f.path).toLowerCase()===win32.normalize(join(scripts,from)).toLowerCase());
 if(!pin||old.length!==pin.size||hash(old)!==pin.sha256)throw Error('OLD_TOOL_CHANGED');
 let expected=common(old.toString('utf8'));
 if(to.includes('-control-'))expected=expected.replaceAll('7775ae68-c04c-4d9d-9861-bdfc3dea0b3b','58aebafe-e551-4316-a962-7bbe7ffe5f5b').replaceAll('phase10-resume-recheck3-fingerprint-20261020.mjs','phase10-resume-recheck4-fingerprint-20261020.mjs').replaceAll(root+'/upload-recheck-20261020-v3',root+'/upload-recheck-20261020-v4');
 if(to.includes('-local-container-'))expected=expected.replaceAll('meta-ads-phase10-20261020-recheck3-1gb','meta-ads-phase10-20261020-recheck4-1gb').replaceAll('sha256:11b3c691b4b86990f666392344fbe9969e32d2085b5d304d5d10862e63cbd283',image).replaceAll('phase10-local-recheck3-bootstrap-20261020.cjs','phase10-local-recheck4-bootstrap-20261020.cjs').replaceAll('849cc7ae74951f0e9d3a2f4990e87e858519db0ce9c29ffe886ed510e5bf1f8e',hash(bootstrap));
 if(to.includes('-load-telemetry-'))expected=expected.replaceAll('phase10-resume-recheck3-light-load-20261020.ps1','phase10-resume-recheck4-light-load-20261020.ps1');
 const actual=await readFile(join(scripts,to),'utf8');if(actual!==expected)throw Error('UNEXPECTED_TRANSFORM');
 for(const forbidden of [oldRoot,'performance-recheck-20261020-v3',oldRelease,oldSource,'sha256:11b3c691b4b86990f666392344fbe9969e32d2085b5d304d5d10862e63cbd283','7775ae68-c04c-4d9d-9861-bdfc3dea0b3b'])if(actual.includes(forbidden))throw Error('OLD_PIN_REMAINS');
 if(to.endsWith('.ps1')){const output=execFileSync('pwsh',['-NoProfile','-Command',`$t=$null;$e=$null;$null=[Management.Automation.Language.Parser]::ParseFile('${join(scripts,to).replaceAll("'","''")}',[ref]$t,[ref]$e);if($e.Count){exit 1};'PASS'`],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']});if(output.trim()!=='PASS')throw Error('AST');astFiles++;}
 else execFileSync(process.execPath,['--check',join(scripts,to)],{stdio:['ignore','pipe','pipe'],windowsHide:true});
}
checks.frozenTemplatesAndExactTransforms7=true;checks.oldExecutablePinsAbsent=true;checks.ast5=astFiles===5;checks.bootstrapHash=hash(bootstrap)==='1f609ecc6116e77a7f970b4f37cfed0616034d890e86b3a0d07f10310bc0617e';
const candidate=root+'/candidate-20261020-v5';
const manifest=await json(candidate+'/source-content-manifest.json'),previous=await json(root+'/candidate-20261020-v4/source-content-manifest.json');
const oldByName=new Map(previous.files.map(f=>[f.name,f]));
checks.manifest493=manifest.files.length===493&&new Set(manifest.files.map(f=>f.name)).size===493&&hash(JSON.stringify(manifest.files))===source&&manifest.sourceContentSha256===source;
const changed=[];for(const f of manifest.files){const b=await readFile(join(candidate,f.name));if(b.length!==f.size||hash(b)!==f.sha256)throw Error('RUNTIME_BYTES');if(oldByName.get(f.name)?.sha256!==f.sha256)changed.push(f.name);}
const reviewed=await json(root+'/independent/resume-20261020/projection-batch-review-v1.json');
checks.onlyReviewedSevenChanged=changed.length===7&&JSON.stringify([...changed].sort())===JSON.stringify(Object.keys(reviewed.sourceHashes).sort())&&manifest.files.filter(f=>changed.includes(f.name)).every(f=>reviewed.sourceHashes[f.name]===f.sha256);
checks.oldReturnGuardPreserved=manifest.files.find(f=>f.name==='apps/api/src/daily-sync/old-app-rollback-readiness.ts').sha256==='f364f848560faef791bcf01470cd8d294966f6165ecf435dd87e795ee4891ade';
const upload=await json(nextRoot+'/upload.json');for(const f of upload.files){const b=await readFile(join(root+'/upload-recheck-20261020-v4',f.name));if(b.length!==f.size||hash(b)!==f.sha256)throw Error('UPLOAD_BYTES');}
checks.upload495=upload.files.length===495&&upload.commit===release&&upload.sourceContentSha256===source;
const dockerfile=await readFile(candidate+'/deploy/Dockerfile');checks.productionDockerfile=dockerfile.equals(await readFile(root+'/candidate-20261020-v4/deploy/Dockerfile'))&&hash(dockerfile)===tools.extraProductionDockerfileSha256;
const acceptance=await json(nextRoot+'/acceptance-read.json');checks.acceptance=acceptance.requests===40&&acceptance.concurrency===4&&acceptance.maximumP95Ms===5000&&acceptance.maximumErrors===0&&acceptance.maximumReadTestWindowMinutes===20&&acceptance.featureOnForPublishedReadsOnly===true&&acceptance.scheduleEnabled===false;
checks.priorHeldUnchanged=(await readFile(nextRoot+'/previous-final-held.json')).equals(await readFile(oldRoot+'/final-stop-reconciled.json'));
checks.resourceBaseline=(await readFile(nextRoot+'/railway-resources-before.json')).equals(await readFile(oldRoot+'/railway-resources-before.json'));
checks.initialFailureBound=tools.previousInitialFinalSha256===hash(await readFile(oldRoot+'/final-held.json'))&&tools.previousInitialFinalSha256==='0c7aa77cf6aa37681ae5a11122ad5e59922dfa4aafe6e241881b553c2776c69b';
checks.reconciledFinalBound=tools.previousReconciledFinalSha256===hash(await readFile(oldRoot+'/final-stop-reconciled.json'))&&tools.previousReconciledFinalSha256==='ae95be762f043f4b4f403ec9f5ac07187546e9d85bb13839501998981947b85d';
const result={kind:'INDEPENDENT_GENERATED_RECHECK4_TOOLS_REVIEW',at:new Date().toISOString(),status:Object.values(checks).every(Boolean)?'PASS_LOCAL_REVIEW':'FAIL',checks,candidate:{release,source,image},toolsSha256:hash(await readFile(nextRoot+'/tools.json')),migrationScope:'Unchanged493manifest except approved6product+1fixture,51migration digest enforced by generator',controlReview:['fresh68 and resource CAS','same fresh secrets; two public release/source pins and bounded read feature only','20minute eligibility; no automatic cloud expiry rollback','single40GET/concurrency4/errors0/p95<=5000; logout204 and no retry','restore exact held security image/pins/featurefalse,NOLOGIN/backendterminate/deploymentStop','private oldSession/audit fullrow/stableUser comparison retained'],remoteRequests:0,protectedMaterialReads:0,originalReceiptsModified:0};
const path=root+'/independent/resume-20261020/recheck4-tools-review-v1.json';await writeFile(path,JSON.stringify(result,null,2)+'\n',{flag:'wx'});process.stdout.write(JSON.stringify({status:result.status,checks,path,sha256:hash(await readFile(path))})+'\n');if(result.status!=='PASS_LOCAL_REVIEW')process.exitCode=1;
