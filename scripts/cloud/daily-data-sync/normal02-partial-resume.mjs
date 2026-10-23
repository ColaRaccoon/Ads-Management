// Distinct fallback: lets healthy Cafe24/Google proceed, keeps Meta PAUSED. No collection.
import {pathToFileURL} from 'node:url';
import {buildNormal02Resume} from './normal02-resume.mjs';
const oldAction='SYNC_SCHEDULE_NORMAL_CLOCK_RESUME',action='SYNC_SCHEDULE_PARTIAL_NORMAL_CLOCK_RESUME';
export function buildNormal02PartialResume(input,options){
 let {sql}=buildNormal02Resume(input,options);
 const cut=(start,end)=>{const at=sql.indexOf(start);if(at<0||sql.indexOf(start,at+1)>=0)throw Error('PARTIAL_RESUME_SOURCE_REJECTED');const last=sql.indexOf(end,at);if(last<0)throw Error('PARTIAL_RESUME_SOURCE_REJECTED');sql=sql.slice(0,at)+sql.slice(last+end.length);};
 // The full-success gate remains unchanged in its own module. This explicitly different
 // fallback checks failed Meta history and healthy-provider coverage instead.
 cut(" IF NOT EXISTS(SELECT 1 FROM phase08_meta_ads.sync_runs r WHERE r.connection_id='1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6' AND r.trigger='MANUAL'",'END IF;');
 cut(' IF (SELECT count(*) FROM phase08_meta_ads.meta_ad_daily_metrics m JOIN phase08_meta_ads.source_record_links','END IF;');
 const guards=`
 IF clock_timestamp()<'2026-10-15T02:50:00Z'::timestamptz THEN RAISE EXCEPTION 'PARTIAL_ORIGINAL_WINDOW_ACTIVE';END IF;
 IF EXISTS(SELECT 1 FROM phase08_meta_ads.sync_runs WHERE connection_id='1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6' AND status NOT IN('SUCCEEDED','FAILED','ACTION_REQUIRED','CANCELLED'))
 OR NOT EXISTS(SELECT 1 FROM phase08_meta_ads.sync_runs r WHERE r.connection_id='1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6' AND r.request_key='phase08-manual-meta-20261008-v11-20261015' AND r.trigger='MANUAL' AND r.status='FAILED' AND r.safe_error_code='PROVIDER_UNAVAILABLE' AND r.rows_published=0 AND (SELECT count(*) FROM phase08_meta_ads.run_units WHERE run_id=r.id)=1 AND EXISTS(SELECT 1 FROM phase08_meta_ads.run_units WHERE run_id=r.id AND unit_key='2026-10-08' AND status='FAILED' AND attempts=1 AND published_count=0))
 OR EXISTS(SELECT 1 FROM phase08_meta_ads.source_coverage WHERE connection_id='1277dc2a-ea20-41eb-8a1c-ab1bfcc564f6' AND metric_date BETWEEN '2026-10-08' AND '2026-10-14' AND source='API' AND state IN('COMPLETE_ZERO','COMPLETE_NONZERO'))
 THEN RAISE EXCEPTION 'PARTIAL_META_HISTORY';END IF;
 IF NOT EXISTS(SELECT 1 FROM phase08_meta_ads.source_coverage c JOIN phase08_meta_ads.sync_runs r ON r.id=c.last_success_run_id WHERE c.connection_id='0c35defe-45fc-4a54-bc79-704df7bca5b1' AND c.data_kind='CAFE24_ORDER' AND c.metric_date='2026-10-14' AND c.source='API' AND c.state='COMPLETE_NONZERO' AND c.reconciliation_status='CAFE24_API_ONLY_VERIFIED' AND r.status='SUCCEEDED')
 OR (SELECT count(*) FROM phase08_meta_ads.source_coverage c JOIN phase08_meta_ads.sync_runs r ON r.id=c.last_success_run_id WHERE c.connection_id='b9ebee4b-5d4e-4eae-92b9-9facfbf3c900' AND c.data_kind='GOOGLE_CAMPAIGN' AND c.metric_date BETWEEN '2026-10-08' AND '2026-10-14' AND c.source='API' AND c.state IN('COMPLETE_ZERO','COMPLETE_NONZERO') AND r.status='SUCCEEDED')<>7 THEN RAISE EXCEPTION 'PARTIAL_HEALTHY_COVERAGE';END IF;
`;
 sql=sql.replace('END $guard$;',guards+'END $guard$;');
 sql=sql.replace("UPDATE daily_data_sync_ops.schedules SET paused=false WHERE key='phase08-meta' AND paused;",'-- Meta paused=true is preserved; no schedule row is changed.');
 sql=sql.replaceAll(oldAction,action).replaceAll('PHASE08_NORMAL02_RESUMED','PHASE08_NORMAL02_PARTIALLY_RESUMED');
 sql=sql.replace("'SYNC_SCHEDULE','phase08-meta','SUCCESS'","'SYNC_SCHEDULE','phase08-healthy-providers','SUCCESS'");
 sql=sql.replace("'metaPaused',false", "'metaPaused',true").replace("'manualRecoveredDay','2026-10-08'", "'manualRecoveredDay',NULL").replace("'remainingUncollectedDates',6", "'remainingUncollectedDates',7");
 sql=sql.replace("OR EXISTS(SELECT 1 FROM daily_data_sync_ops.schedules WHERE paused)","OR NOT EXISTS(SELECT 1 FROM daily_data_sync_ops.schedules WHERE key='phase08-meta' AND paused) OR EXISTS(SELECT 1 FROM daily_data_sync_ops.schedules WHERE key<>'phase08-meta' AND paused)");
 sql=sql.replace('false AS meta_paused','true AS meta_paused').replace('6 AS uncollected_old_dates','7 AS uncollected_old_dates');
 if(sql.includes("SET paused=false")||!sql.includes('true AS meta_paused'))throw Error('PARTIAL_RESUME_SOURCE_REJECTED');
 return {state:'PHASE08_NORMAL02_PARTIAL_RESUME_SQL_PREPARED',sql};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){let raw='';try{for await(const part of process.stdin){raw+=part;if(Buffer.byteLength(raw)>65536)throw Error('BOUND');}const input=JSON.parse(raw);raw='';process.stdout.write(JSON.stringify(buildNormal02PartialResume(input)));}catch{process.stdout.write(JSON.stringify({state:'PHASE08_NORMAL02_PARTIAL_RESUME_PREPARATION_FAILED',rawErrorSuppressed:true}));process.exitCode=1;}finally{raw='';}}
