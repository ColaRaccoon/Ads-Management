// Local browser fixture: actual read-only API snapshots and explicit synthetic
// failure/permission/control cases. No provider, remote DB or real login access.
import 'reflect-metadata';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {Module,ValidationPipe} from '@nestjs/common';
import {NestFactory,Reflector} from '@nestjs/core';
import express from 'express';
import {StorefrontController} from '../../../apps/api/src/storefront/storefront.controller';
import {StorefrontReadService,storefrontRange} from '../../../apps/api/src/storefront/storefront-read.service';
import {StorefrontControlService} from '../../../apps/api/src/storefront/storefront-control.service';
import {PermissionGuard} from '../../../apps/api/src/auth/permission.guard';
import {permissionsForRole} from '../../../apps/api/src/auth/role-permissions';
import {ApiExceptionFilter} from '../../../apps/api/src/common/api-exception.filter';
import {StorefrontSummary} from '../../../apps/api/src/storefront/storefront.types';
import {StorefrontQuery,StorefrontEnabledInput} from '../../../apps/api/src/storefront/storefront.dto';
import {ConnectionListQuery,IdParam} from '../../../apps/api/src/daily-sync/daily-sync.dto';
const root='C:/Users/seong/AppData/Local/MetaAdsPhase09Evaluation';
const actual=(phase:string)=>{const candidates=[`${root}/actual${phase}-summary-final-v2.json`,`${root}/actual${phase}-summary-final.json`,`${root}/actual${phase}-summary.json`];const file=candidates.find(existsSync);if(!file)throw Error('actual-proof-missing');const x=JSON.parse(readFileSync(file,'utf8'));if(!x.actual||!x.verified||!x.transactionReadOnly)throw Error('actual-proof');return x.summary as StorefrontSummary;};
let mode='actual07',role:'SUPER_ADMIN'|'ADMIN'|'USER'|'GUEST'|'DENIED'='SUPER_ADMIN';
const currentPermissions=(value:string)=>value==='DENIED'?[]:permissionsForRole(value as any);
const calls:{method:string;path:string;at:string;case:string}[]=[];
const id='f09d0000-0000-4000-8000-000000000001';
let auditCount=0,control={id,provider:'GOOGLE',externalAccountId:'synthetic-account',shopKey:'default',enabled:true,accessState:'READY',credentialRef:'synthetic-reference',credentialExpiresAt:null,updatedAt:new Date('2026-10-19T01:00:00.000Z')};
function summary():StorefrontSummary {
 if(mode==='actual05')return actual('05');
 if(mode==='actual06')return actual('06');
 if(mode==='actual07')return actual('07');
 const s=actual('07');
 s.from=s.to='2026-10-07';s.asOf='2026-10-01T01:00:00.000Z';s.googleCampaigns=[];s.exchangeRates=[];
 s.currencyStatus='ALIGNED';s.missingSources=['CAFE24','META','KAKAO'];
 if(mode==='unconfigured'){s.asOf=null;s.missingSources=['CAFE24','META','GOOGLE','KAKAO'];s.warningCodes=['KAKAO_NOT_CONNECTED'];s.coverage=[];s.connections=[];s.daily=s.daily.map(r=>({...r,revenueKrw:null,metaSpendUsd:null,metaSpendKrw:null,googleSpend:null,googleSpendKrw:null,knownSpendKrw:null,totalSpendKrw:null,complete:false}));s.totals={revenueKrw:null,knownSpendKrw:null,totalSpendKrw:null,mer:null};s.channels=s.channels.map(c=>({...c,amount:null,spendKrw:null,state:'NOT_CONNECTED',complete:false}));return s;}
 s.connections=[{id,provider:'GOOGLE',displayName:'합성 브라우저 검증 계정',externalAccountId:'synthetic-account',currencyCode:'KRW',timeZone:'Asia/Seoul',accessState:control.accessState,enabled:control.enabled,updatedAt:control.updatedAt.toISOString(),credentialExpiresAt:null,reconnectRequired:mode==='reauth',cadenceDays:7,latestAttempt:{id,status:'PARTIAL',at:'2026-10-19T01:00:00.000Z',safeErrorCode:'PARTIAL_PAGE'},lastSuccessAt:s.asOf,completedDates:['2026-10-07'],stale:true}];
 s.coverage=[{connectionId:id,provider:'GOOGLE',account:'synthetic-account',dataKind:'GOOGLE_CAMPAIGN',date:'2026-10-07',currency:'KRW',timeZone:'Asia/Seoul',selectedSource:'API',state:'PARTIAL',lastAttemptAt:'2026-10-19T01:00:00.000Z',lastSuccessAt:s.asOf,lastAttemptStatus:'PARTIAL',lastSuccessRunId:id,rowCount:1,amount:'12345',complete:false,warningCodes:['STALE_DATA','PARTIAL_PAGE']}];
 s.channels=s.channels.map(c=>({...c,amount:c.provider==='GOOGLE'?'12345':null,spendKrw:c.provider==='GOOGLE'?'12345':null,state:c.provider==='GOOGLE'?'PARTIAL':'NOT_CONNECTED',complete:false}));
 s.totals={revenueKrw:null,knownSpendKrw:'12345',totalSpendKrw:null,mer:null};s.warningCodes=['STALE_DATA','PAST_CHANGES_REQUIRE_MANUAL_DAY_RERUN'];
 s.daily=[{date:'2026-10-07',revenueKrw:null,metaSpendUsd:null,metaSpendKrw:null,googleSpend:'12345',googleSpendKrw:'12345',knownSpendKrw:'12345',totalSpendKrw:null,complete:false}];
 s.googleCampaigns=[{connectionId:id,date:'2026-10-07',campaignId:'synthetic-campaign',campaignName:'합성 캠페인',channelType:'SEARCH',costMicros:'12345000000',amount:'12345',currency:'KRW',impressions:'12345678901234567',clicks:'9007199254740993',fetchedAt:s.asOf!}];
 if(mode==='conflict')s.warningCodes.push('SOURCE_SELECTION_REQUIRED');
 return s;
}
const tx:any={$queryRaw:async()=>[{id}],sourceConnection:{findUnique:async()=>control,update:async({data}:any)=>Object.assign(control,data,{updatedAt:new Date(control.updatedAt.getTime()+1)})},syncLease:{findFirst:async()=>null},sourcePolicy:{findMany:async()=>[{id}]},securityAuditEvent:{create:async()=>{auditCount++;return {};}}};
const controlService=new StorefrontControlService({$transaction:async(fn:any)=>fn(tx),sourceConnection:{findUnique:async()=>({id})},syncRun:{findMany:async()=>[{id,fromDate:new Date('2026-10-07'),toDate:new Date('2026-10-07'),trigger:'MANUAL',status:'PARTIAL',startedAt:new Date('2026-10-19T01:00:00Z'),finishedAt:null,safeErrorCode:'PARTIAL_PAGE'}]}} as any);
Reflect.defineMetadata('design:paramtypes',[StorefrontReadService,StorefrontControlService],StorefrontController);
// tsx does not emit TypeScript's design metadata. Bind method DTOs explicitly
// so this local HTTP fixture actually exercises the production ValidationPipe.
for(const method of ['summary','adSpend'])Reflect.defineMetadata('design:paramtypes',[StorefrontQuery],StorefrontController.prototype,method);
Reflect.defineMetadata('design:paramtypes',[IdParam,ConnectionListQuery],StorefrontController.prototype,'runs');
Reflect.defineMetadata('design:paramtypes',[IdParam,StorefrontEnabledInput,Object],StorefrontController.prototype,'enabled');
class Fixture{}
Module({controllers:[StorefrontController],providers:[{provide:StorefrontReadService,useValue:{summary:async(from:string,to:string)=>{storefrontRange(from,to);return summary();}}},{provide:StorefrontControlService,useValue:controlService}]})(Fixture);
async function main(){
 process.env.DAILY_SYNC_FEATURE_ENABLED='true';process.env.DAILY_SYNC_ALLOWED_ACCOUNTS='["GOOGLE/synthetic-account/default"]';
 const app=await NestFactory.create(Fixture,{logger:false});app.setGlobalPrefix('api');
 const http=app.getHttpAdapter().getInstance();http.use(express.json());
 http.use((req:any,_res:any,next:any)=>{calls.push({method:req.method,path:req.path,at:new Date().toISOString(),case:mode});const current=req.headers['x-phase09-role']??role;if(current!=='ANONYMOUS')req.authenticatedUser={id,role:current,permissions:currentPermissions(current)};next();});
 http.post('/__phase09/set',(req:any,res:any)=>{if(req.headers['x-phase09-local']!=='test-only')return res.sendStatus(403);if(!['actual05','actual06','actual07','partial','unconfigured','conflict','reauth'].includes(req.body.case)||!['SUPER_ADMIN','ADMIN','USER','GUEST','DENIED'].includes(req.body.role))return res.sendStatus(400);mode=req.body.case;role=req.body.role;res.json({case:mode,role,syntheticAuth:true});});
 http.get('/__phase09/evidence',(_req:any,res:any)=>res.json({case:mode,role,calls,auditCount,providerRequests:0,remoteWrites:0,syntheticAuth:true}));
 http.get('/api/auth/me',(_req:any,res:any)=>res.json({user:{id,username:'phase09-synthetic',email:null,name:'로컬 합성 권한 검증',role:role==='DENIED'?'USER':role,isActive:true,inviteStatus:'ACTIVE'},permissions:currentPermissions(role),authorizationVersion:role}));
 http.post('/api/auth/refresh',(_req:any,res:any)=>res.json({}));
 http.get('/api/source-coverage/schedule-warnings',(_req:any,res:any)=>res.json({items:[{scheduleKey:'합성 주간 예약',scheduledFor:'2026-10-18T17:02:00Z',status:'EXPIRED',missingDates:['2026-10-16'],warningCode:'MISSING_SCHEDULE'}],history:[],automaticBackfill:false}));
 http.post('/api/sync-runs',(req:any,res:any)=>{if(!currentPermissions(role).includes('imports.manage'))return res.status(403).json({code:'PERMISSION_DENIED',message:'권한 없음'});const b=req.body;if(b.fromDate!==b.toDate||!/^\d{4}-\d\d-\d\d$/.test(b.fromDate)||b.fromDate>='2026-10-19')return res.status(400).json({code:'RUN_LIMIT_EXCEEDED',message:'완료된 하루만 허용'});if(mode==='conflict')return res.status(409).json({code:'SOURCE_SELECTION_REQUIRED',message:'원천 선택 필요'});res.status(202).json({id});});
 http.post(`/api/sync-runs/${id}/execute-google`,(_req:any,res:any)=>res.json({status:'PARTIAL'}));
 http.post('/api/uploads/meta-ad-daily-csv',(_req:any,res:any)=>res.status(409).json({code:'SOURCE_SELECTION_REQUIRED',message:'SOURCE_SELECTION_REQUIRED'}));
 http.post('/api/sales/cafe24/uploads',(_req:any,res:any)=>res.status(409).json({code:'SOURCE_SELECTION_REQUIRED',message:'SOURCE_SELECTION_REQUIRED'}));
 http.get(['/api/uploads','/api/sales/cafe24/uploads','/api/dashboard/trends','/api/metrics/products','/api/sales/cafe24/unmatched'],(_req:any,res:any)=>res.json([]));
 http.get('/api/dashboard/summary',(req:any,res:any)=>res.json({selectedPeriod:{from:req.query.from,to:req.query.to,selectedDays:1,dataDays:0},totals:{},health:{},decisions:{topRecommendations:[],counts:{}},averages:{},comparisons:{}}));
 http.get('/api/dashboard/meta-collection',(_req:any,res:any)=>res.json({mode:'DISABLED',items:[]}));
 http.get('/api/sales/product-performance',(_req:any,res:any)=>res.json({rows:[],summary:{}}));
 http.get('/api/sales/cafe24/coupon-matches',(req:any,res:any)=>res.json({period:req.query,rows:[]}));
 http.get('/api/coupang/dashboard',(req:any,res:any)=>res.json({period:req.query,groupBy:'product',summary:{},rows:[]}));
 app.useGlobalGuards(new PermissionGuard(new Reflector()));app.useGlobalFilters(new ApiExceptionFilter());app.useGlobalPipes(new ValidationPipe({whitelist:true,forbidNonWhitelisted:true,transform:true}));
 await app.listen(4199,'127.0.0.1');
 console.log(JSON.stringify({kind:'PHASE09_LOCAL_BROWSER_FIXTURE',port:4199,actualData:'READONLY_SNAPSHOTS_05_06_07',authentication:'SYNTHETIC_LOCAL',providerRequests:0,remoteWrites:0}));
 for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{writeFileSync(`${root}/browser-fixture-final.json`,JSON.stringify({calls,auditCount,providerRequests:0,remoteWrites:0,syntheticAuth:true},null,2));void app.close().then(()=>process.exit(0));});
}
main().catch(()=>{console.error('PHASE09_BROWSER_FIXTURE_FAILED');process.exitCode=1;});
