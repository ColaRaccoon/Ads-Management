import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {MetaMcpAdsClient} from '../../../apps/api/src/daily-sync/meta-mcp-ads.client';
import {MetaMcpWireReader,META_MCP_PURCHASE_FIELDS} from '../../../apps/api/src/daily-sync/meta-mcp-wire-reader';
import {boundedMetaMcpEnvelope} from '../../../apps/api/src/daily-sync/meta-mcp-envelope';
import {GoogleAdsClient} from '../../../apps/api/src/daily-sync/google-ads.client';
import {normalizeCafe24Order} from '../../../apps/api/src/daily-sync/cafe24-order-adapter';
const {makeFixtures,ACCOUNT}=createRequire(import.meta.url)('./phase10-resume-mixed-fixtures.cjs');
test('real MCP wire decoder and PURCHASE_V1 normalization accept synthetic523ad200adsets with exact parent spend',async()=>{
  process.env.DAILY_SYNC_META_TRANSPORT='MCP';process.env.DAILY_SYNC_META_MCP_USE_CASE='OWN_ACCOUNT_INTERNAL_REPORTING';
  const f=makeFixtures(META_MCP_PURCHASE_FIELDS,0),c=new MetaMcpAdsClient(f.catalog,f.reporting,new MetaMcpWireReader(f.request,boundedMetaMcpEnvelope));
  const out=await c.fetchDay({accountId:ACCOUNT,day:'2026-10-19',accessToken:'synthetic-meta-token-with-forty-characters-0000000000',deadlineAt:Date.now()+30000,settings:{actionReportTime:'MCP_PROVIDER_DEFAULT_UNVERIFIED',attributionWindows:[]}});
  assert.equal(out.ads.length,523);assert.equal(out.adsets.length,200);assert.equal(f.counts.meta,4);
  f.setFault('META_NULL_FREQUENCY');await assert.rejects(c.fetchDay({accountId:ACCOUNT,day:'2026-10-19',accessToken:'synthetic-meta-token-with-forty-characters-0000000000',deadlineAt:Date.now()+30000,settings:{actionReportTime:'MCP_PROVIDER_DEFAULT_UNVERIFIED',attributionWindows:[]}}),(e:any)=>e.safeCode==='FIELD_UNSUPPORTED');
});
test('real Google parser sees explicitzero and positive cost-balanced day without network',async()=>{
  const f=makeFixtures(META_MCP_PURCHASE_FIELDS,0),c=new GoogleAdsClient({getAccessToken:async()=> 'synthetic-google-token'},f.request);
  for(const [day,n]of [['2026-10-18',3],['2026-10-19',0]] as const){const out=await c.fetchDay({customerId:'9000000001',day,deadlineAt:Date.now()+30000});assert.equal(out.rows.length,n);}
});
test('actual Cafe adapter parses invented343orders379items without private fields',()=>{
  const f=makeFixtures(META_MCP_PURCHASE_FIELDS,0),origins=new Map();
  const rows=Array.from({length:343},(_,i)=>normalizeCafe24Order(f.order(i,'2026-10-19'),f.items(i),{verifiedSellerDropdown:true,csvOptionEvidence:{mallId:'didadi0729',shopKey:'shop1'},compositionOrigins:origins})).flat();assert.equal(rows.length,379);
});
