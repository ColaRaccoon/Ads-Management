import {october16Definitions} from './october16-profile.mjs';
import {buildOctober16ProfileBatch,OCTOBER16_STATE_SQL} from './october16-batch.mjs';
let raw='';
try{
 for await(const part of process.stdin){raw+=part;if(Buffer.byteLength(raw)>131072)throw Error('BOUND');}
 const input=JSON.parse(raw);raw='';let result;
 if(input.action==='definitions')result={state:'PHASE08_OCTOBER16_DEFINITIONS',definitions:october16Definitions(input.phase)};
 else if(input.action==='state-sql')result={state:'PHASE08_OCTOBER16_STATE_SQL',sql:OCTOBER16_STATE_SQL};
 else if(input.action==='batch')result=buildOctober16ProfileBatch(input.value);
 else throw Error('ACTION');
 process.stdout.write(JSON.stringify(result));
}catch{process.stdout.write(JSON.stringify({state:'PHASE08_OCTOBER16_PROFILE_REJECTED',rawErrorSuppressed:true}));process.exitCode=1;}finally{raw='';}
