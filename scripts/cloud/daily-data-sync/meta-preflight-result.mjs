// Provider network is disabled at the injected transport boundary. DB stays READ ONLY.
import {runMetaDiagnostic,safeMetaDiagnosticFailure} from './meta-failed-day-diagnostic.mjs';
let raw='',input,blocked=0;
try{
 for await(const bytes of process.stdin){raw+=bytes;if(Buffer.byteLength(raw)>1048576)throw Error('BOUND');}
 input=JSON.parse(raw);raw='';if(input.mode!=='preflight')throw Error('MODE');
 try{const result=await runMetaDiagnostic(input,{request:async()=>{blocked++;throw Error('PROVIDER_NETWORK_DISABLED');}});process.stdout.write(JSON.stringify({state:'PHASE08_META_PROVIDER_DISABLED_PREFLIGHT_RETURNED',success:result.state==='PHASE08_META_DIAGNOSTIC_PREFLIGHT_VERIFIED',actualProviderRequests:0,blockedRequests:blocked,diagnostic:result}));}
 catch(error){process.stdout.write(JSON.stringify({state:'PHASE08_META_PROVIDER_DISABLED_PREFLIGHT_RETURNED',actualProviderRequests:0,blockedRequests:blocked,diagnostic:safeMetaDiagnosticFailure(error)}));}
}catch{process.stdout.write(JSON.stringify({state:'PHASE08_META_PREFLIGHT_INPUT_REJECTED',actualProviderRequests:0}));process.exitCode=1;}
finally{raw='';input=undefined;}
