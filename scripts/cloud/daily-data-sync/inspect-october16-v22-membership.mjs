// Root-only read-only wrapper: preserve the verifier's closed failure projection.
import {verifyMetaMembership} from './october16-v22-repeat-meta-membership-readonly.mjs';
let raw='';const timer=setTimeout(()=>process.exit(1),45000);
try {for await(const p of process.stdin){raw+=p;if(Buffer.byteLength(raw)>1048576)throw Error('BOUND');}
 const input=JSON.parse(raw);raw='';const result=await verifyMetaMembership(input);
 process.stdout.write(JSON.stringify(result),()=>{clearTimeout(timer);process.exit(0);});
}catch{process.stdout.write(JSON.stringify({state:'PHASE08_OCTOBER16_META_MEMBERSHIP_FAILED',stage:'TARGET',code:'REJECTED',rawErrorSuppressed:true,providerRequests:0,databaseWrites:0,rawValuesReturned:0}),()=>{clearTimeout(timer);process.exit(0);});}
finally{raw='';}
