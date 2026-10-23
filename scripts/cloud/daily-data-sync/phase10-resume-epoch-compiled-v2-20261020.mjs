import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,readdirSync,existsSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
const root='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/portable-build-20261020-v3';
const b=JSON.parse(readFileSync(root+'/result.json','utf8'));
assert.equal(b.status,'PASS_BUILD_ONLY');assert.equal(b.image.revision,b.release);
assert(!existsSync(root+'/api-dist'));assert(!existsSync(root+'/compiled-proof.json'));
const sha=v=>createHash('sha256').update(v).digest('hex');
const cmd=args=>execFileSync('docker',args,{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}).trim();
assert.equal(cmd(['image','inspect',b.image.id,'--format','{{index .Config.Labels "org.opencontainers.image.revision"}}']),b.release);
const name='phase10-c7-compiled-'+randomUUID(),owner=randomUUID();let created=false;
try{
 cmd(['create','--name',name,'--label','phase10.compiled.owner='+owner,'--network','none',b.image.id]);created=true;
 assert.equal(cmd(['inspect','--format','{{index .Config.Labels "phase10.compiled.owner"}}',name]),owner);
 assert.equal(cmd(['inspect','--format','{{.State.Running}}',name]),'false');
 cmd(['cp',name+':/srv/app/apps/api/dist',root+'/api-dist']);
 const files=[];function walk(dir){for(const e of readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,e.name);if(e.isSymbolicLink())throw Error('COMPILED_REPARSE');if(e.isDirectory())walk(file);else{const v=readFileSync(file);files.push({name:path.relative(root+'/api-dist',file).replaceAll('\\','/'),bytes:v.length,sha256:sha(v)});}}}walk(root+'/api-dist');files.sort((a,c)=>a.name.localeCompare(c.name));
 assert(files.some(f=>f.name==='daily-sync/cafe24-observation-epoch.js'));
 const proof={kind:'C7_COMPILED_API_FROM_IMMUTABLE_IMAGE',at:new Date().toISOString(),status:'PASS',release:b.release,source:b.source,image:b.image.id,files,compiledTreeSha256:sha(JSON.stringify(files)),containerStarted:false,applicationRequests:0,providerRequests:0,credentialsRead:0,remoteChanges:0};
 writeFileSync(root+'/compiled-proof.json',JSON.stringify(proof,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({status:'PASS',release:b.release,image:b.image.id,compiledFiles:files.length,compiledTreeSha256:proof.compiledTreeSha256}));
}finally{if(created){assert.equal(cmd(['inspect','--format','{{index .Config.Labels "phase10.compiled.owner"}}',name]),owner);cmd(['rm',name]);}}
