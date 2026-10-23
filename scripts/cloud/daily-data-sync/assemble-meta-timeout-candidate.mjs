// Local public artifact only: frozen v13 plus the reviewed Meta transaction bound.
import {readFile,lstat,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {assembleFullApp} from './assemble-full-app.mjs';
const repo=resolve(fileURLToPath(new URL('../../..',import.meta.url)));
const root='C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation';
const hash=b=>createHash('sha256').update(b).digest('hex');
export async function assembleMetaTimeoutCandidate(foundationSha){
 if(typeof foundationSha!=='string'||!/^[a-f0-9]{64}$/.test(foundationSha))throw Error('INPUT');
 const base=join(root,'full-app-build-20261015-accelerated-v13'),stage=join(root,'full-app-stage-20261015-meta-timeout-v14'),output=join(root,'full-app-build-20261015-meta-timeout-v14');
 const manifest=JSON.parse(await readFile(join(base,'source-content-manifest.json'),'utf8'));
 if(manifest.sourceContentSha256!=='6bf11939a6f7b4c676377c1c679a3a6473d158374072896b4ee15711f36a1fde'||manifest.files.length!==475||manifest.secretsIncluded!==false||hash(JSON.stringify(manifest.files))!==manifest.sourceContentSha256)throw Error('BASE');
 const name='apps/api/src/daily-sync/sync-foundation.service.ts';
 const item=await lstat(join(repo,name));if(!item.isFile()||item.isSymbolicLink())throw Error('SOURCE');
 const replacement=await readFile(join(repo,name));if(hash(replacement)!==foundationSha)throw Error('SOURCE');
 const selected=[];
 for(const entry of manifest.files){
  if(typeof entry.name!=='string'||entry.name.includes('..')||entry.name.includes('\\')||entry.name.startsWith('/'))throw Error('PATH');
  const path=join(base,entry.name),info=await lstat(path);if(!info.isFile()||info.isSymbolicLink())throw Error('FILE');
  const bytes=await readFile(path);if(bytes.length!==entry.size||hash(bytes)!==entry.sha256)throw Error('BYTES');
  selected.push({name:entry.name,bytes:entry.name===name?replacement:bytes});
 }
 if(selected.filter(e=>e.name===name).length!==1)throw Error('SHAPE');
 await mkdir(stage,{recursive:false});
 for(const entry of selected){const path=join(stage,entry.name);await mkdir(resolve(path,'..'),{recursive:true});await writeFile(path,entry.bytes,{flag:'wx'});}
 const result=await assembleFullApp(output,stage),after=JSON.parse(await readFile(join(output,'source-content-manifest.json'),'utf8'));
 const differences=after.files.filter(e=>manifest.files.find(b=>b.name===e.name)?.sha256!==e.sha256).map(e=>e.name);
 if(result.fileCount!==475||JSON.stringify(differences)!==JSON.stringify([name]))throw Error('DIFFERENCES');
 after.sourceComposition='FROZEN_V13_PLUS_REVIEWED_BOUNDED_META_PUBLICATION_TRANSACTION';after.currentWorkspaceFullyCaptured=false;
 await writeFile(join(output,'source-content-manifest.json'),JSON.stringify(after,null,2)+'\n');
 return {...result,differences,secretsIncluded:false,baseSourceSha256:manifest.sourceContentSha256};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))assembleMetaTimeoutCandidate(process.argv[2]).then(x=>process.stdout.write(JSON.stringify(x))).catch(()=>{process.stdout.write(JSON.stringify({state:'PHASE08_META_TIMEOUT_CANDIDATE_FAILED',remoteChanges:0}));process.exitCode=1;});
