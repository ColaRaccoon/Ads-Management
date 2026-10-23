// Parent captures only fixed/count/type output. Secrets arrive exclusively stdin.
import {prepareCafeFieldSample,runCafeFieldSample} from './phase10-cafe-field-sample-20261020.mjs';
let raw='',input,prepared;try{
 if(process.env.CAFE08_FIELD_PROTECTED_PARENT!=='20261020-ROOT')throw Error();
 for await(const part of process.stdin){raw+=part;if(Buffer.byteLength(raw)>4194304)throw Error();}input=JSON.parse(raw);raw='';
 prepared=prepareCafeFieldSample(input.input);
 if(input.action==='PREPARE')process.stdout.write(JSON.stringify({kind:'CAFE08_FIELD_SAMPLE_PREFLIGHT',summary:prepared.safeSummary,checkpointCipherSha256:prepared.checkpointCipherSha256}));
 else if(input.action==='EXECUTE'){if(input.expectedCheckpointSha256!==prepared.checkpointCipherSha256)throw Error();process.stdout.write(JSON.stringify(await runCafeFieldSample(prepared)));}
 else throw Error();
}catch{process.stdout.write('{"kind":"CAFE08_FIELD_SAMPLE_SAFE_REJECTION","rawErrorSuppressed":true,"automaticRefresh":false,"rawValuesReturned":0}');process.exitCode=1;}
finally{raw='';input=undefined;prepared=undefined;}
