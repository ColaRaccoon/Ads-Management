import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {join} from 'node:path';
const E='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation',candidate=E+'/candidate-20261020-v7',output=E+'/portable-build-20261020-v3';
const ev=JSON.parse(await readFile(E+'/evidence/candidate-20261020-v7.json','utf8'));
const release=ev.commit,source=ev.sourceContentSha256,tag='meta-ads-phase10:20261020-v7-portable';
const nodeImage='node:22.18.0-bookworm-slim@sha256:0d130e2ee18e88e1561375276daced6bff032539200173f2daf48c2e33f38ff5';
const hash=b=>createHash('sha256').update(b).digest('hex');
const git=(...a)=>execFileSync('git',a,{cwd:candidate,encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}).trim();
const manifest=JSON.parse(await readFile(candidate+'/source-content-manifest.json','utf8'));
async function closure(){
 if(!/^[a-f0-9]{40}$/.test(release)||!/^[a-f0-9]{64}$/.test(source)||manifest.files.length!==495||ev.migrationCount!==52||manifest.sourceContentSha256!==source||hash(JSON.stringify(manifest.files))!==source||git('rev-parse','HEAD')!==release||ev.remoteMigrationApplied!==false||ev.remoteActivation!==false)throw Error('CANDIDATE_IDENTITY');
 for(const f of manifest.files){const b=await readFile(join(candidate,f.name));if(b.length!==f.size||hash(b)!==f.sha256)throw Error('CANDIDATE_BYTES');}
 return {filesMatched:495,source,migrations:52};
}
await mkdir(output,{recursive:false});
const write=(name,value)=>writeFile(join(output,name),JSON.stringify(value,null,2)+'\n',{flag:'wx'});
let code;
try {
 const before=await closure(),dockerfile=await readFile(candidate+'/deploy/Dockerfile');
 if(hash(dockerfile)!==ev.extraProductionDockerfileSha256)throw Error('PRODUCTION_DOCKERFILE_DRIFT');
 await write('plan.json',{kind:'PHASE10_ADDITIVE_EPOCH_PORTABLE_BUILD',at:new Date().toISOString(),release,source,tag,nodeImage,dockerfileSha256:hash(dockerfile),before,buildOnly:true,registryPushes:0,operatingDeployments:0,credentialsInjected:0,providerRequests:0,sharedCredentialChanges:0});
 const logPath=join(output,'build.log'),log=createWriteStream(logPath,{flags:'wx'}),start=performance.now();
 const child=spawn('docker',['build','--platform','linux/amd64','--progress','plain','--build-arg','NODE_IMAGE='+nodeImage,'--build-arg','RELEASE_GIT_SHA='+release,'--file','deploy/Dockerfile','--tag',tag,'.'],{cwd:candidate,windowsHide:true,stdio:['ignore','pipe','pipe']});
 child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});
 code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});await new Promise(resolve=>log.end(resolve));
 const build={exitCode:code,durationSeconds:(performance.now()-start)/1000,logSha256:hash(await readFile(logPath))};await write('build-step.json',build);if(code!==0)throw Error('PORTABLE_BUILD_FAILED');
 const inspect=format=>execFileSync('docker',['image','inspect',tag,'--format',format],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}).trim();
 const image={tag,id:inspect('{{.Id}}'),revision:inspect('{{index .Config.Labels "org.opencontainers.image.revision"}}'),architecture:inspect('{{.Architecture}}'),user:inspect('{{.Config.User}}'),command:JSON.parse(inspect('{{json .Config.Cmd}}'))};
 if(!/^sha256:[a-f0-9]{64}$/.test(image.id)||image.revision!==release||image.architecture!=='amd64'||image.user!=='node'||JSON.stringify(image.command)!==JSON.stringify(['node','deploy/launch-bundle.mjs']))throw Error('PORTABLE_IMAGE_METADATA');
 const after=await closure(),result={kind:'PHASE10_ADDITIVE_EPOCH_PORTABLE_BUILD',status:'PASS_BUILD_ONLY',at:new Date().toISOString(),release,source,nodeImage,image,build,before,after,dockerfileSha256:hash(dockerfile),actualMemoryRehearsal:false,remoteMigrationApplied:false,remoteActivation:false,operatingDeployments:0,registryPushes:0,providerRequests:0,credentialsInjected:0,sharedCredentialChanges:0,stages11And12Started:false};
 await write('result.json',result);console.log(JSON.stringify({kind:result.kind,status:result.status,image,filesMatched:495}));
}catch{
 await write('failure.json',{kind:'PHASE10_ADDITIVE_EPOCH_PORTABLE_SAFE_FAILURE',at:new Date().toISOString(),release,source,buildExitCode:code??null,rawErrorSuppressed:true,operatingDeployments:0});console.log('PORTABLE_BUILD_OR_CLOSURE_FAILED; bounded evidence preserved');process.exitCode=1;
}
