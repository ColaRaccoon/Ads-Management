import { PrismaClient } from '@prisma/client';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
const base = new URL(process.env.DATABASE_URL); if (!base.username.endsWith('.iygjmosbelbosfxidqxv')) throw Error('TARGET');
const ca=resolve('deploy/cloud/certs/supabase-prod-ca-2021.crt');
if(createHash('sha256').update(readFileSync(ca,'utf8').replaceAll('\r\n','\n')).digest('hex')!=='700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7')throw Error('CA');
function client(role,password){const u=new URL(base);if(role){u.username=`${role}.iygjmosbelbosfxidqxv`;u.password=password;}for(const k of ['sslcert','sslrootcert'])u.searchParams.set(k,ca);u.searchParams.set('sslmode','verify-full');u.searchParams.set('sslaccept','strict');u.searchParams.set('connection_limit','1');return new PrismaClient({datasourceUrl:u.toString(),log:[]});}
const report=client('meta_ads_unified_report',process.env.MAPPING_REPORT_PASSWORD),worker=client('meta_ads_unified_worker',process.env.MAPPING_WORKER_PASSWORD),source=client();
delete process.env.MAPPING_REPORT_PASSWORD;delete process.env.MAPPING_WORKER_PASSWORD;
const read=(db,fn)=>db.$transaction(async tx=>{await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');return fn(tx);},{timeout:30000});
let stage="source_catalog";
try {
 const catalog=await read(source,async tx=>({
  products:await tx.$queryRawUnsafe(`SELECT p.id,p.standard_name,p.display_name,g.display_name group_name FROM meta_ads.coupang_products p LEFT JOIN meta_ads.coupang_product_groups g ON g.id=p.group_id WHERE p.display_name~*'양말|슬라이드|퍼슬|자이로|아이언' ORDER BY p.display_name`),
  rules:await tx.$queryRawUnsafe(`SELECT p.display_name product,r.display_name rule_name,r.include_keywords,r.exclude_keywords FROM meta_ads.coupang_product_rules r JOIN meta_ads.coupang_products p ON p.id=r.coupang_product_id WHERE p.display_name~*'양말|슬라이드|퍼슬|아이언' AND r.is_active ORDER BY p.display_name`),
  sales:await tx.$queryRawUnsafe(`SELECT p.display_name assigned_product,l.product_name,l.option_name,count(*)::int rows,min(l.sale_date)::text first_date,max(l.sale_date)::text last_date,sum(l.sales_krw)::text revenue,sum(l.sales_krw) FILTER(WHERE l.sale_date='2026-11-02')::text revenue_nov2 FROM meta_ads.coupang_sale_lines l LEFT JOIN meta_ads.coupang_products p ON p.id=l.coupang_product_id WHERE l.is_current AND (l.product_name~*'양말|슬라이드|퍼슬|풀메탈' OR p.display_name~*'양말|슬라이드|퍼슬') GROUP BY 1,2,3 ORDER BY 1,2,3`)
 }));
 stage="published_results";
 const native=await read(report,tx=>tx.$queryRawUnsafe(`SELECT p.platform,p.scope_key,p.business_date::text date,f.product_name,f.payload->'nativeResult' result FROM meta_ads.unified_source_publications p JOIN meta_ads.unified_daily_facts f ON f.run_id=p.run_id WHERE p.business_date='2026-11-02' AND f.component='NATIVE_RESULT' AND f.product_name~*'양말|슬라이드|퍼슬|자이로|아이언' ORDER BY p.platform,f.product_name`));
 stage="naver_options";
 const naver=await read(worker,async tx=>({
  units:await tx.$queryRawUnsafe(`SELECT u.id,u.payload->>'storeId' store_id,u.payload->>'displayName' name,u.payload->>'parentSalesUnitId' parent_id,parent.payload->>'displayName' parent_name FROM public.canonical_sales_units u LEFT JOIN public.canonical_sales_units parent ON parent.id=u.payload->>'parentSalesUnitId' WHERE u.payload->>'displayName'~'자이로|아이언|풀메탈' ORDER BY 3`),
  stored:await tx.$queryRawUnsafe(`SELECT id,payload->>'date' date,payload->>'canonicalSalesUnitId' unit_id,payload->>'displayName' name,payload->>'parentSalesUnitId' parent_id,payload->>'totalQuantity' quantity,payload->>'totalProductRevenue' revenue,payload->>'totalAdCost' ads,payload->>'estimatedNetProfit' net_profit,payload->'childRows' children FROM public.daily_sales_unit_profits WHERE payload->>'date'='2026-11-02' AND (payload->>'displayName'~'자이로|아이언|풀메탈' OR payload->>'canonicalSalesUnitId' IN(SELECT id FROM public.canonical_sales_units WHERE payload->>'displayName'~'풀메탈'))`)
 }));
 mkdirSync('reports/platform-product-mapping-audit-20261103',{recursive:true});const file='reports/platform-product-mapping-audit-20261103/targeted-diagnosis.json';writeFileSync(file,JSON.stringify({observedAt:new Date().toISOString(),sourceWrites:0,catalog,native,naver},null,2));console.log(JSON.stringify({status:'PASS',file,products:catalog.products.length,salesGroups:catalog.sales.length,naverUnits:naver.units.length,naverStoredRows:naver.stored.length}));
}catch(e){console.log(JSON.stringify({status:'FAILED',stage,errorClass:e.constructor?.name,serialization:/BigInt/.test(e.message??''),serverDiagnostics:String(e.message??'').match(/(?:FATAL|ERROR|Database error|DETAIL|PANIC)[^\n]{0,240}/g),typeFailure:String(e.message??'').match(/Cannot read properties[^\n]{0,120}|Do not know how to serialize[^\n]{0,90}|Transaction[^\n]{0,90}/)?.[0],frames:String(e.stack??'').split('\n').slice(1,3),code:e.code,databaseCode:e.meta?.code,diagnostic:String(e.meta?.message??'').match(/(?:permission denied for|column|relation)[^\n]{0,150}/i)?.[0]}));process.exitCode=1;}finally{await report.$disconnect();await worker.$disconnect();await source.$disconnect();}
