import {prepareCafeFull2Read,runCafeFull2ReadDay} from './phase10-cafe-full-read2-20261020.mjs';
let raw='',input,prepared,privateSnapshot;
try{
 if(process.env.CAFE08_FULL_READ2_PROTECTED_PARENT!=='20261020-ROOT')throw Error();
 process.stdin.setEncoding('utf8');
 for await(const part of process.stdin){raw+=part;if(Buffer.byteLength(raw)>4194304)throw Error();}input=JSON.parse(raw);raw='';
 prepared=prepareCafeFull2Read(input.input);
 if(input.action==='PREPARE')process.stdout.write(JSON.stringify({kind:'CAFE08_FULL_READ_PREFLIGHT',summary:prepared.safeSummary,checkpointCipherSha256:prepared.checkpointCipherSha256}));
 else if(input.action==='EXECUTE_DAY'){
  if(input.expectedCheckpointSha256!==prepared.checkpointCipherSha256)throw Error();
  const report=await runCafeFull2ReadDay(prepared,input.day,{usedRequests:input.usedRequests,usedBytes:input.usedBytes,onSnapshot:async value=>{privateSnapshot=value;}});
  if(report.completeTwoPass&&!privateSnapshot)throw Error();
  const wire=JSON.stringify({publicReport:report,privateSnapshot:privateSnapshot??null});if(Buffer.byteLength(wire)>4194304)throw Error();process.stdout.write(wire);
 }else throw Error();
}catch{process.stdout.write('{"kind":"CAFE08_FULL_READ_SAFE_REJECTION","rawErrorSuppressed":true,"automaticRefresh":false,"rawValuesReturned":0}');process.exitCode=1;}
finally{raw='';input=undefined;prepared=undefined;privateSnapshot=undefined;}
