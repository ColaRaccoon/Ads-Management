import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import {validate} from 'class-validator';
import {MappingsService} from '../apps/api/src/mappings/mappings.service';
import {MappingsController} from '../apps/api/src/mappings/mappings.controller';
import {UpdateProductMappingRuleDto,ApplyProductMappingRuleDto} from '../apps/api/src/mappings/dto/mappings-transport.dto';
import {REQUIRED_PERMISSIONS} from '../apps/api/src/auth/route-decorators';
const date=new Date('2026-10-28Z'),stamp=new Date('2026-10-29T01:00:00.000Z');
const original={id:'rule',productId:'old',matchType:'CONTAINS',pattern:'케겔',patternKey:'케겔',priority:100,isActive:true,validFrom:date,validTo:null,note:null,updatedAt:stamp};
function fixture(){
 const f:any={rule:{...original},audits:[],sets:[{id:'set-row',metaAdsetId:'set',adsetName:'261028_케겔',metricDate:date,source:'CSV',connectionId:null,isCurrent:true,uploadRowId:null,productId:'old',productMatchSource:'RULE',productMatchRuleId:'rule',spendUsd:'19.23'}],ads:[{id:'ad-row',metaAdsetRefId:'set',adNameSnapshot:'케겔 광고',adsetNameSnapshot:'261028_케겔',campaignNameSnapshot:'ASC_케겔',metricDate:date,source:'CSV',connectionId:null,isCurrent:true,uploadRowId:null,productId:'old',productMatchSource:'RULE',productMatchRuleId:'rule',spendUsd:'19.23'}],currentProduct:'old',histories:[]};
 const select=(rows:any[],q:any)=>rows.filter(r=>(!q.where?.metaAdsetId||r.metaAdsetId===q.where.metaAdsetId)&&(!q.where?.metaAdsetRefId||r.metaAdsetRefId===q.where.metaAdsetRefId)&&(!q.where?.productId?.not||r.productId!==null));
 const model=(rows:any[])=>({findMany:async(q:any)=>select(rows,q),update:async({where,data}:any)=>Object.assign(rows.find(r=>r.id===where.id),data)});
 const db:any={productMatchRule:{findUnique:async()=>({...f.rule}),findUniqueOrThrow:async()=>({...f.rule}),
   findMany:async()=>f.rule.isActive?[f.rule]:f.fallback?[f.fallback]:[],updateMany:async({data}:any)=>{if(f.race)return {count:0};Object.assign(f.rule,data);return {count:1};}},
  product:{findUnique:async()=>({id:'new',isActive:true})},metaAdsetDailyMetric:model(f.sets),metaAdDailyMetric:model(f.ads),
  adsetProductHistory:{findMany:async()=>f.histories},metaAdset:{update:async({data}:any)=>{f.currentProduct=data.currentProductId;}},
  securityAuditEvent:{create:async({data}:any)=>{f.audits.push(data);return data;}},$queryRaw:async()=>[],
  $transaction:async(fn:any)=>fn(db)};
 f.service=new MappingsService(db);return f;
}
const body={productId:'new',matchType:'CONTAINS',pattern:'케겔',validFrom:'2026-10-28',validTo:null,priority:20,isActive:true,expectedUpdatedAt:stamp.toISOString()};
test('rule edits normalize the new predicate and retain before/after audit',async()=>{
 const f=fixture();await f.service.updateProductRule('rule',{...body,pattern:' 케 겔 '},'actor');
 assert.equal(f.rule.productId,'new');assert.equal(f.rule.priority,20);assert.equal(f.rule.patternKey,'케 겔');
 assert.equal(f.audits[0].beforeJson.productId,'old');assert.equal(f.audits[0].afterJson.productId,'new');
 assert.equal(f.audits[0].afterJson.validFrom,'2026-10-28');
});
test('stale edits, concurrent edits, invalid regex and inverted dates cannot save',async()=>{
 for(const patch of [{expectedUpdatedAt:'old'},{matchType:'REGEX',pattern:'['},{validTo:'2026-10-27'}]){
  const f=fixture();await assert.rejects(()=>f.service.updateProductRule('rule',{...body,...patch},'actor'));assert.equal(f.audits.length,0);
 }
 const f=fixture();f.race=true;await assert.rejects(()=>f.service.updateProductRule('rule',body,'actor'));assert.equal(f.audits.length,0);
});
test('disabling and reactivating preserves the rule ID and records the action',async()=>{
 const f=fixture();await f.service.updateProductRule('rule',{...body,isActive:false},'actor');assert.equal(f.rule.id,'rule');assert.equal(f.audits[0].action,'META_MAPPING_RULE_DEACTIVATED');
 await f.service.updateProductRule('rule',body,'actor');assert.equal(f.rule.isActive,true);
});
test('dated application moves both ad and adset cost attribution without changing money',async()=>{
 const previous=process.env.DAILY_SYNC_FEATURE_ENABLED;process.env.DAILY_SYNC_FEATURE_ENABLED='false';
 try{const f=fixture();f.rule.productId='new';const result=await f.service.applyProductRule('rule',{from:'2026-10-28',to:'2026-10-28'},'actor');
  assert.equal(result.changedAdsets,1);assert.equal(result.changedAds,1);assert.equal(f.ads[0].productId,'new');assert.equal(f.sets[0].productId,'new');assert.equal(f.currentProduct,'new');assert.equal(f.ads[0].spendUsd,'19.23');assert.equal(f.sets[0].spendUsd,'19.23');assert.equal(f.audits[0].action,'META_MAPPING_RULE_APPLIED');
 }finally{if(previous===undefined)delete process.env.DAILY_SYNC_FEATURE_ENABLED;else process.env.DAILY_SYNC_FEATURE_ENABLED=previous;}
});
test('disabled rules release old attribution, and another effective rule can take over',async()=>{
 const previous=process.env.DAILY_SYNC_FEATURE_ENABLED;process.env.DAILY_SYNC_FEATURE_ENABLED='false';
 try{const f=fixture();f.rule.isActive=false;await f.service.applyProductRule('rule',{from:'2026-10-28',to:'2026-10-28'},'actor');
  assert.equal(f.ads[0].productId,null);assert.equal(f.sets[0].productId,null);assert.equal(f.ads[0].productMatchSource,'UNMATCHED');assert.equal(f.currentProduct,null);
  f.fallback={...original,id:'fallback',productId:'replacement'};
  await f.service.applyProductRule('rule',{from:'2026-10-28',to:'2026-10-28'},'actor');
  assert.equal(f.ads[0].productId,'replacement');assert.equal(f.sets[0].productId,'replacement');
 }finally{if(previous===undefined)delete process.env.DAILY_SYNC_FEATURE_ENABLED;else process.env.DAILY_SYNC_FEATURE_ENABLED=previous;}
});
test('manual facts are retained, and unselected API facts are not rewritten',async()=>{
 const previous=process.env.DAILY_SYNC_FEATURE_ENABLED;process.env.DAILY_SYNC_FEATURE_ENABLED='false';
 try{
  const f=fixture();f.sets[0].productMatchSource='MANUAL';f.rule.productId='new';await f.service.applyProductRule('rule',{from:'2026-10-28',to:'2026-10-28'},'actor');assert.equal(f.sets[0].productId,'old');assert.equal(f.ads[0].productId,'old');assert.equal(f.audits.length,0);
  const api=fixture();api.sets[0].source='API';api.ads[0].source='API';api.rule.productId='new';const result=await api.service.applyProductRule('rule',{from:'2026-10-28',to:'2026-10-28'},'actor');assert.equal(result.scannedGroups,0);assert.equal(api.ads[0].productId,'old');
 }finally{if(previous===undefined)delete process.env.DAILY_SYNC_FEATURE_ENABLED;else process.env.DAILY_SYNC_FEATURE_ENABLED=previous;}
});
test('new routes retain mapping-management permission and reject malformed transport',async()=>{
 for(const action of ['updateProductRule','applyProductRule'] as const)assert.deepEqual(Reflect.getMetadata(REQUIRED_PERMISSIONS,MappingsController.prototype[action]),['mappings.manage']);
 assert.ok((await validate(Object.assign(new UpdateProductMappingRuleDto(),{...body,expectedUpdatedAt:'stale'}))).length);
 assert.ok((await validate(Object.assign(new ApplyProductMappingRuleDto(),{from:'2026-10-28',to:'2026-10-27'}))).length);
 await assert.rejects(()=>fixture().service.applyProductRule('rule',{from:'2026-01-01',to:'2026-10-28'},'actor'));
});
