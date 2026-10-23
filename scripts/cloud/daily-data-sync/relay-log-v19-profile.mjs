import{pathToFileURL}from'node:url';import{ISOLATED_IDENTITY}from'./deployment-evidence.mjs';import{reviewedV18LogProfile,V18_LOG_SOURCE_SHA}from'./relay-log-v18-profile.mjs';
export const V19_LOG_SOURCE_SHA='898bb25b5cc3fca6437d8a284b11e71045cb6e74e073acb848affa0498ae58d9';
export const REVIEWED_V18_N20_DEPLOYMENT='905cce5f-4fdc-4f19-99b1-ec5aaa2b6f62';
export const REVIEWED_V19_DEPLOYMENTS=Object.freeze(['aac4ad45-b0ab-4106-a88a-c50ae7151423','5f6c56de-47a1-4f34-9194-c7ea1f42a8c6']);
export function reviewedV19LogProfile(input){
 const n20=input?.sourceSha===V18_LOG_SOURCE_SHA&&input?.deploymentId===REVIEWED_V18_N20_DEPLOYMENT;
 if(!n20&&input?.sourceSha!==V19_LOG_SOURCE_SHA)return reviewedV18LogProfile(input);
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join()!=='deploymentId,identity,sourceSha'||(!n20&&!REVIEWED_V19_DEPLOYMENTS.includes(input.deploymentId))||!input.identity||Array.isArray(input.identity)||Object.keys(input.identity).sort().join()!==Object.keys(ISOLATED_IDENTITY).sort().join()||!Object.entries(ISOLATED_IDENTITY).every(([k,v])=>input.identity[k]===v))throw Error('REVIEWED_LOG_PROFILE_REJECTED');
 const old=reviewedV18LogProfile({sourceSha:V18_LOG_SOURCE_SHA,deploymentId:'af7a6921-3307-4cf0-9f17-053c21ce3ff4',identity:input.identity});
 const deployments=[...old.deployments,REVIEWED_V18_N20_DEPLOYMENT,...(n20?[]:REVIEWED_V19_DEPLOYMENTS)];
 if(deployments.length>18||new Set(deployments).size!==deployments.length||!deployments.includes(input.deploymentId))throw Error('REVIEWED_LOG_PROFILE_REJECTED');
 return{state:'PHASE08_REVIEWED_LOG_PROFILE_PREPARED',sourceSha:input.sourceSha,currentDeploymentId:input.deploymentId,deployments,totalDeployments:deployments.length,remoteCalls:0};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){let raw='';try{for await(const p of process.stdin){raw+=p;if(Buffer.byteLength(raw)>16384)throw Error('BOUND');}const input=JSON.parse(raw);raw='';process.stdout.write(JSON.stringify(reviewedV19LogProfile(input)));}catch{process.stdout.write(JSON.stringify({state:'PHASE08_REVIEWED_LOG_PROFILE_REJECTED',rawErrorSuppressed:true,remoteCalls:0}));process.exitCode=1;}finally{raw='';}}
