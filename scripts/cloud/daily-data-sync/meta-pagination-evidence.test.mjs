import test from 'node:test';
import assert from 'node:assert/strict';
import {metaPurchaseWire} from './meta-day-batch.fixtures.mjs';
import {MetaMcpWireReader,metaMcpFields} from '../../../apps/api/src/daily-sync/meta-mcp-wire-reader.ts';
import {attachMetaCapture,metaCaptureSummary,getMetaFailureEvidence} from '../../../apps/api/src/daily-sync/meta-failure-evidence.ts';
import {metaMcpFingerprint} from '../../../apps/api/src/daily-sync/meta-mcp-capture.ts';
function fixture(mode='complete'){
 const wire=metaPurchaseWire(),levels=Object.keys(wire.levels),profile='PURCHASE_V1',fields=metaMcpFields(profile),calls=[];
 wire.levels.adset=Array.from({length:314},(_,i)=>({...structuredClone(wire.levels.adset[0]),id:String(2000+i),name:'SET_'+i}));
 wire.levels.ad=Array.from({length:1001},(_,i)=>({...structuredClone(wire.levels.ad[0]),id:String(10000+i),name:'AD_'+i,adset_id:String(2000+i%314),adset_name:'SET_'+(i%314)}));
 const catalog={version:1,server:'https://mcp.facebook.com/ads',tool:'ads_get_field_context',client_conversation_id:wire.clientConversationId,
  fields:[...new Set(Object.values(fields).flat())].map(name=>({name,levels:levels.filter(level=>fields[level].includes(name))}))};
 const reporting={server:catalog.server,reportingTool:{name:'ads_get_ad_entities',annotations:{readOnlyHint:true,destructiveHint:false},inputSchema:{properties:Object.fromEntries(['ad_account_id','fields','level','time_range','time_increment','object_state','include_additional_context','client_conversation_id','cursor','limit'].map(key=>[key,{type:key==='limit'?'integer':'string'}]))},outputSchema:{properties:{ad_entities:{type:'string'}}}}};
 const request=async(_url,options)=>{
  const args=JSON.parse(options.body).params.arguments;calls.push(args);assert.equal(args.limit,1000);
  const rows=wire.levels[args.level],offset=args.cursor?1000:0;
  const next=args.level==='ad'&&(offset===0&&mode!=='truncated'||offset===1000&&mode==='repeated');
  return new Response(JSON.stringify({jsonrpc:'2.0',id:1,result:{structuredContent:{ad_entities:JSON.stringify(rows.slice(offset,offset+1000)),summary:{total_count:rows.length},...(next?{pagination:{next_cursor:'synthetic-cursor'}}:{})}}}));
 };
 return {reader:new MetaMcpWireReader(request,response=>response.json()),calls,input:{accountId:wire.accountId,day:wire.day,clientConversationId:wire.clientConversationId,accessToken:'x'.repeat(50),catalog,reporting,deadlineAt:Date.now()+60000,allowUnverifiedIdentityCapture:true,profile}};
}
test('full wire reader traverses 1000+1 ads and all 314 adsets, preserving exact pagination evidence outside business fingerprints',async()=>{
 const f=fixture(),wire=await f.reader.fetchDay(f.input);
 assert.equal(wire.levels.ad.length,1001);assert.equal(wire.levels.adset.length,314);assert.equal(wire.pageCount,5);
 const serialized=JSON.stringify(wire),error=new Error('not serialized');attachMetaCapture(error,metaCaptureSummary(wire,metaMcpFingerprint(wire)));
 const capture=getMetaFailureEvidence(error).capture;
 assert.deepEqual(capture.pagination.ad,{pages:2,received:1001,reportedTotal:1001,ended:true});
 assert.deepEqual(capture.pagination.adset,{pages:1,received:314,reportedTotal:314,ended:true});
 assert.equal(f.calls.filter(row=>row.level==='ad').length,2);assert.equal(JSON.stringify(wire),serialized);
 assert(!JSON.stringify(capture).includes('synthetic-cursor'));
});
test('truncation against provider total and repeated next-page cursor cannot report a complete capture',async()=>{
 for(const [mode,code]of [['truncated','SUMMARY_MISMATCH'],['repeated','CURSOR_INVALID']]){
  const f=fixture(mode);await assert.rejects(f.reader.fetchDay(f.input),error=>error.safeCode===code);
 }
});
