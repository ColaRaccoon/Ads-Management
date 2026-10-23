import {spawnSync} from 'node:child_process';
try{
 let wire='';for await(const c of process.stdin){wire+=c;if(wire.length>1048576)throw Error();}const input=JSON.parse(wire);wire='';
 const code="let x='';process.stdin.on('data',c=>x+=c);process.stdin.on('end',()=>{try{const e=JSON.parse(x);const c=require('/srv/app/apps/api/dist/common/http-security.config.js').loadHttpSecurityConfig(e);process.stdout.write(JSON.stringify({fingerprint:c.runtimeConfigFingerprint}));}catch{process.exitCode=1;}});";
 const image=input.imageTag??'meta-ads-incident:20261019-v1';if(!['meta-ads-incident:20261019-v1','meta-ads-incident:20261019-v2'].includes(image))throw Error();
 const r=spawnSync('docker',['run','--rm','--network','none','--memory','1g','--cpus','1','--read-only','--interactive',image,'node','-e',code],{input:JSON.stringify(input.env),encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:4096});
 if(r.status!==0)throw Error();const parsed=JSON.parse(r.stdout);if(!/^[a-f0-9]{64}$/.test(parsed.fingerprint))throw Error();process.stdout.write(JSON.stringify(parsed));
}catch{process.stderr.write('INCIDENT_FINGERPRINT_REJECTED');process.exitCode=1;}
