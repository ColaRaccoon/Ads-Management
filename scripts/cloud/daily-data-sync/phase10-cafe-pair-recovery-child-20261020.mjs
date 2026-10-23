// Protected IPC only. Sensitive stdout is redirected to the DPAPI parent.
import {cafe08SnapshotSql,prepareCafe08Recovery,submitCafe08RefreshOnce,finalizeCafe08Recovery,verifyCafe08Recovery} from './phase10-cafe-pair-recovery-20261020.mjs';
let raw='',input,result;try{
 if(process.env.CAFE08_PROTECTED_PARENT!=='20261020-ROOT')throw Error();
 for await(const chunk of process.stdin){raw+=chunk;if(Buffer.byteLength(raw)>4194304)throw Error();}input=JSON.parse(raw);raw='';
 if(input.action==='SNAPSHOT_SQL')result={sql:cafe08SnapshotSql()};
 else if(input.action==='PREPARE')result=prepareCafe08Recovery(input.input);
 else if(input.action==='SUBMIT_ONCE')result=await submitCafe08RefreshOnce(input.plan);
 else if(input.action==='FINALIZE')result=finalizeCafe08Recovery(input.plan,input.protectedResponse,input.tables);
 else if(input.action==='VERIFY')result=verifyCafe08Recovery(input.prepared,input.snapshot,input.plan);
 else throw Error();
 process.stdout.write(JSON.stringify(result));
}catch{process.stdout.write('{"kind":"CAFE08_PROTECTED_CHILD_REJECTED","rawErrorSuppressed":true}');process.exitCode=1;}
finally{raw='';input=undefined;result=undefined;}
