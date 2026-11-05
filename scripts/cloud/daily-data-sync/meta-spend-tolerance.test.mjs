import test from 'node:test';
import assert from 'node:assert/strict';
import {Prisma} from '@prisma/client';
import {metaPurchaseWire,metaPurchaseCatalog} from './meta-day-batch.fixtures.mjs';
import {projectedCapture,normalizeProjection} from './meta-null-basic-projection.test.mjs';
import {createMetaMcpPurchaseResidualProof} from '../../../apps/api/src/daily-sync/meta-mcp-purchase.ts';
import {normalizeMetaMcpPurchaseSnapshot} from '../../../apps/api/src/daily-sync/meta-mcp-ads.client.ts';
import {metaSpendHierarchyEvidence,validMetaSpendReconciliation} from '../../../apps/api/src/domain/meta-spend-reconciliation.ts';
import {validCurrentMetadata} from '../../../apps/api/src/domain/meta-current-metadata.ts';
import {CanonicalApiWriterService} from '../../../apps/api/src/daily-sync/canonical-api-writer.service.ts';
import {getMetaFailureEvidence} from '../../../apps/api/src/daily-sync/meta-failure-evidence.ts';

function capture(delta='0'){
 const c=metaPurchaseWire();
 for(const level of Object.keys(c.levels))c.levels[level][0].amount_spent.value='100';
 c.levels.ad[0].amount_spent.value=new Prisma.Decimal(100).plus(delta).toFixed(4);
 return c;
}
function normalize(c){const cat=metaPurchaseCatalog(c);return normalizeMetaMcpPurchaseSnapshot(c,{version:1,transport:'META_ADS_MCP',purchaseProof:createMetaMcpPurchaseResidualProof(c,cat)},cat);}
test('exact and inclusive daily $10 boundaries preserve original amounts and strict metadata',()=>{
 for(const delta of ['0','0.06','10','-10']){
  const c=capture(delta),raw=JSON.stringify(c),n=normalize(c),e=n.ads[0].currentMetadata.sourceContext.spendReconciliation;
  assert.equal(n.ads[0].spendUsd,new Prisma.Decimal(100).plus(delta).toFixed(4));assert.equal(n.adsets[0].spendUsd,'100.0000');
  assert.equal(validCurrentMetadata(n.ads[0].currentMetadata),true);assert.equal(JSON.stringify(c),raw);
  if(delta==='0')assert.equal(e,undefined);else {assert.equal(validMetaSpendReconciliation(e),true);assert.equal(e.absoluteDifferencesUsd.adToAdset,new Prisma.Decimal(delta).abs().toFixed(4));}
 }
});
test('over $10 rejects with bounded numeric evidence; counts, pagination and membership stay strict',()=>{
 for(const delta of ['10.0001','-10.0001'])assert.throws(()=>normalize(capture(delta)),e=>{assert.equal(e.diagnosticCode,'BASIC_TOTALS');assert.equal(getMetaFailureEvidence(e).check.observed,'10.0001');return true;});
 for(const change of [c=>c.levels.ad[0].impressions='1',c=>c.levels.ad[0].omni_purchase='1',c=>c.paginationComplete=false,c=>c.levels.ad[0].adset_id='99']){
  const c=capture('0.06');change(c);assert.throws(()=>normalize(c));
 }
});
test('opposite signed entity differences cannot cancel and each entity does not get its own $10 allowance',()=>{
 for(const other of ['106','94']){
  const c=capture('6'),set=structuredClone(c.levels.adset[0]),ad=structuredClone(c.levels.ad[0]);
  set.id='22';set.name='SECOND_SET';ad.id='33';ad.adset_id=set.id;ad.adset_name=set.name;ad.amount_spent.value=other;
  c.levels.adset.push(set);c.levels.ad.push(ad);for(const level of ['campaign','ad_account'])c.levels[level][0].amount_spent.value='200';
  assert.equal(metaSpendHierarchyEvidence(c.levels,c.day).absoluteDifferencesUsd.adToAdset,'12.0000');assert.throws(()=>normalize(c));
 }
});
test('null parent projection still requires exact zero discarded children',()=>{
 const c=projectedCapture();c.levels.ad_account[0].amount_spent.value='0.06';const n=normalizeProjection(c);
 assert.equal(n.ads[0].spendUsd,'0.0000');assert.equal(n.ads[0].currentMetadata.sourceContext.spendReconciliation.accountSpendUsd,'0.0600');
 c.levels.ad[1].amount_spent.value='0.01';assert.throws(()=>normalizeProjection(c));
});
test('writer accepts only consistent complete day evidence and passes evidence to atomic publication',async()=>{
 process.env.DAILY_SYNC_META_TRANSPORT='MCP';process.env.DAILY_SYNC_META_MCP_USE_CASE='OWN_ACCOUNT_INTERNAL_REPORTING';
 const n=normalize(capture('10'));let published;
 const writer=new CanonicalApiWriterService({}, {publishUnit:async input=>{published=input;return {published:2};}}, {},{},{});
 const input={connectionId:'c',runId:'r',generation:1n,metricDate:new Date('2026-10-08Z'),pageCount:4,adPolicyVersion:1,adsetPolicyVersion:1,
  expectedCredentialRef:'protected',expectedCredentialExpiresAt:new Date(Date.now()+30*86400000),expectedMetaTransport:'MCP',ads:n.ads,adsets:n.adsets};
 await writer.publishMetaDay(input);assert.equal(published.metaSpendReconciliation.adSpendUsd,'110.0000');
 const tampered=structuredClone(input);tampered.ads[0].currentMetadata.sourceContext.spendReconciliation.adSpendUsd='109.0000';
 await assert.rejects(()=>writer.publishMetaDay(tampered));
 const missing=structuredClone(input);delete missing.ads[0].currentMetadata.sourceContext.spendReconciliation;delete missing.adsets[0].currentMetadata.sourceContext.spendReconciliation;
 await assert.rejects(()=>writer.publishMetaDay(missing));
});
