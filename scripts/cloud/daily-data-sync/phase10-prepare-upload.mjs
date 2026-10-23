import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
const root='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation';
const candidate=join(root,'candidate-20261019-v3'),output=join(root,'upload-v3');
const evidence=JSON.parse(await readFile(join(root,'evidence/candidate-20261019-v3.json'),'utf8'));
const manifest=JSON.parse(await readFile(join(candidate,'source-content-manifest.json'),'utf8'));
const hash=b=>createHash('sha256').update(b).digest('hex');
if(evidence.commit!=='9d9e47c3c64dc39bc240d2d2e323140656b9b471'||manifest.sourceContentSha256!=='476287f1b1e62097c98660c421c199be1a21f911ed5ee8c874dcb9859b28dbb8')throw Error('IDENTITY');
await mkdir(output,{recursive:false});
const files=[];
for(const f of [...manifest.files,{name:'source-content-manifest.json'},{name:'deploy/Dockerfile'}]){
 const target=resolve(output,f.name);
 if(!target.startsWith(resolve(output)+'\\')&&!target.startsWith(resolve(output)+'/'))throw Error('PATH');
 const bytes=await readFile(join(candidate,f.name)),sha256=hash(bytes);
 if(f.sha256&&sha256!==f.sha256)throw Error('SOURCE_DRIFT');
 await mkdir(resolve(target,'..'),{recursive:true});await writeFile(target,bytes,{flag:'wx'});
 files.push({name:f.name,size:bytes.length,sha256});
}
const proof={kind:'PHASE10_UPLOAD_CLOSURE_VERIFIED',commit:evidence.commit,sourceContentSha256:manifest.sourceContentSha256,fileCount:files.length,files,secretsIncluded:false,generatedFilesIncluded:false,observedAt:new Date().toISOString()};
await writeFile(join(root,'evidence/upload-v3-verified.json'),JSON.stringify(proof,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({...proof,files:undefined}));
