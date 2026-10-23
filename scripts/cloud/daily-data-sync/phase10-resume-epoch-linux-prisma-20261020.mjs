// No container is started. Only public generated Prisma files from two built images.
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,readdirSync,mkdirSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
const E='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation',out=E+'/cafe-epoch-linux-20261020-v1';
const sha=v=>createHash('sha256').update(v).digest('hex'),read=p=>JSON.parse(readFileSync(p,'utf8'));
const a=read(E+'/portable-build-20261020-v2/result.json'),b=read(E+'/portable-build-20261020-v3/result.json');
assert.equal(a.release,'d7e9d2001f94f45a0e731a209f5d17415513bb08');assert.equal(b.release,'a49bec345f995ec71f25f9e569caa5fe20578235');
mkdirSync(out,{recursive:false});
const docker=args=>execFileSync('docker',args,{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe'],maxBuffer:1048576}).trim();
const rows=[];
try{
 for(const [label,build]of [['c6',a],['c7',b]]){
  assert.equal(docker(['image','inspect',build.image.id,'--format','{{index .Config.Labels "org.opencontainers.image.revision"}}']),build.release);
  const name='phase10-linux-prisma-'+randomUUID(),owner=randomUUID();let created=false;
  try{docker(['create','--name',name,'--label','phase10.prisma.owner='+owner,'--network','none','--read-only',build.image.id]);created=true;assert.equal(docker(['inspect','--format','{{.State.Running}}',name]),'false');docker(['cp',name+':/srv/app/node_modules/.prisma/client',out+'/'+label]);}
  finally{if(created){assert.equal(docker(['inspect','--format','{{index .Config.Labels "phase10.prisma.owner"}}',name]),owner);docker(['rm',name]);}}
 }
 function inventory(root,prefix=''){const result=[];for(const e of readdirSync(root,{withFileTypes:true})){assert(!e.isSymbolicLink());if(e.isDirectory())result.push(...inventory(root+'/'+e.name,prefix+e.name+'/'));else{assert(e.isFile());result.push(prefix+e.name);}}return result.sort();}
 const names=inventory(out+'/c6');assert.deepEqual(inventory(out+'/c7'),names);
 const map=', map: "cafe24_epoch_revisions_checkpoint_fkey"';
 function strip(v){assert.equal(v.split(map).length,2);return v.replace(map,'');}
 function property(v,name){const match=v.match(new RegExp('"'+name+'": ("(?:\\\\.|[^"\\\\])*")'));assert(match);return JSON.parse(match[1]);}
 function runtime(v){const m=v.match(/config\.runtimeDataModel = JSON\.parse\(("(?:\\.|[^"\\])*")\)/);assert(m);return JSON.parse(m[1]);}
 function normalized(v){return v.replace(/"inlineSchema": ("(?:\\.|[^"\\])*")/,'"inlineSchema": "MAP_ONLY"').replace(/"inlineSchemaHash": "[a-f0-9]{64}"/,'"inlineSchemaHash": "MAP_ONLY"');}
 let runtimeModelCompared=0,enginesCompared=0;
 for(const name of names){const old=readFileSync(out+'/c6/'+name),next=readFileSync(out+'/c7/'+name),same=old.equals(next),row={name,beforeSha256:sha(old),afterSha256:sha(next),byteIdentical:same};
  if(/(?:\.so\.node|\.wasm|\.dll\.node)$/.test(name)){assert(same,'LINUX_ENGINE_CHANGED');enginesCompared++;}
  if(!same){const before=old.toString('utf8'),after=next.toString('utf8');
   if(name==='schema.prisma'){assert.equal(strip(after),before);row.mapOnly=true;}
   else if(['index.js','edge.js'].includes(name)){assert.equal(normalized(after),normalized(before));assert.equal(strip(property(after,'inlineSchema')),property(before,'inlineSchema'));assert.equal(runtime(after),runtime(before));row.inlineSchemaMapAndHashOnly=true;row.runtimeDataModelByteIdentical=true;runtimeModelCompared++;}
   else if(name==='package.json'){const p=JSON.parse(before),q=JSON.parse(after);assert.equal(p.name,'prisma-client-'+sha(readFileSync(out+'/c6/schema.prisma')));assert.equal(q.name,'prisma-client-'+sha(readFileSync(out+'/c7/schema.prisma')));assert.equal(after.replace(q.name,p.name),before);row.packageNameDerivedFromSchemaSha256=true;}
   else throw Error('UNEXPECTED_LINUX_GENERATED_DIFF');
  }rows.push(row);
 }
 assert.equal(rows.filter(v=>!v.byteIdentical).length,4);assert.equal(runtimeModelCompared,2);assert(enginesCompared>=1);
 const proof={kind:'C6_C7_ACTUAL_LINUX_IMAGE_PRISMA_MAP_ONLY_DIFF',status:'PASS',at:new Date().toISOString(),beforeImage:a.image.id,afterImage:b.image.id,beforeRelease:a.release,afterRelease:b.release,files:rows,changedFiles:rows.filter(v=>!v.byteIdentical).map(v=>v.name),linuxEngineFilesByteIdentical:enginesCompared,runtimeDataModelByteIdentical:true,sourceMapOnly:true,containerStarts:0,applicationRequests:0,databaseRequests:0,providerRequests:0,credentialsInjected:0};
 writeFileSync(out+'/result.json',JSON.stringify(proof,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({status:'PASS',files:rows.length,linuxEngineFilesByteIdentical:enginesCompared,changedFiles:proof.changedFiles}));
}catch{writeFileSync(out+'/failure.json',JSON.stringify({kind:'C6_C7_LINUX_PRISMA_SAFE_FAILURE',status:'FAIL',filesCompared:rows.length,rawErrorSuppressed:true,containerStarts:0,providerRequests:0},null,2)+'\n',{flag:'wx'});console.log('LINUX_PRISMA_COMPARISON_FAILED; retained public evidence');process.exitCode=1;}
