// Local-only frozen v12 plus the independently reviewed fixed test occurrence guard.
import {readFile,lstat,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {assembleFullApp} from './assemble-full-app.mjs';
const repo=resolve(fileURLToPath(new URL('../../..',import.meta.url)));
const root='C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation';
const hash=b=>createHash('sha256').update(b).digest('hex');
export async function assembleAcceleratedCandidate(guardSha,activationSha){
 if([guardSha,activationSha].some(x=>typeof x!=='string'||!/^[a-f0-9]{64}$/.test(x)))throw Error('INPUT');
 const base=join(root,'full-app-build-20261015-meta-v12'),stage=join(root,'full-app-stage-20261015-accelerated-v13'),output=join(root,'full-app-build-20261015-accelerated-v13');
 const manifest=JSON.parse(await readFile(join(base,'source-content-manifest.json'),'utf8'));
 if(manifest.sourceContentSha256!=='d1f04a19272fc58b0ebd344cbfdd4ce660cb8e553a519968f42e9d81da4eff21'||manifest.files.length!==475||manifest.secretsIncluded!==false||hash(JSON.stringify(manifest.files))!==manifest.sourceContentSha256)throw Error('BASE');
 const guard='apps/api/src/daily-sync/scheduled-occurrence.ts',activation='apps/api/src/daily-sync/cafe24-scheduled-activation.ts',replacements=new Map();
 for(const [name,sha]of [[guard,guardSha],[activation,activationSha]]){
  const info=await lstat(join(repo,name));if(!info.isFile()||info.isSymbolicLink())throw Error('SOURCE');
  const bytes=await readFile(join(repo,name));if(hash(bytes)!==sha)throw Error('SOURCE');replacements.set(name,bytes);
 }
 const selected=[];
 for(const entry of manifest.files){
  if(typeof entry.name!=='string'||entry.name.includes('..')||entry.name.includes('\\')||entry.name.startsWith('/'))throw Error('PATH');
  const path=join(base,entry.name),item=await lstat(path);if(!item.isFile()||item.isSymbolicLink())throw Error('FILE');
  const bytes=await readFile(path);if(bytes.length!==entry.size||hash(bytes)!==entry.sha256)throw Error('BYTES');
  selected.push({name:entry.name,bytes:replacements.get(entry.name)??bytes});
 }
 if([...replacements.keys()].some(name=>selected.filter(x=>x.name===name).length!==1))throw Error('SHAPE');
 await mkdir(stage,{recursive:false});
 for(const entry of selected){const path=join(stage,entry.name);await mkdir(resolve(path,'..'),{recursive:true});await writeFile(path,entry.bytes,{flag:'wx'});}
 const result=await assembleFullApp(output,stage),after=JSON.parse(await readFile(join(output,'source-content-manifest.json'),'utf8'));
 const differences=after.files.filter(e=>manifest.files.find(b=>b.name===e.name)?.sha256!==e.sha256).map(e=>e.name);
 if(result.fileCount!==475||JSON.stringify(differences.sort())!==JSON.stringify([guard,activation].sort()))throw Error('DIFFERENCES');
 after.sourceComposition='FROZEN_V12_PLUS_REVIEWED_TEST_GUARD_AND_CAFE_REPLAY_ACTIVATION';after.currentWorkspaceFullyCaptured=false;
 await writeFile(join(output,'source-content-manifest.json'),JSON.stringify(after,null,2)+'\n');
 return {...result,differences,secretsIncluded:false,baseSourceSha256:manifest.sourceContentSha256};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))assembleAcceleratedCandidate(process.argv[2],process.argv[3]).then(x=>process.stdout.write(JSON.stringify(x))).catch(()=>{process.stdout.write(JSON.stringify({state:'PHASE08_ACCELERATED_CANDIDATE_FAILED',remoteChanges:0}));process.exitCode=1;});
