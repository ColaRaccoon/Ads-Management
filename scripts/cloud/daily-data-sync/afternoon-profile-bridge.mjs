import {acceleratedDefinitions} from './accelerated-october15-profile.mjs';
import {buildAcceleratedProfileBatch,ACCELERATED_STATE_SQL} from './accelerated-october15-batch.mjs';
let raw='';
try{
 for await(const part of process.stdin){raw+=part;if(Buffer.byteLength(raw)>131072)throw Error('BOUND');}
 const input=JSON.parse(raw);raw='';let result;
 if(input.action==='definitions')result={state:'PHASE08_AFTERNOON_DEFINITIONS',definitions:acceleratedDefinitions(input.phase)};
 else if(input.action==='state-sql')result={state:'PHASE08_AFTERNOON_STATE_SQL',sql:ACCELERATED_STATE_SQL};
 else if(input.action==='batch')result=buildAcceleratedProfileBatch(input.value);
 else throw Error('ACTION');
 process.stdout.write(JSON.stringify(result));
}catch{process.stdout.write(JSON.stringify({state:'PHASE08_AFTERNOON_PROFILE_REJECTED',rawErrorSuppressed:true}));process.exitCode=1;}finally{raw='';}
