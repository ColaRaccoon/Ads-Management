import{pathToFileURL}from'node:url';import{ISOLATED_IDENTITY}from'./deployment-evidence.mjs';import{reviewedV21LogProfile,V21_LOG_SOURCE_SHA}from'./relay-log-v21-profile.mjs';
export const V22_LOG_SOURCE_SHA='0f790d901c949fc456dce6ab863b4bccca10a212b7c7b75afb03f52a0979fdc1';
export const REVIEWED_V22_DEPLOYMENTS=Object.freeze(['25e68a9b-04f6-4329-b6bd-b5a3391fb01c','3ccd3843-a15f-4655-a937-c190779ce769']);
export function reviewedV22LogProfile(input){
 if(input?.sourceSha!==V22_LOG_SOURCE_SHA)return reviewedV21LogProfile(input);
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join()!=='deploymentId,identity,sourceSha'||!REVIEWED_V22_DEPLOYMENTS.includes(input.deploymentId)||!input.identity||Array.isArray(input.identity)||Object.keys(input.identity).sort().join()!==Object.keys(ISOLATED_IDENTITY).sort().join()||!Object.entries(ISOLATED_IDENTITY).every(([k,v])=>input.identity[k]===v))throw Error('REVIEWED_LOG_PROFILE_REJECTED');
 const old=reviewedV21LogProfile({sourceSha:V21_LOG_SOURCE_SHA,deploymentId:'5b6caf98-f569-4c6e-9086-2401cae2dd7b',identity:input.identity}),deployments=[...old.deployments,...REVIEWED_V22_DEPLOYMENTS];
 if(deployments.length>22||new Set(deployments).size!==deployments.length||!deployments.includes(input.deploymentId))throw Error('REVIEWED_LOG_PROFILE_REJECTED');
 return{state:'PHASE08_REVIEWED_LOG_PROFILE_PREPARED',sourceSha:input.sourceSha,currentDeploymentId:input.deploymentId,deployments,totalDeployments:deployments.length,remoteCalls:0};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){let raw='';try{for await(const p of process.stdin){raw+=p;if(Buffer.byteLength(raw)>16384)throw Error('BOUND');}const input=JSON.parse(raw);raw='';process.stdout.write(JSON.stringify(reviewedV22LogProfile(input)));}catch{process.stdout.write(JSON.stringify({state:'PHASE08_REVIEWED_LOG_PROFILE_REJECTED',rawErrorSuppressed:true,remoteCalls:0}));process.exitCode=1;}finally{raw='';}}
