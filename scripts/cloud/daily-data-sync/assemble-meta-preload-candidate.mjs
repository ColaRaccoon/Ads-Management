// Local-only: frozen v11 plus exactly the independently reviewed Meta preload pair.
import {readFile,lstat,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {assembleFullApp} from './assemble-full-app.mjs';
const repo=resolve(fileURLToPath(new URL('../../..',import.meta.url)));
const root='C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation';
const hash=b=>createHash('sha256').update(b).digest('hex');
export async function assembleMetaPreloadCandidate(batchSha,preloadSha){
 if([batchSha,preloadSha].some(x=>! /^(?:[a-f0-9]{64})$/.test(x??'')))throw Error('INPUT');
 const base=join(root,'full-app-build-20261015-v11'),stage=join(root,'full-app-stage-20261015-meta-v12'),output=join(root,'full-app-build-20261015-meta-v12');
 const manifest=JSON.parse(await readFile(join(base,'source-content-manifest.json'),'utf8'));
 if(manifest.sourceContentSha256!=='0368163a964e94086ef77ca644a6bf3d0be2ec6cfe12523cb136ec5ac02cd9fa'||manifest.files.length!==474||manifest.secretsIncluded!==false||hash(JSON.stringify(manifest.files))!==manifest.sourceContentSha256)throw Error('BASE');
 const batch='apps/api/src/daily-sync/meta-day-batch.ts',preload='apps/api/src/daily-sync/meta-day-preload.ts',replacement=new Map();
 for(const [name,expected]of [[batch,batchSha],[preload,preloadSha]]){const info=await lstat(join(repo,name));if(!info.isFile()||info.isSymbolicLink())throw Error('SOURCE');const bytes=await readFile(join(repo,name));if(hash(bytes)!==expected)throw Error('SOURCE');replacement.set(name,bytes);}
 const selected=[];
 for(const entry of manifest.files){
  if(typeof entry.name!=='string'||entry.name.includes('..')||entry.name.includes('\\')||entry.name.startsWith('/'))throw Error('PATH');
  const path=join(base,entry.name),info=await lstat(path);if(!info.isFile()||info.isSymbolicLink())throw Error('FILE');
  const bytes=await readFile(path);if(bytes.length!==entry.size||hash(bytes)!==entry.sha256)throw Error('BYTES');
  selected.push({name:entry.name,bytes:replacement.get(entry.name)??bytes});
 }
 if(selected.filter(x=>x.name===batch).length!==1||selected.some(x=>x.name===preload))throw Error('BASE_SHAPE');
 selected.push({name:preload,bytes:replacement.get(preload)});
 await mkdir(stage,{recursive:false});
 for(const entry of selected){const path=join(stage,entry.name);await mkdir(resolve(path,'..'),{recursive:true});await writeFile(path,entry.bytes,{flag:'wx'});}
 const result=await assembleFullApp(output,stage),after=JSON.parse(await readFile(join(output,'source-content-manifest.json'),'utf8'));
 const differences=after.files.filter(e=>manifest.files.find(b=>b.name===e.name)?.sha256!==e.sha256).map(e=>e.name).sort();
 if(result.fileCount!==475||JSON.stringify(differences)!==JSON.stringify([batch,preload].sort())||after.files.some(e=>e.name==='apps/api/src/daily-sync/cafe24-canonical-writer.service.ts'&&e.sha256!==manifest.files.find(b=>b.name===e.name)?.sha256))throw Error('DIFFERENCES');
 after.sourceComposition='FROZEN_V11_PLUS_REVIEWED_META_PRELOAD_PAIR';after.currentWorkspaceFullyCaptured=false;
 await writeFile(join(output,'source-content-manifest.json'),JSON.stringify(after,null,2)+'\n');
 return {...result,differences,secretsIncluded:false,baseSourceSha256:manifest.sourceContentSha256};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))assembleMetaPreloadCandidate(process.argv[2],process.argv[3]).then(x=>process.stdout.write(JSON.stringify(x))).catch(()=>{process.stdout.write(JSON.stringify({state:'PHASE08_META_PRELOAD_CANDIDATE_FAILED',remoteChanges:0}));process.exitCode=1;});
