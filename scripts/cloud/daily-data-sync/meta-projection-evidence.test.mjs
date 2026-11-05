import test from 'node:test';
import assert from 'node:assert/strict';
import { projectedCapture } from './meta-null-basic-projection.test.mjs';
import { selectMetaMcpDay, metaMcpFingerprint } from '../../../apps/api/src/daily-sync/meta-mcp-capture.ts';
import { getMetaFailureEvidence, safeMetaFailureEvidence, attachMetaCapture, metaCaptureSummary } from '../../../apps/api/src/daily-sync/meta-failure-evidence.ts';
import { safeMetaRuntimeFailureDiagnostic, retryableMetaReconciliationDiagnostic, markMetaFailureStage } from '../../../apps/api/src/daily-sync/meta-failure-diagnostic.ts';
import { securityAuditData } from '../../../apps/api/src/security-audit/security-audit.types.ts';

test('projection total mismatches keep exact metric/value/delta and enter only the existing bounded retry classes',()=>{
 for(const [field,reason]of [['impressions','BASIC_TOTALS'],['clicks','BASIC_TOTALS'],['link_click','LINK_TOTALS'],['omni_purchase','PURCHASE_TOTALS']]){
  const capture=projectedCapture();
  if(field==='amount_spent')capture.levels.ad_account[0][field].value='0.01';else capture.levels.ad_account[0][field]='1';
  const original=JSON.stringify(capture);
  assert.throws(()=>selectMetaMcpDay(capture),error=>{
   assert.equal(error.diagnosticCode,reason);
   markMetaFailureStage(error,'META_NORMALIZE');
   assert.equal(retryableMetaReconciliationDiagnostic(safeMetaRuntimeFailureDiagnostic(error,'META_FETCH')),true);
   attachMetaCapture(error,metaCaptureSummary(capture,metaMcpFingerprint(capture)));
   const evidence=getMetaFailureEvidence(error);
   assert.equal(evidence.check.condition,field==='amount_spent'?'HIERARCHY_SPEND_TOTAL':'HIERARCHY_METRIC_TOTAL');
   assert.equal(evidence.check.level,'ad_account');assert.equal(evidence.check.metric,field);
   assert.equal(evidence.check.expected,field==='amount_spent'?'0.01':'1');assert.equal(evidence.check.observed,'0');
   assert.equal(evidence.check.delta,field==='amount_spent'?'-0.01':'-1');
   assert.equal(evidence.capture.paginationComplete,true);assert.equal(evidence.capture.requestedPageSize,1000);
   assert.equal(evidence.capture.rowCounts.adset,2);
   const event=securityAuditData({actorType:'SYSTEM',action:'SYNC_UNIT_FAILED',targetType:'RUN_UNIT',result:'FAILURE',afterJson:{metaEvidence:evidence}});
   const json=JSON.stringify(event);
   assert(!json.includes('SYNTHETIC_PRIVATE_ACCOUNT'));assert(!json.includes('NULL_BASIC_SET'));assert(!json.includes('2138525300002203'));
   return true;
  });
  assert.equal(JSON.stringify(capture),original);
 }
});

test('structural projection faults keep exact conditions and remain nonretryable',()=>{
 for(const [change,condition]of [
  [c=>{c.levels.ad[1].impressions='1';},'REMOVED_CHILD_NONZERO'],
  [c=>{c.levels.ad[1].offsite_conversion_fb_pixel_purchase='0';},'PURCHASE_PAIR_NULL_MISMATCH'],
  [c=>{c.levels.ad[0].omni_purchase_values.value='1';},'ZERO_PURCHASE_NONZERO_VALUE'],
  [c=>{c.levels.adset[0].reach=null;},'RETAINED_PARENT_NULL_METRIC']]){
  const capture=projectedCapture();change(capture);
  assert.throws(()=>selectMetaMcpDay(capture),error=>{
   assert.equal(error.diagnosticCode,'ZERO_PROJECTION');
   assert.equal(getMetaFailureEvidence(error).check.condition,condition);
   markMetaFailureStage(error,'META_NORMALIZE');
   assert.equal(retryableMetaReconciliationDiagnostic(safeMetaRuntimeFailureDiagnostic(error,'META_FETCH')),false);
   return true;
  });
 }
});

test('failure evidence rejects arbitrary text/fields, is bounded, and cannot be mutated after sanitization',()=>{
 const safe={version:1,check:{condition:'HIERARCHY_METRIC_TOTAL',metric:'impressions',expected:'1',observed:'0',delta:'-1'}};
 for(const bad of [
  {...safe,accessToken:'PRIVATE'}, {...safe,check:{...safe.check,metric:'PRIVATE'}},
  {...safe,check:{...safe.check,observed:'PRIVATE'}}, {...safe,check:{...safe.check,condition:'PRIVATE'}},
  {...safe,check:{...safe.check,entityFingerprint:'PRIVATE'}}, {...safe,check:{...safe.check,observed:'1'.repeat(100)}}
 ])assert.equal(safeMetaFailureEvidence(bad),null);
 const copy=safeMetaFailureEvidence(safe);safe.check.metric='PRIVATE';assert.equal(copy.check.metric,'impressions');
});
