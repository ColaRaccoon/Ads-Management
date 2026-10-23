// Public reviewed history only. Future deployment IDs must be appended by the root
// after actual identity verification. Never accept a caller-supplied history list.
import {pathToFileURL} from 'node:url';
import {ISOLATED_IDENTITY} from './deployment-evidence.mjs';
export const V13_LOG_SOURCE_SHA='6bf11939a6f7b4c676377c1c679a3a6473d158374072896b4ee15711f36a1fde';
export const LEGACY_OCTOBER15_DEPLOYMENTS=Object.freeze([
 'e71e73ea-838f-45d3-a19d-32033d3d7391','a0045206-20f8-4982-be2c-35505cbd3870','56ed1723-ba91-4cdd-a335-f0e241cc180c','86d5ad6d-eec8-414a-a922-9c6b8c62a245','ee97acf7-bce3-4134-a639-2f80cc4f310a','a35d7507-2044-41f5-9f91-fd4838ad0d28','5dac048f-5015-46fa-8ca4-5227352c834c'
]);
export const REVIEWED_V13_DEPLOYMENTS=Object.freeze([
 '4a6e678e-437e-41d8-830d-f1f642b07bb5', // Actual initial v13, root verified.
 'ea783d17-095b-4dee-86cc-5d6dc7820ce9', // Actual outage restoration, root verified.
 '5886c332-9751-4ba5-a650-b9ebd19e0be4' // Actual collection restore and loaded-definition proof, root verified.
]);
export function v13LogDeploymentProfile(input){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join()!=='deploymentId,identity,sourceSha'||typeof input.sourceSha!=='string'||input.sourceSha!==V13_LOG_SOURCE_SHA||typeof input.deploymentId!=='string'||!REVIEWED_V13_DEPLOYMENTS.includes(input.deploymentId))throw Error('V13_LOG_PROFILE_REJECTED');
 const identity=input.identity;if(!identity||typeof identity!=='object'||Array.isArray(identity)||Object.keys(identity).sort().join()!==Object.keys(ISOLATED_IDENTITY).sort().join()||!Object.entries(ISOLATED_IDENTITY).every(([key,value])=>typeof identity[key]==='string'&&identity[key]===value))throw Error('V13_LOG_PROFILE_REJECTED');
 const deployments=[...LEGACY_OCTOBER15_DEPLOYMENTS,...REVIEWED_V13_DEPLOYMENTS];
 if(LEGACY_OCTOBER15_DEPLOYMENTS.length!==7||REVIEWED_V13_DEPLOYMENTS.length<1||deployments.length>16||new Set(deployments).size!==deployments.length||deployments.some(id=>!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)))throw Error('V13_LOG_PROFILE_REJECTED');
 return {state:'PHASE08_V13_LOG_PROFILE_PREPARED',profile:'OCTOBER15_V13_REAL_CLOCK_RECOVERY',sourceSha:V13_LOG_SOURCE_SHA,currentDeploymentId:input.deploymentId,deployments,legacyDeployments:7,reviewedV13Deployments:REVIEWED_V13_DEPLOYMENTS.length,totalDeployments:deployments.length,remoteCalls:0};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){let raw='';try{for await(const part of process.stdin){raw+=part;if(Buffer.byteLength(raw)>16384)throw Error('BOUND');}const input=JSON.parse(raw);raw='';process.stdout.write(JSON.stringify(v13LogDeploymentProfile(input)));}catch{process.stdout.write(JSON.stringify({state:'PHASE08_V13_LOG_PROFILE_REJECTED',rawErrorSuppressed:true,remoteCalls:0}));process.exitCode=1;}finally{raw='';}}
