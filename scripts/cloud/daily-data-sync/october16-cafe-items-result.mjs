import {diagnoseCafeItems,safeCafeItemDiagnosticFailure} from './october16-cafe-items-diagnostic.mjs';
let raw='',input;
try{
 for await(const bytes of process.stdin){raw+=bytes;if(Buffer.byteLength(raw)>1048576)throw Error('BOUND');}
 input=JSON.parse(raw);raw='';
 try{process.stdout.write(JSON.stringify({state:'PHASE08_CAFE_ITEM_RESULT_RETURNED',success:true,result:await diagnoseCafeItems(input)}));}
 catch(error){process.stdout.write(JSON.stringify({state:'PHASE08_CAFE_ITEM_RESULT_RETURNED',success:false,result:safeCafeItemDiagnosticFailure(error)}));}
}catch{process.stdout.write(JSON.stringify({state:'PHASE08_CAFE_ITEM_INPUT_REJECTED'}));process.exitCode=1;}
finally{raw='';input=undefined;}
