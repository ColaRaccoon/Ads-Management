import { PrismaClient } from '@prisma/client';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const target = 'iygjmosbelbosfxidqxv';
const output = resolve('reports/platform-product-mapping-audit-20261103');
const base = new URL(process.env.DATABASE_URL ?? 'invalid:');
if (!base.username.endsWith(`.${target}`) || base.searchParams.get('schema') !== 'meta_ads' || !base.hostname.endsWith('.supabase.com')) throw Error('TARGET_MISMATCH');
const ca = resolve('deploy/cloud/certs/supabase-prod-ca-2021.crt');
if (createHash('sha256').update(readFileSync(ca, 'utf8').replaceAll('\r\n', '\n')).digest('hex') !== '700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7') throw Error('CA_MISMATCH');
const configure = url => {
  for (const key of ['sslcert', 'sslrootcert']) url.searchParams.set(key, ca);
  url.searchParams.set('sslmode', 'verify-full'); url.searchParams.set('sslaccept', 'strict'); url.searchParams.set('connection_limit', '1');
  return url.toString();
};
const naverOnly = process.argv.includes('--naver-catalog');
const password = naverOnly ? process.env.UNIFIED_MAPPING_AUDIT_NAVER_PASSWORD : process.env.UNIFIED_MAPPING_AUDIT_REPORT_PASSWORD;
delete process.env.UNIFIED_MAPPING_AUDIT_NAVER_PASSWORD;
delete process.env.UNIFIED_MAPPING_AUDIT_REPORT_PASSWORD;
if (!password || !/^[a-f0-9]{64}$/i.test(password)) throw Error('REPORT_CREDENTIAL_MISSING');
const reportUrl = new URL(base); reportUrl.username = `${naverOnly ? "meta_ads_unified_worker" : "meta_ads_unified_report"}.${target}`; reportUrl.password = password;
const report = new PrismaClient({ datasources: { db: { url: configure(reportUrl) } }, log: [] });
const source = new PrismaClient({ datasources: { db: { url: configure(base) } }, log: [] });
const read = (db, work) => db.$transaction(async tx => {
  await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
  await tx.$executeRawUnsafe("SET LOCAL statement_timeout='40s'");
  return work(tx);
}, { isolationLevel: 'RepeatableRead', timeout: 55000 });
const identity = tx => tx.$queryRawUnsafe("SELECT now()::text observed_at,current_setting('transaction_read_only') read_only,current_database() database,current_user role");
try {
  if (naverOnly) {
    const inventory = await read(report, async tx => ({
      identity: await identity(tx),
      stores: await tx.$queryRawUnsafe(`SELECT id,payload->>'name' name,payload->>'storeName' store_name,payload->>'platformType' platform_type FROM public.stores WHERE id IN ('5ba1d3cf-7aee-4cd1-aecd-d44352f665dd','78f8cb08-ffe3-481a-94d7-be87ae93ed79')`),
      catalog: await tx.$queryRawUnsafe(`SELECT 'NAVER_UNIT' platform,u.id::text source_ref,u.payload->>'displayName' original_name,
        u.payload->>'displayName' display_name,u.payload->>'isActive'='true' active,parent.payload->>'displayName' parent_name,u.payload->>'storeId' scope_key,
        u.payload->>'isGroup' is_group,coalesce(u.payload->>'isStoreLevel','false') store_level
        FROM public.canonical_sales_units u LEFT JOIN public.canonical_sales_units parent ON parent.id=u.payload->>'parentSalesUnitId'
        WHERE u.payload->>'storeId' IN ('5ba1d3cf-7aee-4cd1-aecd-d44352f665dd','78f8cb08-ffe3-481a-94d7-be87ae93ed79') ORDER BY 4`)
    }));
    mkdirSync(output, { recursive: true });
    const file = resolve(output, 'live-naver-catalog.json');
    writeFileSync(file, JSON.stringify({ projectRef: target, businessWrites: 0, transactionReadOnly: true, inventory }, null, 2), { flag: 'wx' });
    console.log(JSON.stringify({ status: 'PASS', readOnly: true, file, products: inventory.catalog.length }));
  } else {
  const unified = await read(report, async tx => ({
    identity: await identity(tx),
    products: await tx.unifiedProduct.findMany({ orderBy: { canonicalName: 'asc' } }),
    rules: await tx.unifiedRule.findMany({ orderBy: { id: 'asc' } }),
    publicationCoverage: await tx.$queryRawUnsafe(`SELECT platform,scope_key,min(business_date)::text first_date,max(business_date)::text last_date,count(*)::int days
      FROM meta_ads.unified_source_publications GROUP BY 1,2 ORDER BY 1,2`),
    nativeProducts: await tx.$queryRawUnsafe(`SELECT p.platform,p.scope_key,f.payload->'nativeResult'->>'group' source_group,
      f.payload->'nativeResult'->>'productKey' source_product_key,
      COALESCE(f.payload->'nativeResult'->'audit'->>'sourceProductName',f.product_name) source_name,f.product_name published_name,
      min(p.business_date)::text first_date,max(p.business_date)::text last_date,count(*)::int published_days,
      sum((f.payload->'nativeResult'->'revenue'->>'known')::numeric)::text revenue,
      sum((f.payload->'nativeResult'->'adSpend'->>'known')::numeric)::text ad_spend,
      sum((f.payload->'nativeResult'->'netProfit'->>'known')::numeric)::text net_profit,
      bool_or(f.payload->'nativeResult'->'audit'->>'isStoreLevel'='true') store_level
      FROM meta_ads.unified_source_publications p JOIN meta_ads.unified_daily_facts f ON f.run_id=p.run_id
      WHERE f.component='NATIVE_RESULT' AND f.payload->'nativeResult'->>'kind'='PRODUCT'
      GROUP BY 1,2,3,4,5,6 ORDER BY 1,2,5`),
    unassignedNativeResults: await tx.$queryRawUnsafe(`SELECT p.platform,count(*)::int rows FROM meta_ads.unified_source_publications p
      JOIN meta_ads.unified_daily_facts f ON f.run_id=p.run_id WHERE f.component='NATIVE_RESULT'
      AND f.payload->'nativeResult'->>'kind'='PRODUCT' AND f.product_name IS NULL GROUP BY 1 ORDER BY 1`)
  }));
  const sources = await read(source, async tx => {
    const privileges = await tx.$queryRawUnsafe(`SELECT has_table_privilege(current_user,'public.canonical_sales_units','SELECT') naver_catalog_access`);
    const catalog = await tx.$queryRawUnsafe(`SELECT 'META_CAFE24' platform,p.id::text source_ref,p.name original_name,p.display_name,p.is_active active,NULL::text parent_name,NULL::text scope_key
      FROM meta_ads.products p UNION ALL SELECT 'COUPANG',p.id::text,p.standard_name,p.display_name,p.is_active,g.display_name,'LEGACY_COUPANG_SINGLE_UPLOAD'
      FROM meta_ads.coupang_products p LEFT JOIN meta_ads.coupang_product_groups g ON g.id=p.group_id ORDER BY 1,4`);
    const naverCatalog = privileges[0].naver_catalog_access ? await tx.$queryRawUnsafe(`SELECT 'NAVER_UNIT' platform,u.id::text source_ref,u.payload->>'displayName' original_name,
      u.payload->>'displayName' display_name,u.payload->>'isActive'='true' active,parent.payload->>'displayName' parent_name,u.payload->>'storeId' scope_key
      FROM public.canonical_sales_units u LEFT JOIN public.canonical_sales_units parent ON parent.id=u.payload->>'parentSalesUnitId'
      WHERE u.payload->>'storeId' IN ('5ba1d3cf-7aee-4cd1-aecd-d44352f665dd','78f8cb08-ffe3-481a-94d7-be87ae93ed79')
      AND coalesce(u.payload->>'isStoreLevel','false')<>'true' ORDER BY 4`) : [];
    return { identity: await identity(tx), privileges, catalog: [...catalog, ...naverCatalog],
      connections: await tx.sourceConnection.findMany({ select: { id: true, provider: true, displayName: true } }) };
  });
  mkdirSync(output, { recursive: true });
  const file = resolve(output, 'live-inventory.json');
  writeFileSync(file, JSON.stringify({ projectRef: target, businessWrites: 0, transactionReadOnly: true,
    observedAt: new Date().toISOString(), unified, sources }, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ status: 'PASS', projectRef: target, readOnly: true, businessWrites: 0, file,
    unifiedProducts: unified.products.length, nativeProductIdentities: unified.nativeProducts.length,
    sourceCatalogProducts: sources.catalog.length, naverCatalogAccess: sources.privileges[0].naver_catalog_access }));
  }
} catch (error) {
  console.log(JSON.stringify({ status: 'FAILED', code: error.code ?? null, postgresCode: error.meta?.code ?? null,
    diagnostic: String(error.meta?.message ?? '').match(/(?:permission denied for|relation|column|schema)[^\n]{0,180}/i)?.[0] ?? 'AUDIT_QUERY_FAILED' }));
  process.exitCode = 1;
} finally { await report.$disconnect(); await source.$disconnect(); }
