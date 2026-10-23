// Root diagnostic result envelope; success=false is never a successful checkpoint diagnosis.
import {diagnoseCheckpoint,safeCheckpointFailure} from './checkpoint-readonly-diagnostic.mjs';
let raw='',input;
try {
 for await(const bytes of process.stdin){raw+=bytes;if(Buffer.byteLength(raw)>1048576)throw Error('BOUND');}
 input=JSON.parse(raw);raw='';
 try {process.stdout.write(JSON.stringify({state:'PHASE08_CHECKPOINT_PROBE_RETURNED',success:true,result:await diagnoseCheckpoint(input)}));}
 catch(error){process.stdout.write(JSON.stringify({state:'PHASE08_CHECKPOINT_PROBE_RETURNED',success:false,result:safeCheckpointFailure(error)}));}
}catch{process.stdout.write(JSON.stringify({state:'PHASE08_CHECKPOINT_PROBE_REJECTED'}));process.exitCode=1;}
finally{raw='';input=undefined;}
