// Local-only successor: exactly one reviewed Cafe writer over the frozen v9 app.
import {readFile,lstat,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {assembleFullApp} from './assemble-full-app.mjs';
const repo=resolve(fileURLToPath(new URL('../../..',import.meta.url)));
const root='C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation';
const hash=b=>createHash('sha256').update(b).digest('hex');
export async function assembleCafeBatchCandidate(expectedWriterSha){
 if(!/^[a-f0-9]{64}$/.test(expectedWriterSha??''))throw Error('CAFE_CANDIDATE_INPUT');
 const base=join(root,'full-app-build-20261015-v9'),stage=join(root,'full-app-stage-20261015-cafe-v10'),output=join(root,'full-app-build-20261015-cafe-v10');
 const manifest=JSON.parse(await readFile(join(base,'source-content-manifest.json'),'utf8'));
 if(manifest.sourceContentSha256!=='a986132a8f70757ca67ae93b54ce378926166da30ec9817378f206062e214097'||manifest.files.length!==472||manifest.secretsIncluded!==false||hash(JSON.stringify(manifest.files))!==manifest.sourceContentSha256)throw Error('CAFE_CANDIDATE_BASE');
 const target='apps/api/src/daily-sync/cafe24-canonical-writer.service.ts',changed=await readFile(join(repo,target));
 if(hash(changed)!==expectedWriterSha)throw Error('CAFE_CANDIDATE_WRITER');
 const selected=[];
 for(const entry of manifest.files){
  if(typeof entry.name!=='string'||entry.name.includes('..')||entry.name.includes('\\')||resolve(base,entry.name).toLowerCase().startsWith(resolve(base).toLowerCase()+'/')===false&&resolve(base,entry.name).toLowerCase().startsWith(resolve(base).toLowerCase()+'\\')===false)throw Error('CAFE_CANDIDATE_PATH');
  const path=join(base,entry.name),info=await lstat(path);if(!info.isFile()||info.isSymbolicLink())throw Error('CAFE_CANDIDATE_FILE');
  const bytes=await readFile(path);if(bytes.length!==entry.size||hash(bytes)!==entry.sha256)throw Error('CAFE_CANDIDATE_BYTES');
  selected.push({name:entry.name,bytes:entry.name===target?changed:bytes});
 }
 await mkdir(stage,{recursive:false});
 for(const entry of selected){const path=join(stage,entry.name);await mkdir(resolve(path,'..'),{recursive:true});await writeFile(path,entry.bytes,{flag:'wx'});}
 const result=await assembleFullApp(output,stage),after=JSON.parse(await readFile(join(output,'source-content-manifest.json'),'utf8'));
 const differences=after.files.filter(e=>manifest.files.find(b=>b.name===e.name)?.sha256!==e.sha256).map(e=>e.name);
 if(result.fileCount!==472||differences.length!==1||differences[0]!==target)throw Error('CAFE_CANDIDATE_DIFFERENCE');
 after.sourceComposition='FROZEN_V9_PLUS_REVIEWED_CAFE_WRITER';
 after.currentWorkspaceFullyCaptured=false;
 await writeFile(join(output,'source-content-manifest.json'),JSON.stringify(after,null,2)+'\n');
 return {...result,writerSha256:expectedWriterSha,differences,secretsIncluded:false,baseSourceSha256:manifest.sourceContentSha256};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))assembleCafeBatchCandidate(process.argv[2]).then(x=>process.stdout.write(JSON.stringify(x))).catch(()=>{process.stdout.write(JSON.stringify({state:'PHASE08_CAFE_CANDIDATE_FAILED',remoteChanges:0}));process.exitCode=1;});
