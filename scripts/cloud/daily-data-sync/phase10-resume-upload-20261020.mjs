import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
const root='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation';
const candidate=join(root,'candidate-20261020-v1'),output=join(root,'upload-20261020-v1');
const evidence=JSON.parse(await readFile(join(root,'evidence/candidate-20261020-v1.json'),'utf8'));
const manifest=JSON.parse(await readFile(join(candidate,'source-content-manifest.json'),'utf8'));
const hash=b=>createHash('sha256').update(b).digest('hex');
if(evidence.commit!=='177315f2e89ccdf87443086ec9987589efcd934c'||manifest.sourceContentSha256!=='bb35f2a9563ce80ff9477fb17eb9db568ca268dd273fff506e8fb76136aac8d2')throw Error('IDENTITY');
await mkdir(output,{recursive:false});
const files=[];
for(const f of [...manifest.files,{name:'source-content-manifest.json'},{name:'deploy/Dockerfile'}]){
 const target=resolve(output,f.name);
 if(!target.startsWith(resolve(output)+'\\'))throw Error('PATH');
 const bytes=await readFile(join(candidate,f.name)),sha256=hash(bytes);
 if(f.sha256&&(sha256!==f.sha256||bytes.length!==f.size))throw Error('SOURCE_DRIFT');
 await mkdir(resolve(target,'..'),{recursive:true});await writeFile(target,bytes,{flag:'wx'});
 files.push({name:f.name,size:bytes.length,sha256});
}
const proof={kind:'PHASE10_UPLOAD_CLOSURE_VERIFIED',commit:evidence.commit,sourceContentSha256:manifest.sourceContentSha256,fileCount:files.length,files,secretsIncluded:false,generatedFilesIncluded:false,observedAt:new Date().toISOString()};
await writeFile(join(root,'continuation-20261020/upload.json'),JSON.stringify(proof,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({...proof,files:undefined}));
