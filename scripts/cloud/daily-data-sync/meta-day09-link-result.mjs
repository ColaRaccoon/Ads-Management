import {runMetaDiagnostic,safeMetaDiagnosticFailure} from './meta-failed-day09-diagnostic.mjs';
import {inspectDay09LinkGates,projectDay09LinkGates} from './meta-day09-link-gates.mjs';
let raw='',input,output;
const hard=setTimeout(()=>process.exit(1),60000);
try{
 for await(const bytes of process.stdin){raw+=bytes;if(Buffer.byteLength(raw)>1048576)throw Error('BOUND');}
 input=JSON.parse(raw);raw='';if(input?.action==='project'){
 if(Object.keys(input).sort().join()!=='action,value')throw Error('SCOPE');output=projectDay09LinkGates(input.value);
 }else{
 if(input?.mode!=='offline'||input?.day!=='2026-10-09')throw Error('SCOPE');
 const result=await runMetaDiagnostic(input,{offlineClassifier:inspectDay09LinkGates,request:async()=>{throw Error('PROVIDER_FORBIDDEN');},factory:()=>{throw Error('DATABASE_FORBIDDEN');}});
 const {mode,artifactId,originalFailureReproduced,state,providerRequests,...diagnostic}=result;
 output=projectDay09LinkGates({state:'PHASE08_META_DAY09_LINK_GATES',...diagnostic,providerRequests:0,offlineOnly:true,originalFailureReproduced:false});
 }
}catch(error){output=safeMetaDiagnosticFailure(error);}
finally{raw='';input=undefined;}
await new Promise(resolve=>process.stdout.write(JSON.stringify(output),resolve));clearTimeout(hard);process.exit(process.exitCode??0);
