import {runMetaFoundationRollbackProbe,safeMetaFoundationRollbackFailure} from './meta-foundation-rollback-probe.mjs';
let raw='',input;
const hard=setTimeout(()=>{process.stdout.write(JSON.stringify({state:'PHASE08_META_FULL_FOUNDATION_ROLLBACK_RESULT_RETURNED',success:false,result:{state:'PHASE08_META_FULL_FOUNDATION_ROLLBACK_FAILED',stage:'HARD_TIMEOUT',rollbackVerified:false,providerRequests:0,inspectBeforeRetry:true,rawErrorSuppressed:true}}),()=>process.exit(0));},55000);
try{
 for await(const part of process.stdin){raw+=part;if(Buffer.byteLength(raw)>1048576)throw Error('BOUND');}
 input=JSON.parse(raw);raw='';
 try{process.stdout.write(JSON.stringify({state:'PHASE08_META_FULL_FOUNDATION_ROLLBACK_RESULT_RETURNED',success:true,result:await runMetaFoundationRollbackProbe(input)}),()=>process.exit(0));}
 catch(error){process.stdout.write(JSON.stringify({state:'PHASE08_META_FULL_FOUNDATION_ROLLBACK_RESULT_RETURNED',success:false,result:safeMetaFoundationRollbackFailure(error)}),()=>process.exit(0));}
}catch{process.stdout.write(JSON.stringify({state:'PHASE08_META_ROLLBACK_INPUT_REJECTED'}));process.exitCode=1;}
finally{clearTimeout(hard);raw='';input=undefined;}
