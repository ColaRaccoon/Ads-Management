// Frozen v15 plus reviewed Meta unit/publication budgets, never the dirty checkout.
import {readFile,lstat,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {assembleFullApp} from './assemble-full-app.mjs';
const root='C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation',repo=resolve(fileURLToPath(new URL('../../..',import.meta.url)));
const hash=b=>createHash('sha256').update(b).digest('hex');
const allowed=['apps/api/src/daily-sync/scheduled-occurrence.ts'];
export async function assembleOctober16RepeatCandidate(replacements){
 if(!replacements||typeof replacements!=='object'||Array.isArray(replacements)||Object.keys(replacements).length!==1||Object.keys(replacements).some(k=>!allowed.includes(k))||Object.values(replacements).some(v=>typeof v!=='string'||!/^[a-f0-9]{64}$/.test(v)))throw Error('INPUT');
 const base=join(root,'full-app-build-20261016-meta-pointer-v20'),stage=join(root,'full-app-stage-20261016-meta-repeat-v21'),output=join(root,'full-app-build-20261016-meta-repeat-v21');
 const manifest=JSON.parse(await readFile(join(base,'source-content-manifest.json'),'utf8'));
 if(manifest.sourceContentSha256!=='81b8ba86b22f2019227433f9e0f87ced95d97a44b44ba69d494eec0d664ce537'||manifest.files.length!==475||manifest.secretsIncluded!==false||hash(JSON.stringify(manifest.files))!==manifest.sourceContentSha256)throw Error('BASE');
 const files=[];for(const entry of manifest.files){
  if(typeof entry.name!=='string'||entry.name.includes('..')||entry.name.includes('\\')||entry.name.startsWith('/'))throw Error('PATH');
  const info=await lstat(join(base,entry.name));if(!info.isFile()||info.isSymbolicLink())throw Error('FILE');
  let bytes=await readFile(join(base,entry.name));if(bytes.length!==entry.size||hash(bytes)!==entry.sha256)throw Error('BYTES');
  if(Object.hasOwn(replacements,entry.name)){const source=await lstat(join(repo,entry.name));if(!source.isFile()||source.isSymbolicLink())throw Error('SOURCE');bytes=await readFile(join(repo,entry.name));if(hash(bytes)!==replacements[entry.name]||hash(bytes)===entry.sha256)throw Error('REPLACEMENT');}
  files.push({name:entry.name,bytes});
 }
 if(Object.keys(replacements).some(k=>files.filter(f=>f.name===k).length!==1))throw Error('MISSING');
 await mkdir(stage,{recursive:false});for(const entry of files){const path=join(stage,entry.name);await mkdir(resolve(path,'..'),{recursive:true});await writeFile(path,entry.bytes,{flag:'wx'});}
 const result=await assembleFullApp(output,stage),after=JSON.parse(await readFile(join(output,'source-content-manifest.json'),'utf8'));
 const differences=after.files.filter(f=>manifest.files.find(old=>old.name===f.name)?.sha256!==f.sha256).map(f=>f.name).sort();
 if(result.fileCount!==475||JSON.stringify(differences)!==JSON.stringify(Object.keys(replacements).sort()))throw Error('DIFFERENCES');
 after.sourceComposition='FROZEN_V20_PLUS_EXACT_OCTOBER16_META_1230_REPEAT_OCCURRENCE';after.currentWorkspaceFullyCaptured=false;
 await writeFile(join(output,'source-content-manifest.json'),JSON.stringify(after,null,2)+'\n');
 return {...result,differences,secretsIncluded:false,baseSourceSha256:manifest.sourceContentSha256};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))assembleOctober16RepeatCandidate(JSON.parse(process.argv[2])).then(x=>process.stdout.write(JSON.stringify(x))).catch(()=>{process.stdout.write(JSON.stringify({state:'PHASE08_OCTOBER16_CANDIDATE_FAILED',remoteChanges:0}));process.exitCode=1;});
