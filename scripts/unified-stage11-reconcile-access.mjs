// Generate a column-level source SELECT proposal from the installed Prisma DMMF.
// This command does not connect to a database and does not grant any privilege.
import { Prisma } from '@prisma/client';
import { writeFileSync } from 'node:fs';

const all = '*';
const models = {
  SourceConnection: 'id provider displayName currencyCode timeZone',
  SourcePolicy: all,
  SourceCoverage: all,
  SourceRecordLink: all,
  SyncRun: 'id connectionId',
  RunUnit: all,
  MetaAdsetDailyMetric: 'id metaAdsetId adsetName connectionId source importVersion sourceRevision uploadBatchId syncRunId metricDate spendUsd purchaseValueUsd createdAt updatedAt isCurrent',
  GoogleCampaignDailyCost: 'id campaignId campaignName connectionId source version syncRunId metricDate costMicros conversionValue fetchedAt isCurrent',
  ExchangeRate: 'rate sourceDate provider fallbackType rateDate baseCurrency quoteCurrency',
  Product: 'id displayName isActive',
  ProductCostRule: all,
  Cafe24OrderLine: 'id connectionId source syncRunId uploadBatchId orderLineKey orderNo productNo productName optionName optionValue quantity salePriceKrw totalOrderKrw totalPaidKrw paymentMethod providerCouponSignal actualOrderPriceKrw actualShippingFeeKrw orderDate importVersion validationStatus createdAt providerUpdatedAt sourceRowHash isCurrent matchSource productId cafe24ProductRuleId',
  Cafe24UploadBatch: 'id rowCount importedAt status orderStart orderEnd',
  Cafe24ProductRule: all,
  Cafe24CouponRule: all,
  GooglePerformanceMapping: all,
  Cafe24OrderApiVersion: 'id connectionId canonicalKeyHash version orderDate isCurrent fetchedAt contentFingerprint fingerprintKeyVersion',
  CoupangProduct: 'id standardName displayName isActive',
  CoupangProductRule: 'id coupangProductId displayName includeKeywords excludeKeywords adEnabled isActive validFrom validTo',
  CoupangCostRule: 'id coupangProductId effectiveFrom effectiveTo salePriceKrw productCostKrw sellerShippingFeeKrw hanaroShippingFeeKrw growthInboundFeeKrw growthShippingFeeKrw returnRate returnCostPerUnitKrw extraCostKrw',
  CoupangSalesFeeRule: 'id effectiveFrom effectiveTo salesFeeRate',
  CoupangManualPurchase: 'id productDisplayName ruleDisplayName quantity salesAmountKrw baseSalePriceKrw vendorFeeTotalKrw totalCostKrw saleMethod updatedAt purchaseDate',
  CoupangUploadBatch: 'id status sourceType importedAt',
  CoupangSaleLine: 'id saleLineKey uploadBatchId productName optionName saleMethod salesKrw cancelAmountKrw netSalesKrw salesQuantity orderCount importVersion validationStatus sourceRowHash createdAt isCurrent saleDate',
  CoupangAdMetric: 'id adMetricKey uploadBatchId adExecutionProductName campaignName adGroupName adName adSpendKrw totalConversionSales1dKrw importVersion validationStatus sourceRowHash createdAt isCurrent metricDate',
  UnifiedProduct: all,
  UnifiedRule: all,
};
const metaAds = Object.entries(models).map(([modelName, fields]) => {
  const model = Prisma.dmmf.datamodel.models.find(m => m.name === modelName);
  if (!model) throw Error('MISSING_MODEL:'+modelName);
  const scalars = model.fields.filter(field => field.kind !== 'object');
  const chosen = fields === all ? scalars : fields.split(' ').map(name=> {
    const field = scalars.find(f=>f.name===name);
    if(!field) throw Error(`MISSING_FIELD:${modelName}.${name}`);
    return field;
  });
  return { schema:'meta_ads',table:model.dbName??modelName,columns:[...new Set(chosen.map(field=>field.dbName??field.name))].sort(),
    reason:fields===all?'Current reader selects every Prisma scalar field; narrowing requires source projection changes first.':'Explicit projection plus predicate/order/join columns used by reader.',
    access:'SELECT_ONLY', databaseVerified:false };
});
const publicTables = ['stores','order_items','order_source_signatures','products','canonical_sales_units','sales_unit_cost_settings',
  'sales_unit_cost_snapshots','sales_unit_cost_snapshot_entries','ad_excel_uploads','ad_campaign_daily_costs','daily_fake_purchases',
  'daily_store_summaries','daily_sales_unit_profits','order_sync_states','operations','order_sync_batch_items','order_sync_batches'];
