import {prepareCafeFullRead,runCafeFullReadDay} from './phase10-cafe-full-read-20261020.mjs';
let raw='',input,prepared;
try{
 if(process.env.CAFE08_FULL_READ_PROTECTED_PARENT!=='20261020-ROOT')throw Error();
 process.stdin.setEncoding('utf8');
 for await(const part of process.stdin){raw+=part;if(Buffer.byteLength(raw)>4194304)throw Error();}input=JSON.parse(raw);raw='';
 prepared=prepareCafeFullRead(input.input);
 if(input.action==='PREPARE')process.stdout.write(JSON.stringify({kind:'CAFE08_FULL_READ_PREFLIGHT',summary:prepared.safeSummary,checkpointCipherSha256:prepared.checkpointCipherSha256}));
 else if(input.action==='EXECUTE_DAY'){
  if(input.expectedCheckpointSha256!==prepared.checkpointCipherSha256)throw Error();
  process.stdout.write(JSON.stringify(await runCafeFullReadDay(prepared,input.day,{usedRequests:input.usedRequests,usedBytes:input.usedBytes})));
 }else throw Error();
}catch{process.stdout.write('{"kind":"CAFE08_FULL_READ_SAFE_REJECTION","rawErrorSuppressed":true,"automaticRefresh":false,"rawValuesReturned":0}');process.exitCode=1;}
finally{raw='';input=undefined;prepared=undefined;}
