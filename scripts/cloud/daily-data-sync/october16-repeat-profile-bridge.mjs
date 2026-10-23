import {october16Definitions} from './october16-repeat-profile.mjs';
import {buildOctober16ProfileBatch,OCTOBER16_STATE_SQL} from './october16-repeat-batch.mjs';
let raw='';try{for await(const p of process.stdin){raw+=p;if(Buffer.byteLength(raw)>131072)throw Error('BOUND');}const x=JSON.parse(raw);raw='';let out;
 if(x.action==='definitions')out={state:'PHASE08_OCTOBER16_DEFINITIONS',definitions:october16Definitions(x.phase)};
 else if(x.action==='state-sql')out={state:'PHASE08_OCTOBER16_STATE_SQL',sql:OCTOBER16_STATE_SQL};
 else if(x.action==='batch')out=buildOctober16ProfileBatch(x.value);else throw Error('ACTION');process.stdout.write(JSON.stringify(out));
}catch{process.stdout.write(JSON.stringify({state:'PHASE08_OCTOBER16_PROFILE_REJECTED',rawErrorSuppressed:true}));process.exitCode=1;}finally{raw='';}
