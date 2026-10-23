import{pathToFileURL}from'node:url';import{ISOLATED_IDENTITY}from'./deployment-evidence.mjs';import{reviewedV15October15LogProfile,V15_LOG_SOURCE_SHA}from'./relay-log-v15-profile.mjs';
export const V18_LOG_SOURCE_SHA='f1b78cdbdb2a7bd7c6c86da5891c8725181297c4f1b431893bb44042d4ff9b09';
export const REVIEWED_V18_DEPLOYMENTS=Object.freeze(['af7a6921-3307-4cf0-9f17-053c21ce3ff4']);
export function reviewedV18LogProfile(input){
 if(input?.sourceSha!==V18_LOG_SOURCE_SHA)return reviewedV15October15LogProfile(input);
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join()!=='deploymentId,identity,sourceSha'||!REVIEWED_V18_DEPLOYMENTS.includes(input.deploymentId)||!input.identity||Array.isArray(input.identity)||Object.keys(input.identity).sort().join()!==Object.keys(ISOLATED_IDENTITY).sort().join()||!Object.entries(ISOLATED_IDENTITY).every(([k,v])=>input.identity[k]===v))throw Error('REVIEWED_LOG_PROFILE_REJECTED');
 const old=reviewedV15October15LogProfile({sourceSha:V15_LOG_SOURCE_SHA,deploymentId:'75138a65-d274-4858-a49b-64ac811adff3',identity:input.identity});const deployments=[...old.deployments,...REVIEWED_V18_DEPLOYMENTS];
 if(deployments.length>16||new Set(deployments).size!==deployments.length||!deployments.includes(input.deploymentId))throw Error('REVIEWED_LOG_PROFILE_REJECTED');
 return{state:'PHASE08_REVIEWED_LOG_PROFILE_PREPARED',sourceSha:input.sourceSha,currentDeploymentId:input.deploymentId,deployments,totalDeployments:deployments.length,remoteCalls:0};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){let raw='';try{for await(const p of process.stdin){raw+=p;if(Buffer.byteLength(raw)>16384)throw Error('BOUND');}const input=JSON.parse(raw);raw='';process.stdout.write(JSON.stringify(reviewedV18LogProfile(input)));}catch{process.stdout.write(JSON.stringify({state:'PHASE08_REVIEWED_LOG_PROFILE_REJECTED',rawErrorSuppressed:true,remoteCalls:0}));process.exitCode=1;}finally{raw='';}}
