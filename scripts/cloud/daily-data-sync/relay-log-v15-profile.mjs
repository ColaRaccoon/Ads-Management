// Root-verified v15 only. Preserve the independently reviewed older profiles.
import {pathToFileURL} from 'node:url';
import {ISOLATED_IDENTITY} from './deployment-evidence.mjs';
import {LEGACY_OCTOBER15_DEPLOYMENTS,REVIEWED_V13_DEPLOYMENTS} from './relay-log-v13-profile.mjs';
import {REVIEWED_V14_DEPLOYMENTS,reviewedOctober15LogProfile} from './relay-log-v14-profile.mjs';
export const V15_LOG_SOURCE_SHA='436055128dad4b150f6ff4c3a754d1cadc3b9cb784f3d659423df35f33f773ff';
export const REVIEWED_V15_DEPLOYMENTS=Object.freeze(['75138a65-d274-4858-a49b-64ac811adff3']);
export function reviewedV15October15LogProfile(input){
 if(input?.sourceSha!==V15_LOG_SOURCE_SHA)return reviewedOctober15LogProfile(input);
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join()!=='deploymentId,identity,sourceSha'||!REVIEWED_V15_DEPLOYMENTS.includes(input.deploymentId)||!input.identity||Array.isArray(input.identity)||Object.keys(input.identity).sort().join()!==Object.keys(ISOLATED_IDENTITY).sort().join()||!Object.entries(ISOLATED_IDENTITY).every(([k,v])=>input.identity[k]===v))throw Error('REVIEWED_LOG_PROFILE_REJECTED');
 const deployments=[...LEGACY_OCTOBER15_DEPLOYMENTS,...REVIEWED_V13_DEPLOYMENTS,...REVIEWED_V14_DEPLOYMENTS,...REVIEWED_V15_DEPLOYMENTS];
 if(deployments.length>16||new Set(deployments).size!==deployments.length||!deployments.includes(input.deploymentId)||deployments.some(id=>typeof id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)))throw Error('REVIEWED_LOG_PROFILE_REJECTED');
 return {state:'PHASE08_REVIEWED_LOG_PROFILE_PREPARED',sourceSha:input.sourceSha,currentDeploymentId:input.deploymentId,deployments,totalDeployments:deployments.length,remoteCalls:0};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){let raw='';try{for await(const part of process.stdin){raw+=part;if(Buffer.byteLength(raw)>16384)throw Error('BOUND');}const input=JSON.parse(raw);raw='';process.stdout.write(JSON.stringify(reviewedV15October15LogProfile(input)));}catch{process.stdout.write(JSON.stringify({state:'PHASE08_REVIEWED_LOG_PROFILE_REJECTED',rawErrorSuppressed:true,remoteCalls:0}));process.exitCode=1;}finally{raw='';}}
