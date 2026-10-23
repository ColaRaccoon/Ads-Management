import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {operatorRetryOctober15Sql} from './operator-retry-october15.mjs';
import {assertReviewedDeployment,REVIEWED_SOURCE_SHA256,REVIEWED_DEPLOYMENT_ID} from './deployment-evidence.mjs';
let input='';
try {
 for await(const chunk of process.stdin){input+=chunk;if(Buffer.byteLength(input)>131072)throw Error('INPUT_BOUND');}
 const value=JSON.parse(input);const proof=assertReviewedDeployment(value.envelope);
 if(REVIEWED_SOURCE_SHA256!=='a986132a8f70757ca67ae93b54ce378926166da30ec9817378f206062e214097'||!proof.scheduleEnabled||proof.appSchedules.length!==3||proof.managementSchedules.length!==3)throw Error('RETRY_REVIEWED_SOURCE');
 const original=readFileSync('C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/reanchor-10am-20261015-v3.sql','utf8');
 const match=original.match(/CREATE OR REPLACE FUNCTION daily_data_sync_ops\.call\([\s\S]*?END \$\$;/);
 if(!match)throw Error('RETRY_FUNCTION_SOURCE');
 const sql=operatorRetryOctober15Sql({actorId:value.actorId,authId:value.authId,sourceSha:REVIEWED_SOURCE_SHA256,callDefinition:match[0]});
 process.stdout.write(JSON.stringify({state:'PHASE08_OPERATOR_RETRY_SQL_PREPARED',sql,sqlSha256:createHash('sha256').update(sql).digest('hex'),sourceSha:REVIEWED_SOURCE_SHA256,deploymentId:REVIEWED_DEPLOYMENT_ID}));
}catch{process.stdout.write(JSON.stringify({state:'PHASE08_OPERATOR_RETRY_SQL_REJECTED',rawErrorSuppressed:true}));process.exitCode=1;}
finally{input='';}
