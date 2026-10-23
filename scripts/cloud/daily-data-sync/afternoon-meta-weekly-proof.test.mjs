import test from 'node:test';import assert from 'node:assert/strict';
import {META_AFTERNOON_WEEKLY_PROOF_SQL,META_FIRST_UNIT_FINGERPRINT_SQL,projectWeeklyProof,projectFirstUnitFingerprint,WEEKLY_REQUEST_KEY} from './afternoon-meta-weekly-proof.mjs';
function weekly(){return {state:'PHASE08_META_AFTERNOON_WEEKLY_READONLY',semantic_profile:'PURCHASE_V1',verified:true,identity_verified:true,all_units_verified:true,purchases_required:true,purchase_v1_semantics:true,raw_null_basis_verified:true,totals_and_retained_difference_verified:true,video_five_null:true,account_and_ad_value_equality_required:false,zero_day_observed_purchase_json_not_persisted:true,date_count:7,verified_days:7,ad_rows:350,adset_rows:84,valid_links:434,coverage_kinds:14,derived_ad_rows:100,derived_adset_rows:1,zero_days_code_gate_only:0,minimum_unit_attempts:1,maximum_unit_attempts:1,total_unit_attempts:7,retried_units:0,retry_attempts:0,provider_requests:0,database_writes:0,raw_values_returned:0};}
test('fixed seven-day SQL and first-day fingerprint are readonly and bind new occurrence separately from old manual ownership',()=>{
 for(const sql of [META_AFTERNOON_WEEKLY_PROOF_SQL,META_FIRST_UNIT_FINGERPRINT_SQL]){assert(sql.startsWith('BEGIN READ ONLY;'));assert(sql.endsWith('COMMIT;'));assert(sql.includes(WEEKLY_REQUEST_KEY));assert.doesNotMatch(sql,/\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/);}
 assert.match(META_AFTERNOON_WEEKLY_PROOF_SQL,/l.sync_run_id=m.sync_run_id/);assert.match(META_AFTERNOON_WEEKLY_PROOF_SQL,/last_attempt_run_id IN\(SELECT id FROM run\)/);assert.match(META_AFTERNOON_WEEKLY_PROOF_SQL,/zero_day_observed_purchase_json_not_persisted/);assert.match(META_FIRST_UNIT_FINGERPRINT_SQL,/unit_key='2026-10-08'/);
});
test('weekly typed projection retains genuine retry and zero-day qualifications; false results remain false',()=>{
 const a=weekly();a.maximum_unit_attempts=3;a.total_unit_attempts=9;a.retried_units=1;a.retry_attempts=2;assert.equal(projectWeeklyProof([a]).retry_attempts,2);
 const zero=weekly();Object.assign(zero,{ad_rows:0,adset_rows:0,valid_links:0,derived_ad_rows:0,derived_adset_rows:0,zero_days_code_gate_only:7});assert.equal(projectWeeklyProof([zero]).zero_days_code_gate_only,7);
 const partial=weekly();Object.assign(partial,{verified:false,verified_days:6,purchases_required:false});assert.equal(projectWeeklyProof([partial]).purchases_required,false);
 for(const mutate of [v=>v.raw='SYNTHETIC_PRIVATE',v=>v.ad_rows='350',v=>v.verified='true',v=>v.semantic_profile=['PURCHASE_V1'],v=>v.provider_requests=1,v=>v.account_and_ad_value_equality_required=true,v=>v.coverage_kinds=13,v=>v.minimum_unit_attempts=0]){const v=weekly();mutate(v);assert.throws(()=>projectWeeklyProof([v]));}
});
test('first-unit fingerprint projection never forwards unknown/type-contaminated fields',()=>{
 const a={state:'PHASE08_META_FIRST_UNIT_READONLY_FINGERPRINT',verified:true,identity_verified:true,unit_verified:true,live_leases:0,unit_attempts:1,current_ad_rows:55,current_adset_rows:13,provider_requests:0,database_writes:0,raw_values_returned:0,fingerprint:'a'.repeat(32)};assert.equal(projectFirstUnitFingerprint([a]).fingerprint,a.fingerprint);
 for(const bad of [{...a,raw:'SYNTHETIC_PRIVATE'},{...a,fingerprint:'PRIVATE'},{...a,unit_attempts:'1'},{...a,live_leases:1}])assert.throws(()=>projectFirstUnitFingerprint([bad]));
});
