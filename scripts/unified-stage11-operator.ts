import 'reflect-metadata';
import assert from 'node:assert/strict';
import { readFileSync,writeFileSync } from 'node:fs';
import { UnifiedRuntimePrisma } from '../apps/api/src/unified-performance/runtime-prisma';
import { UnifiedManagementRepository } from '../apps/api/src/unified-performance/management.repository';
import { UnifiedManagementService,configurationRule } from '../apps/api/src/unified-performance/management.service';
import { UnifiedReportRepository } from '../apps/api/src/unified-performance/report.repository';
import { UnifiedReportService } from '../apps/api/src/unified-performance/report.service';
import { UnifiedAggregationRepository } from '../apps/api/src/unified-performance/aggregation.repository';
import { permissionsForRole } from '../apps/api/src/auth/role-permissions';
import type { PrismaService } from '../apps/api/src/common/prisma.service';
import { CONTRACT_VERSION } from '../apps/api/src/unified-performance/types';

async function main(){
 const args=Object.fromEntries(process.argv.slice(2).map(arg=>{const m=/^--([a-z-]+)=(.+)$/.exec(arg);if(!m)throw Error('OPERATOR_ARGUMENT_INVALID');return [m[1],m[2]];}));
 if(Object.keys(args).some(key=>!['action','from','to','key','scope','platform'].includes(key))||!['bootstrap','queue','inspect','queue-naver','inspect-naver','queue-platform','inspect-platform'].includes(args.action))throw Error('OPERATOR_ACTION_REQUIRED');
 if(args.key&&!/^[a-z0-9-]{1,96}$/i.test(args.key))throw Error('SAFE_REQUEST_KEY_REQUIRED');
 const naver=args.action.endsWith('-naver');
 const otherPlatform=args.action.endsWith('-platform');
 const representativeScopes={META:'2155a401-bd86-4111-9280-3c95ed207546',GOOGLE:'21b811a6-b9d7-44f5-8167-ce40198947b5',COUPANG:'LEGACY_COUPANG_SINGLE_UPLOAD'};
 if(naver){assert(['5ba1d3cf-7aee-4cd1-aecd-d44352f665dd','78f8cb08-ffe3-481a-94d7-be87ae93ed79'].includes(args.scope));assert.equal(args.from,'2026-10-26');assert.equal(args.to,'2026-10-26');}
 else if(otherPlatform){assert(Object.hasOwn(representativeScopes,args.platform));assert.equal(args.scope,representativeScopes[args.platform as keyof typeof representativeScopes]);assert.equal(args.from,'2026-10-28');assert.equal(args.to,'2026-10-28');}
 else assert.equal(args.scope,undefined,'Cafe24 maintenance scope is fixed');
 if(!otherPlatform)assert.equal(args.platform,undefined);
 const platform=naver?'NAVER':otherPlatform?args.platform as keyof typeof representativeScopes:'CAFE24',scopeKey=naver||otherPlatform?args.scope:'be140e7e-3994-406e-94ff-b50dfc7ac7b2';
 assert.equal(JSON.parse(readFileSync('docs/product-performance/research/11-runtime-role-check.json','utf8')).status,'PASS','Actual restricted-role checks must pass first');
 const operator=JSON.parse(readFileSync('docs/product-performance/research/11-operator-identity.json','utf8')).rows;
 assert(!Array.isArray(operator)&&operator.is_active&&operator.role==='SUPER_ADMIN');
 const actor={id:operator.id,permissions:permissionsForRole(operator.role)};
 process.env.UNIFIED_PERFORMANCE_ENABLED='true';
 process.env.UNIFIED_NAVER_ALLOWED_STORE_IDS='5ba1d3cf-7aee-4cd1-aecd-d44352f665dd,78f8cb08-ffe3-481a-94d7-be87ae93ed79';
 const client=new UnifiedRuntimePrisma(),prisma=client as unknown as PrismaService;
 const management=new UnifiedManagementRepository(prisma),configuration=new UnifiedManagementService(management);
 const jobs=new UnifiedAggregationRepository(prisma),reports=new UnifiedReportService(new UnifiedReportRepository(management),jobs);
 const evidence:Record<string,unknown>={stage:11,observedAt:new Date().toISOString(),operation:args.action,sourceWrites:0,
  authBoundary:'CLI maintenance on behalf of the current browser-verified active administrator; not an HTTP authentication test',actorId:actor.id};
 try{
  await client.onModuleInit();
  if(args.action==='bootstrap'){
   evidence.phase='bootstrap catalog precondition';const before=await management.snapshot();
   assert(before.products.length<=1&&before.rules.length<=2,'Bootstrap must not change another catalog');
   const productInput={canonicalName:'풀업바',active:true,reason:'11단계 운영 대표 제품 1개 초기화; 기존 고정 제품명 유지'};
   let product=before.products[0];
   if(product){assert.equal(product.canonicalName,'풀업바');assert.equal(product.active,true);assert.equal(product.version,1);const audits=await client.unifiedMappingAudit.findMany({where:{entityId:product.id}});assert(audits.length===1&&audits[0].actorUserId===actor.id&&audits[0].action==='CREATE'&&audits[0].reason===productInput.reason);}
   else{evidence.phase='product preview';const preview=await configuration.previewProduct(productInput);assert(preview.canSave);evidence.phase='product save';product=(await configuration.saveProduct(productInput,actor)).product;}
   const common={productId:product.id,platform:'CAFE24' as const,scopeKey:'be140e7e-3994-406e-94ff-b50dfc7ac7b2',validFrom:'2026-10-28',active:true};
   const rules=[{...common,kind:'NAME' as const,payload:{matchType:'CONTAINS',terms:['풀업바'],excludeTerms:[],optionInclude:['풀업바'],optionExclude:[],nameField:'product_name',saleUnitName:'풀업바 단품'},reason:'11단계 일반/유튜브 풀업바 Cafe24 판매를 한 번 분류; 기존 광고별 매핑은 보존'},
    {...common,kind:'SALE_UNIT' as const,payload:{saleUnitName:'풀업바 단품',optionInclude:['풀업바(72~97cm)'],unitsPerSaleUnit:'1',quantityBasis:'SALE_UNIT_TOTAL',salePrice:'34900',productCost:'10000',shippingCost:'0',otherCost:'0'},reason:'11단계 10/28 실제 동일 옵션의 등록 가격/원가 복사; 원천 설정 변경 없음'}];
   assert.equal(new Set(before.rules.map(rule=>rule.kind)).size,before.rules.length,'Resume must not accept extra rules of one kind');
   const saved=[];
   for(const input of rules){const existing=before.rules.find(rule=>rule.kind===input.kind);if(existing){const expected=configurationRule(input,'풀업바');for(const key of ['kind','productId','platform','scopeKey','identityKey','active'] as const)assert.equal(existing[key],expected[key]);assert.deepEqual(existing.payload,expected.payload);assert.equal(existing.validFrom.toISOString(),expected.validFrom.toISOString());assert.equal(existing.validTo,null);assert.equal(existing.version,1);const audits=await client.unifiedMappingAudit.findMany({where:{entityId:existing.id}});assert(audits.length===1&&audits[0].actorUserId===actor.id&&audits[0].action==='CREATE'&&audits[0].reason===input.reason);continue;}evidence.phase=`${input.kind} preview`;const preview=await configuration.previewRule(input);assert(preview.canSave);evidence.phase=`${input.kind} save`;saved.push(await configuration.saveRule({...input,expectedConfigurationVersion:preview.versions.configurationVersion},actor));}
   const after=await management.snapshot();evidence.product={id:product.id,canonicalName:product.canonicalName};evidence.rules=after.rules.map(rule=>({id:rule.id,kind:rule.kind,validFrom:rule.validFrom,payload:rule.payload}));evidence.versions=after.versions;evidence.auditCount=await client.unifiedMappingAudit.count();
  }else if(args.action==='queue'||args.action==='queue-naver'||args.action==='queue-platform'){
   if(!args.from||!args.to||!args.key)throw Error('EXPLICIT_QUEUE_RANGE_KEY_REQUIRED');
   evidence.request={from:args.from,to:args.to,platforms:[platform],scopeKeys:[scopeKey],productNames:naver||otherPlatform?[]:['풀업바']};
   evidence.result=await reports.rebuild({...evidence.request as object,reason:naver?'11단계 허용 스토어 저장 추정 입력과 선택 합계 검증; 원천·수집 설정 변경 없음':'11단계 대표 계정/기간의 제한 백필 및 원천 대조',expectedContractVersion:CONTRACT_VERSION,idempotencyKey:args.key},actor);
  }else{
   const from=args.from??'2026-10-28',to=args.to??from;
   const input={from,to,compareFrom:from,compareTo:to,platforms:[platform],scopeKeys:[scopeKey],...(naver||otherPlatform?{}:{productName:'풀업바'})};
   const report=await reports.read('summary',input,actor) as any;
   evidence.summary={selection:report.selection,knownTotals:report.knownTotals,completeTotals:report.completeTotals,scopeBalances:report.scopeBalances,coverage:report.coverage,warnings:report.warnings,items:report.items,publishedRunIdsBySource:report.publishedRunIdsBySource};
   evidence.jobs=await client.unifiedAggregationRun.findMany({where:{platform,scopeKey,businessDate:{gte:new Date(from+'T00:00:00Z'),lte:new Date(to+'T00:00:00Z')}},select:{id:true,platform:true,businessDate:true,status:true,attempts:true,issues:true,publishedAt:true},orderBy:{startedAt:'desc'},take:100});
  }
  evidence.status='PASS';
 }catch(error){evidence.status='FAIL';evidence.errorCode=(error as any).code??'OPERATOR_FAILED';evidence.databaseCode=(error as any).meta?.code??null;const response=(error as any).getResponse?.();if(response)evidence.applicationError=response;const message=String((error as any).message??'');evidence.errorClass=(error as any).constructor?.name;evidence.permissionDenied=/permission denied/i.test(message);evidence.permissionObject=message.match(/permission denied for (?:schema|table|function) ["']?([a-z0-9_]+)/i)?.[1]??null;process.exitCode=1;}
 finally{try{await client.onModuleDestroy();}catch{evidence.status='FAIL';evidence.cleanupError='RESTRICTED_CLIENT_DISCONNECT_FAILED';process.exitCode=1;}writeFileSync(`docs/product-performance/research/11-operator-${args.action}${args.key?'-'+args.key:''}.json`,JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify({status:evidence.status,operation:args.action,sourceWrites:0}));}
}
main().catch(()=>{console.error('STAGE11_OPERATOR_INPUT_FAILED');process.exitCode=1;});
