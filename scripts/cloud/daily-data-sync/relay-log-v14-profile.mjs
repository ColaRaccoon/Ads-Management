// Fixed reviewed source/deployment pairs; never accept a caller history list.
import {pathToFileURL} from 'node:url';
import {ISOLATED_IDENTITY} from './deployment-evidence.mjs';
import {v13LogDeploymentProfile,V13_LOG_SOURCE_SHA,LEGACY_OCTOBER15_DEPLOYMENTS,REVIEWED_V13_DEPLOYMENTS} from './relay-log-v13-profile.mjs';
export const V14_LOG_SOURCE_SHA='e83351e69260d94a6aaebb5ff6d109bd38aa0570b3bdbc1f55069d8a3b39d44f';
export const REVIEWED_V14_DEPLOYMENTS=Object.freeze(['653a3679-11f5-42d1-9eab-aa5c1db71654','44783a13-1150-4f13-9d7a-88217bd9784a']);
export function reviewedOctober15LogProfile(input){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join()!=='deploymentId,identity,sourceSha')throw Error('REVIEWED_LOG_PROFILE_REJECTED');
 let deployments;
 if(input.sourceSha===V13_LOG_SOURCE_SHA)deployments=v13LogDeploymentProfile(input).deployments;
 else{
  if(input.sourceSha!==V14_LOG_SOURCE_SHA||!REVIEWED_V14_DEPLOYMENTS.includes(input.deploymentId)||!input.identity||Array.isArray(input.identity)||Object.keys(input.identity).sort().join()!==Object.keys(ISOLATED_IDENTITY).sort().join()||!Object.entries(ISOLATED_IDENTITY).every(([k,v])=>input.identity[k]===v))throw Error('REVIEWED_LOG_PROFILE_REJECTED');
  deployments=[...LEGACY_OCTOBER15_DEPLOYMENTS,...REVIEWED_V13_DEPLOYMENTS,...REVIEWED_V14_DEPLOYMENTS];
 }
 if(deployments.length>16||new Set(deployments).size!==deployments.length||!deployments.includes(input.deploymentId)||deployments.some(id=>typeof id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)))throw Error('REVIEWED_LOG_PROFILE_REJECTED');
 return {state:'PHASE08_REVIEWED_LOG_PROFILE_PREPARED',sourceSha:input.sourceSha,currentDeploymentId:input.deploymentId,deployments,totalDeployments:deployments.length,remoteCalls:0};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){let raw='';try{for await(const part of process.stdin){raw+=part;if(Buffer.byteLength(raw)>16384)throw Error('BOUND');}const input=JSON.parse(raw);raw='';process.stdout.write(JSON.stringify(reviewedOctober15LogProfile(input)));}catch{process.stdout.write(JSON.stringify({state:'PHASE08_REVIEWED_LOG_PROFILE_REJECTED',rawErrorSuppressed:true,remoteCalls:0}));process.exitCode=1;}finally{raw='';}}
