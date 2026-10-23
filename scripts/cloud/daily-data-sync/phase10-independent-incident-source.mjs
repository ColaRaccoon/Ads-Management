import {readFile,lstat,readdir,writeFile} from 'node:fs/promises';
import {resolve,join,relative,isAbsolute,sep} from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const root='C:/Users/seong/AppData/Local/MetaAdsPhase10Incident20261019';
const before='C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/full-app-build-20261016-meta-history-v22';
const after=join(root,'upload-v2'),sha=b=>createHash('sha256').update(b).digest('hex');
let stage='MANIFESTS';
try{
 const old=JSON.parse(await readFile(join(before,'source-content-manifest.json'),'utf8'));
 const fresh=JSON.parse(await readFile(join(after,'source-content-manifest.json'),'utf8'));
 assert.equal(old.sourceContentSha256,'0f790d901c949fc456dce6ab863b4bccca10a212b7c7b75afb03f52a0979fdc1');
 assert.equal(fresh.sourceContentSha256,'6d60d1662730508e19af171124310b82693c0687d86efdd76fa0663f367a767e');
 for(const manifest of [old,fresh]){assert.equal(manifest.files.length,475);assert.equal(manifest.secretsIncluded,false);assert.equal(sha(JSON.stringify(manifest.files)),manifest.sourceContentSha256);assert.equal(new Set(manifest.files.map(f=>f.name)).size,475);}
 assert.deepEqual(old.files.map(f=>f.name).sort(),fresh.files.map(f=>f.name).sort());
 async function checked(base,file){
  assert.equal(typeof file.name,'string');assert(!isAbsolute(file.name));assert(!file.name.split(/[\\/]/).includes('..'));
  const path=resolve(base,file.name),rel=relative(base,path);assert(rel&&!rel.startsWith(`..${sep}`)&&!isAbsolute(rel));
  const item=await lstat(path);assert(item.isFile()&&!item.isSymbolicLink());assert.equal(item.size,file.size);
  const hash=sha(await readFile(path));assert.equal(hash,file.sha256);return hash;
 }
 stage='ALL_BYTES';const inventory=[];
 for(const file of fresh.files){const prior=old.files.find(f=>f.name===file.name);const [beforeSha256,afterSha256]=await Promise.all([checked(before,prior),checked(after,file)]);inventory.push({name:file.name,beforeSha256,afterSha256,changed:beforeSha256!==afterSha256});}
 const changes=inventory.filter(f=>f.changed);assert.equal(changes.length,8);
 const required=['apps/api/src/daily-sync/credential-vault.ts','apps/api/src/daily-sync/cafe24-observed-revision.ts','apps/api/src/daily-sync/daily-sync.module.ts','package.json','package-lock.json','apps/api/package.json','apps/web/package.json'];
 for(const name of required)assert(changes.some(f=>f.name===name));
 const remainder=changes.filter(f=>!required.includes(f.name));assert.equal(remainder.length,1);assert.match(remainder[0].name,/closure/i);
 const files=[];async function walk(dir){for(const item of await readdir(dir,{withFileTypes:true})){assert(!item.isSymbolicLink());const p=join(dir,item.name);if(item.isDirectory())await walk(p);else{assert(item.isFile());files.push(relative(after,p).replaceAll('\\','/'));}}}await walk(after);
 assert.deepEqual(files.sort(),[...fresh.files.map(f=>f.name),'source-content-manifest.json'].sort());
 stage='RECEIPT';const out={kind:'INCIDENT_INDEPENDENT_ORIGINAL08_TO_V2_SOURCE_BYTES',at:new Date().toISOString(),status:'PASS',beforeSource:old.sourceContentSha256,afterSource:fresh.sourceContentSha256,manifestFileCount:475,uploadTotalFileCount:476,addedFiles:0,removedFiles:0,changedFiles:8,unchangedFiles:467,changes,inventory,allOriginalAndNewManifestBytesChecked:true,wholeManifestHashRecalculated:true,dependencyInstallOrAppStartPerformed:false,remoteRequests:0,remoteMutations:0,rawSecretsReturned:0};
 const path=join(root,'independent','source-original08-to-v2.json');await writeFile(path,JSON.stringify(out,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({kind:out.kind,status:'PASS',changedFileNames:changes.map(f=>f.name),unchangedFiles:467,evidence:path,remoteRequests:0,rawSecretsReturned:0}));
}catch{console.log(JSON.stringify({kind:'INCIDENT_INDEPENDENT_SOURCE_SAFE_REJECTION',stage,rawErrorSuppressed:true}));process.exitCode=1;}
