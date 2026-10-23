import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {createHash} from 'node:crypto';
const sha=x=>createHash('sha256').update(x).digest('hex');
const root=resolve('C:/Users/seong/Desktop/workspace/Meta-Ads-Performance');
const original='C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/full-app-build-20261016-meta-history-v22';
const version=process.argv[2]??'v1';if(!['v1','v2'].includes(version))process.exit(1);
const output=`C:/Users/seong/AppData/Local/MetaAdsPhase10Incident20261019/build-${version}`;
const overlay=new Set(['apps/api/src/daily-sync/credential-vault.ts','apps/api/src/daily-sync/cafe24-observed-revision.ts','package.json','package-lock.json','apps/api/package.json','apps/web/package.json','deploy/cloud/assert-runtime-closure.mjs','deploy/cloud/phase08.Dockerfile']);
if(version==='v2')overlay.add('apps/api/src/daily-sync/daily-sync.module.ts');
try {
 const old=JSON.parse(await readFile(join(original,'source-content-manifest.json'),'utf8'));
 if(old.sourceContentSha256!=='0f790d901c949fc456dce6ab863b4bccca10a212b7c7b75afb03f52a0979fdc1'||sha(JSON.stringify(old.files))!==old.sourceContentSha256)throw Error();
 const files=[],bytesByName=new Map(),changes=[];
 for(const entry of old.files){
  if(!/^[a-zA-Z0-9_./@()-]+$/.test(entry.name)||entry.name.includes('..')||/(?:^|\/)(?:\.env|node_modules|\.git|private)(?:\/|$)|\.(?:dpapi|key|dump|log)$/.test(entry.name))throw Error();
  const before=await readFile(join(original,entry.name));if(before.length!==entry.size||sha(before)!==entry.sha256)throw Error();
  const bytes=overlay.has(entry.name)?await readFile(join(root,entry.name)):before;
  const current={name:entry.name,size:bytes.length,sha256:sha(bytes)};files.push(current);bytesByName.set(entry.name,bytes);
  if(current.sha256!==entry.sha256)changes.push({name:entry.name,before:entry.sha256,after:current.sha256});
 }
 if([...overlay].some(n=>!bytesByName.has(n))||changes.length!==(version==='v2'?8:7))throw Error();
 await mkdir(output,{recursive:false});for(const [name,bytes]of bytesByName){const target=join(output,name);await mkdir(dirname(target),{recursive:true});await writeFile(target,bytes,{flag:'wx'});}
 const manifest={version:1,sourceContentSha256:sha(JSON.stringify(files)),files,secretsIncluded:false,remoteChanges:0,dockerfile:'deploy/cloud/phase08.Dockerfile',buildArgument:'PHASE08_SOURCE_CONTENT_SHA256',incidentBase:old.sourceContentSha256,changes};
 await writeFile(join(output,'source-content-manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({kind:'INCIDENT_REVIEWABLE_SNAPSHOT',output,sourceSha:manifest.sourceContentSha256,fileCount:files.length,changes}));
}catch{console.log(JSON.stringify({kind:'INCIDENT_SNAPSHOT_REJECTED',rawErrorSuppressed:true}));process.exitCode=1;}
