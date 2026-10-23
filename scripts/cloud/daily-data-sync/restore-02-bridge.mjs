import {createHash} from 'node:crypto';
import {assertReviewedDeployment,REVIEWED_SOURCE_SHA256,REVIEWED_DEPLOYMENT_ID} from './deployment-evidence.mjs';
import {restore02Sql,TEST_10_DEFINITIONS,NORMAL_02_DEFINITIONS} from './restore-02.mjs';
const sort=rows=>rows.slice().sort((a,b)=>a.key.localeCompare(b.key));
const project=(rows,keys)=>sort(rows.map(row=>Object.fromEntries(keys.map(k=>[k,row[k]]))));
let raw='';
try{
 for await(const part of process.stdin){raw+=part;if(Buffer.byteLength(raw)>131072)throw Error('BOUND');}
 const input=JSON.parse(raw),proof=assertReviewedDeployment(input.envelope);
 if(REVIEWED_SOURCE_SHA256!=='9b6fa647a8ebe56d3598aafa069400e2c880a8fda37a531f03d1e55b9ef5e409'||REVIEWED_DEPLOYMENT_ID!=='56ed1723-ba91-4cdd-a335-f0e241cc180c'||!proof.scheduleEnabled)throw Error('SOURCE');
 for(const [actual,keys]of [[proof.appSchedules,['key','connectionId','anchorAt','windowMinutes']],[proof.managementSchedules,['key','connectionId','provider','anchorAt','windowMinutes','cadenceDays']]]){
  const wanted=TEST_10_DEFINITIONS.map(x=>({...x,cadenceDays:x.provider==='CAFE24'?1:7}));
  if(JSON.stringify(project(actual,keys))!==JSON.stringify(project(wanted,keys)))throw Error('CLOCK');
 }
 let sql=await restore02Sql({currentCallDefinition:input.definition,expectedProsrcMd5:input.prosrcMd5});
 sql=sql.replace('BEGIN;','BEGIN;\nDO $kill$ BEGIN IF NOT EXISTS(SELECT 1 FROM daily_data_sync_ops.settings WHERE singleton AND stopped) THEN RAISE EXCEPTION \'RESTORE_02_KILL_REQUIRED\';END IF;END $kill$;');
 const app= NORMAL_02_DEFINITIONS.map(({key,connectionId,anchorAt,windowMinutes})=>({key,connectionId,anchorAt,windowMinutes}));
 process.stdout.write(JSON.stringify({state:'PHASE08_NORMAL_02_SQL_PREPARED',sql,sqlSha256:createHash('sha256').update(sql).digest('hex'),normalDefinitions:NORMAL_02_DEFINITIONS,normalAppSchedules:app}));
}catch{process.stdout.write(JSON.stringify({state:'PHASE08_NORMAL_02_PREPARATION_REJECTED',rawErrorSuppressed:true}));process.exitCode=1;}
finally{raw='';}
