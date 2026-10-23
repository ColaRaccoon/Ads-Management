import{pathToFileURL}from'node:url';import{ISOLATED_IDENTITY}from'./deployment-evidence.mjs';import{reviewedV19LogProfile,V19_LOG_SOURCE_SHA}from'./relay-log-v19-profile.mjs';
export const V20_LOG_SOURCE_SHA='81b8ba86b22f2019227433f9e0f87ced95d97a44b44ba69d494eec0d664ce537';
export const REVIEWED_V20_DEPLOYMENTS=Object.freeze(['764d2415-e761-4388-b6fe-4e590c630293','defd778f-8b6c-4e76-9555-5693a856099b']);
export function reviewedV20LogProfile(input){
 if(input?.sourceSha!==V20_LOG_SOURCE_SHA)return reviewedV19LogProfile(input);
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join()!=='deploymentId,identity,sourceSha'||!REVIEWED_V20_DEPLOYMENTS.includes(input.deploymentId)||!input.identity||Array.isArray(input.identity)||Object.keys(input.identity).sort().join()!==Object.keys(ISOLATED_IDENTITY).sort().join()||!Object.entries(ISOLATED_IDENTITY).every(([k,v])=>input.identity[k]===v))throw Error('REVIEWED_LOG_PROFILE_REJECTED');
 const old=reviewedV19LogProfile({sourceSha:V19_LOG_SOURCE_SHA,deploymentId:'5f6c56de-47a1-4f34-9194-c7ea1f42a8c6',identity:input.identity}),deployments=[...old.deployments,...REVIEWED_V20_DEPLOYMENTS];
 if(deployments.length>20||new Set(deployments).size!==deployments.length||!deployments.includes(input.deploymentId))throw Error('REVIEWED_LOG_PROFILE_REJECTED');
 return{state:'PHASE08_REVIEWED_LOG_PROFILE_PREPARED',sourceSha:input.sourceSha,currentDeploymentId:input.deploymentId,deployments,totalDeployments:deployments.length,remoteCalls:0};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){let raw='';try{for await(const p of process.stdin){raw+=p;if(Buffer.byteLength(raw)>16384)throw Error('BOUND');}const input=JSON.parse(raw);raw='';process.stdout.write(JSON.stringify(reviewedV20LogProfile(input)));}catch{process.stdout.write(JSON.stringify({state:'PHASE08_REVIEWED_LOG_PROFILE_REJECTED',rawErrorSuppressed:true,remoteCalls:0}));process.exitCode=1;}finally{raw='';}}