const manifest = { stage:11,kind:'SOURCE_COLUMN_ALLOWLIST_PROPOSAL', databaseConnections:0,databaseWrites:0,
  sourceFiles:['adapters/ad-reader.ts','adapters/cafe24.adapter.ts','adapters/coupang.adapter.ts','adapters/naver-reader.ts','common/source-read-policy.ts','common/meta-source-read-coverage.ts'],
  metaAds,
  naver:publicTables.map(table=>({schema:'public',table,columns:table==='order_sync_batch_items'||table==='order_sync_batches'||table==='operations'?['id','payload']:['id','payload','updated_at'],access:'SELECT_ONLY',databaseVerified:false})),
  forbidden:['source_credentials','commerce_api_credentials','connector_credentials','local_credentials','app_auth_sessions'],
  sourceConnectionForbiddenColumns:['credential_ref','external_account_id'],
  caveats:['No GRANT/REVOKE/RLS changes are executed by this generator.',
    'Verify actual inherited/effective privileges and deny source DML/credential SELECT with real runtime roles before activation.',
    'Naver payload access is limited to listed tables, not arbitrary public schema; reader projects fixed JSON fields.',
    'Do not add Meta ad/adset/catalog/upload tables just because old fixture grants them; current reader does not query them directly.'] };
writeFileSync('docs/product-performance/research/11-data-source-access-proposal.json',JSON.stringify(manifest,null,2)+'\n');
const entries = [...manifest.metaAds,...manifest.naver];
const quote = value => { if (!/^[a-z_][a-z0-9_]*$/.test(value)) throw Error('UNSAFE_FIXED_IDENTIFIER'); return `'${value}'`; };
const rows = entries.map(entry=>`(${quote(entry.schema)},${quote(entry.table)},ARRAY[${entry.columns.map(quote).join(',')}]::text[])`).join(',\n');
const audit = `-- Run as the actual intended worker role in a READ ONLY transaction. Metadata only.
-- Missing tables/columns or privileges block activation. This SQL grants nothing.
WITH required(schema_name,table_name,columns) AS (VALUES
${rows}
)
SELECT current_user AS runtime_role,r.schema_name,r.table_name,c.oid IS NOT NULL AS table_exists,
  CASE WHEN n.oid IS NULL THEN false ELSE has_schema_privilege(current_user,n.oid,'USAGE') END AS schema_usage,
  ARRAY(SELECT col FROM unnest(r.columns) col WHERE NOT EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname=col AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege(current_user,c.oid,a.attnum,'SELECT'))) AS missing_select_columns,
  ARRAY(SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped AND (has_column_privilege(current_user,c.oid,a.attnum,'INSERT') OR has_column_privilege(current_user,c.oid,a.attnum,'UPDATE'))) AS writable_columns,
  CASE WHEN c.oid IS NULL THEN false ELSE has_table_privilege(current_user,c.oid,'DELETE') OR has_table_privilege(current_user,c.oid,'TRUNCATE') END AS can_delete_or_truncate
FROM required r LEFT JOIN pg_namespace n ON n.nspname=r.schema_name
LEFT JOIN pg_class c ON c.relnamespace=n.oid AND c.relname=r.table_name AND c.relkind IN ('r','p','v')
ORDER BY r.schema_name,r.table_name;
`;
writeFileSync('scripts/unified-stage11-reconcile-access.sql',audit);
console.log(JSON.stringify({kind:manifest.kind,metaAdsTables:metaAds.length,naverTables:publicTables.length,databaseConnections:0}));
