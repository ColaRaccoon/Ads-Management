import {pathToFileURL} from 'node:url';
import {buildNormal02Resume} from './normal02-resume.mjs';
const remaining=Array.from({length:6},(_,i)=>`2026-10-${String(9+i).padStart(2,'0')}`);
export function assertSinWarningEvidence(warning,envelope){
 const keys=['state','recoveredDay','remainingDates','remainingDateCount','warningCode','warningStatus','automaticBackfill','cafe24AndGoogleWarnings','oldWeeklySucceeded','providerRequests','rawValuesReturned','sourceSha','deploymentId','observedAt','loginRequests','warningRequests','loginSessionWritesExpected'];
 if(!warning||typeof warning!=='object'||Array.isArray(warning)||Object.keys(warning).length!==keys.length||keys.some(k=>!Object.hasOwn(warning,k))||warning.state!=='PHASE08_MANUAL_META_WARNING_VERIFIED'||warning.recoveredDay!=='2026-10-08'||JSON.stringify(warning.remainingDates)!==JSON.stringify(remaining)||warning.remainingDateCount!==6||warning.warningCode!=='MISSING_SCHEDULE'||warning.warningStatus!=='EXPIRED'||warning.automaticBackfill!==false||warning.cafe24AndGoogleWarnings!==0||warning.oldWeeklySucceeded!==false||warning.providerRequests!==0||warning.rawValuesReturned!==0||warning.sourceSha!==envelope?.payload?.sourceSha||warning.deploymentId!==envelope?.payload?.deploymentId||warning.loginRequests!==1||warning.warningRequests!==1||warning.loginSessionWritesExpected!==true||typeof warning.observedAt!=='string'||!Number.isFinite(Date.parse(warning.observedAt))||Math.abs(Date.now()-Date.parse(warning.observedAt))>300000)throw Error('SIN_RESUME_WARNING_REJECTED');
}
export function buildNormal02SinResume(input,options){
 assertSinWarningEvidence(input?.warningEvidence,input?.envelope);
 let {sql}=buildNormal02Resume(input,options);
 const old="r.request_key='phase08-manual-meta-20261008-v11-20261015'";
 if(sql.split(old).length!==2)throw Error('SIN_RESUME_SOURCE_REJECTED');
 sql=sql.replace(old,"r.request_key='phase08-manual-meta-20261008-v11-sin-20261015'");
 const guards=`
 IF NOT EXISTS(SELECT 1 FROM phase08_meta_ads.sync_runs r WHERE r.connection_id='1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6' AND r.request_key='phase08-manual-meta-20261008-v11-20261015' AND r.trigger='MANUAL' AND r.status='FAILED' AND r.safe_error_code='PROVIDER_UNAVAILABLE' AND r.rows_published=0 AND (SELECT count(*) FROM phase08_meta_ads.run_units WHERE run_id=r.id)=1 AND EXISTS(SELECT 1 FROM phase08_meta_ads.run_units WHERE run_id=r.id AND unit_key='2026-10-08' AND status='FAILED' AND attempts=1 AND published_count=0))
 OR EXISTS(SELECT 1 FROM phase08_meta_ads.source_coverage WHERE connection_id='1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6' AND metric_date BETWEEN '2026-10-09' AND '2026-10-14' AND source='API' AND state IN('COMPLETE_ZERO','COMPLETE_NONZERO'))
 THEN RAISE EXCEPTION 'SIN_RESUME_FAILED_HISTORY_OR_WARNING_SCOPE';END IF;
`;
 sql=sql.replace('END $guard$;',guards+'END $guard$;');
 return {state:'PHASE08_NORMAL02_SIN_RESUME_SQL_PREPARED',sql};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){let raw='';try{for await(const part of process.stdin){raw+=part;if(Buffer.byteLength(raw)>131072)throw Error('BOUND');}const input=JSON.parse(raw);raw='';process.stdout.write(JSON.stringify(buildNormal02SinResume(input)));}catch{process.stdout.write(JSON.stringify({state:'PHASE08_NORMAL02_SIN_RESUME_PREPARATION_FAILED',rawErrorSuppressed:true}));process.exitCode=1;}finally{raw='';}}
