import{pathToFileURL}from'node:url';import{ISOLATED_IDENTITY}from'./deployment-evidence.mjs';import{reviewedV20LogProfile,V20_LOG_SOURCE_SHA}from'./relay-log-v20-profile.mjs';
export const V21_LOG_SOURCE_SHA='f7592804a9763eb228d7c97be00479431700e78b7c57e4544b4c6a863556e4df';
export const REVIEWED_V21_DEPLOYMENTS=Object.freeze(['5b6caf98-f569-4c6e-9086-2401cae2dd7b']);
export function reviewedV21LogProfile(input){
 if(input?.sourceSha!==V21_LOG_SOURCE_SHA)return reviewedV20LogProfile(input);
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join()!=='deploymentId,identity,sourceSha'||!REVIEWED_V21_DEPLOYMENTS.includes(input.deploymentId)||!input.identity||Array.isArray(input.identity)||Object.keys(input.identity).sort().join()!==Object.keys(ISOLATED_IDENTITY).sort().join()||!Object.entries(ISOLATED_IDENTITY).every(([k,v])=>input.identity[k]===v))throw Error('REVIEWED_LOG_PROFILE_REJECTED');
 const old=reviewedV20LogProfile({sourceSha:V20_LOG_SOURCE_SHA,deploymentId:'defd778f-8b6c-4e76-9555-5693a856099b',identity:input.identity}),deployments=[...old.deployments,...REVIEWED_V21_DEPLOYMENTS];
 if(deployments.length>21||new Set(deployments).size!==deployments.length||!deployments.includes(input.deploymentId))throw Error('REVIEWED_LOG_PROFILE_REJECTED');
 return{state:'PHASE08_REVIEWED_LOG_PROFILE_PREPARED',sourceSha:input.sourceSha,currentDeploymentId:input.deploymentId,deployments,totalDeployments:deployments.length,remoteCalls:0};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){let raw='';try{for await(const p of process.stdin){raw+=p;if(Buffer.byteLength(raw)>16384)throw Error('BOUND');}const input=JSON.parse(raw);raw='';process.stdout.write(JSON.stringify(reviewedV21LogProfile(input)));}catch{process.stdout.write(JSON.stringify({state:'PHASE08_REVIEWED_LOG_PROFILE_REJECTED',rawErrorSuppressed:true,remoteCalls:0}));process.exitCode=1;}finally{raw='';}}
