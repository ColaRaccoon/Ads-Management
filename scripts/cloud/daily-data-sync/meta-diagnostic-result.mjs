// A returned diagnostic envelope is distinct from a successful capture.
import {runMetaDiagnostic,safeMetaDiagnosticFailure} from './meta-failed-day-diagnostic.mjs';
let raw='',input;
try{
 for await(const bytes of process.stdin){raw+=bytes;if(Buffer.byteLength(raw)>1048576)throw Error('BOUND');}
 input=JSON.parse(raw);raw='';
 try{process.stdout.write(JSON.stringify({state:'PHASE08_META_DIAGNOSTIC_RESULT_RETURNED',success:true,result:await runMetaDiagnostic(input)}));}
 catch(error){process.stdout.write(JSON.stringify({state:'PHASE08_META_DIAGNOSTIC_RESULT_RETURNED',success:false,result:safeMetaDiagnosticFailure(error)}));}
}catch{process.stdout.write(JSON.stringify({state:'PHASE08_META_DIAGNOSTIC_INPUT_REJECTED'}));process.exitCode=1;}
finally{raw='';input=undefined;}
