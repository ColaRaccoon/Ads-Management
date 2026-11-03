/** Explicit user-approved identity migration. Does not read or update source orders, ads or costs. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaClient, Prisma } from '@prisma/client';
const require = createRequire(import.meta.url);
const { UnifiedManagementRepository, managementVersions } = require('../apps/api/dist/unified-performance/management.repository.js');
const { UnifiedManagementService, configurationRule, ruleName } = require('../apps/api/dist/unified-performance/management.service.js');
const { mapNativeProducts } = require('../apps/api/dist/unified-performance/domain/native-product-mapping.js');
const { permissionsForRole } = require('../apps/api/dist/auth/role-permissions.js');
const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const json = value => JSON.parse(JSON.stringify(value));
const day = value => value.toISOString().slice(0, 10);
const params = Object.fromEntries(process.argv.slice(2).map(arg => { const i = arg.indexOf('='); assert(i > 2); return [arg.slice(2, i), arg.slice(i + 1)]; }));
assert(Object.keys(params).every(key => ['action', 'plan-sha', 'limit'].includes(key)));
assert(['preflight', 'trial', 'apply', 'replay', 'verify'].includes(params.action));
const planPath = 'docs/product-performance/approved/platform-product-corrections-20261103.json';
const planText = readFileSync(planPath, 'utf8').replaceAll('\r\n', '\n');
const planHash = digest(planText); assert.equal(params['plan-sha'], planHash);
const plan = JSON.parse(planText); assert.equal(plan.targetProject, 'iygjmosbelbosfxidqxv'); assert.equal(plan.links.length, 7);
const dir = 'reports/platform-product-mapping-audit-20261103/corrections'; mkdirSync(dir, { recursive: true });
const stateFile = `${dir}/mapping-state.json`;
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { planHash, rules: [], replays: [], sourceWrites: 0 };
assert.equal(state.planHash, planHash);
const persist = () => writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n');
const base = new URL(process.env.DATABASE_URL ?? 'invalid:');
assert(base.username.endsWith('.iygjmosbelbosfxidqxv') && base.hostname === 'aws-1-ap-northeast-2.pooler.supabase.com');
assert.equal(base.searchParams.get('schema'), 'meta_ads');
const ca = resolve('deploy/cloud/certs/supabase-prod-ca-2021.crt');
assert.equal(digest(readFileSync(ca, 'utf8').replaceAll('\r\n', '\n')), '700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7');
function url(role, password) {
  const u = new URL(base); if (role) { assert(/^[a-f0-9]{64}$/i.test(password ?? '')); u.username = `${role}.iygjmosbelbosfxidqxv`; u.password = password; }
  for (const key of ['sslcert', 'sslrootcert']) u.searchParams.set(key, ca);
  u.searchParams.set('sslmode', 'verify-full'); u.searchParams.set('sslaccept', 'strict'); u.searchParams.set('connection_limit', '1'); return u.toString();
}
const report = new PrismaClient({ datasourceUrl: url('meta_ads_unified_report', process.env.MAPPING_REPORT_PASSWORD), log: [] });
const worker = new PrismaClient({ datasourceUrl: url('meta_ads_unified_worker', process.env.MAPPING_WORKER_PASSWORD), log: [] });
const source = new PrismaClient({ datasourceUrl: url(), log: [] });
delete process.env.MAPPING_REPORT_PASSWORD; delete process.env.MAPPING_WORKER_PASSWORD;
process.env.UNIFIED_PERFORMANCE_ENABLED = 'true';
process.env.UNIFIED_NAVER_ALLOWED_STORE_IDS = '5ba1d3cf-7aee-4cd1-aecd-d44352f665dd,78f8cb08-ffe3-481a-94d7-be87ae93ed79';
const management = new UnifiedManagementRepository(report), service = new UnifiedManagementService(management);
const reason = '2026-11-03 사용자 확인: 쿠팡 스포츠양말 전 규격은 러닝양말, 퍼펙트슬라이드 프로는 기본형에 합산, 네이버 자이로볼 풀메탈 옵션만 아이언볼. 공통 광고비 원래 부모에 유지.';
const { naverQueries } = require('../apps/api/dist/unified-performance/adapters/naver-reader.js');
const { prepareNativeResultFacts } = require('../apps/api/dist/unified-performance/domain/stored-result-projection.js');
const { decimal, quantizeMoney } = require('../apps/api/dist/unified-performance/domain/decimal.js');
const sameRule = (rule, link, snapshot) => rule.kind === 'NAME' && rule.active && rule.platform === link.platform && rule.scopeKey === link.scopeKey &&
  rule.payload.nameField === `native:${link.group}` && rule.payload.matchType === 'EXACT' && rule.payload.terms?.length === 1 &&
  rule.payload.terms[0] === link.sourceName.normalize('NFC').trim().toLowerCase() && day(rule.validFrom) === link.validFrom && rule.validTo === null &&
  snapshot.products.find(product => product.id === rule.productId)?.canonicalName === link.targetName;
async function checkBaseline(snapshot) {
  assert(state.baseline, 'PREFLIGHT_REQUIRED');
  assert.deepEqual(json(snapshot.products), state.baseline.products, 'PRODUCT_CATALOG_CHANGED');
  for (const before of state.baseline.rules) {
    if (plan.links.some(link => link.ruleId === before.id)) continue;
    assert.deepEqual(json(snapshot.rules.find(rule => rule.id === before.id)), before, 'UNRELATED_RULE_CHANGED');
  }
  for (const rule of snapshot.rules.filter(rule => !state.baseline.rules.some(before => before.id === rule.id)))
    assert(plan.links.some(link => sameRule(rule, link, snapshot)), 'UNRELATED_RULE_ADDED');
}
async function publications(client) { return client.unifiedSourcePublication.findMany({ where: { businessDate: { lte: new Date(plan.through) } }, orderBy: [{ businessDate: 'desc' }, { platform: 'asc' }, { scopeKey: 'asc' }] }); }
const moneyKeys = ['revenue','adSpend','netProfit','profitBeforeAds'];
const eq = (a,b) => a === null || b === null ? a === b : decimal(a).eq(decimal(b));
function conserve(before, after) {
  const summaries = rows => rows.filter(row => row.kind === 'SUMMARY');
  assert.deepEqual(summaries(after), summaries(before), 'SUMMARY_CHANGED');
  for (const group of new Set(before.map(row => row.group))) {
    const b = before.filter(row => row.kind === 'PRODUCT' && row.group === group), a = after.filter(row => row.kind === 'PRODUCT' && row.group === group);
    for (const key of ['quantity', ...moneyKeys.flatMap(key => [`${key}.known`,`${key}.complete`])]) {
      const value = row => key === 'quantity' ? row.quantity : row[key.split('.')[0]][key.split('.')[1]];
      const total = rows => rows.map(value).filter(v => v !== null).reduce((sum,v) => sum.plus(decimal(v)), decimal('0')).toFixed();
      assert(eq(total(b), total(a)), `NATIVE_${key.toUpperCase().replace('.','_')}_TOTAL_CHANGED`);
      assert.equal(b.some(row => value(row) === null), a.some(row => value(row) === null), 'NATIVE_NULL_AVAILABILITY_CHANGED');
    }
  }
}
async function hydrateOptions(tx, rows, pointer) {
  if (pointer.platform !== 'NAVER' || pointer.scopeKey !== plan.optionStore) return rows;
  const stored = await tx.$queryRaw(naverQueries(pointer.scopeKey, day(pointer.businessDate)).daily_sales_unit_profits);
  return rows.map(row => {
    if (row.kind !== 'PRODUCT' || row.audit?.optionParentProductKey || !row.productKey.endsWith(`:product:${plan.optionParentId}`)) return row;
    const source = stored.find(value => value.canonicalSalesUnitId === plan.optionParentId && !value.parentSalesUnitId);
    assert(source, 'OPTION_SOURCE_PARENT_MISSING');
    const basis = row.optionBasis ?? row;
    for (const [sourceKey,key] of [['totalProductRevenue','revenue'],['totalAdCost','adSpend'],['estimatedNetProfit','netProfit']])
      assert(eq(basis[key].known, source[sourceKey]), 'OPTION_SOURCE_PARENT_CHANGED');
    assert(eq(basis.quantity, source.totalQuantity), 'OPTION_SOURCE_QUANTITY_CHANGED');
    const children = source.childRows ?? [];
    const sourceOptions = children.map(child => {
      assert.equal(child.date, day(pointer.businessDate), 'OPTION_SOURCE_DATE_CHANGED');
      assert(child.canonicalSalesUnitId && child.displayName, 'OPTION_SOURCE_IDENTITY_MISSING');
      const amount = value => ({known:value,complete:value});
      return { key: child.canonicalSalesUnitId, name: child.displayName, quantity: child.totalQuantity,
        revenue: amount(child.totalProductRevenue), adSpend: amount(child.totalAdCost), netProfit: amount(child.estimatedNetProfit),
        profitBeforeAds: amount(child.estimatedNetProfit === null || child.totalAdCost === null ? null : decimal(child.estimatedNetProfit).plus(child.totalAdCost).toFixed()) };
    });
    assert.equal(new Set(sourceOptions.map(option => option.key)).size, sourceOptions.length, 'OPTION_DUPLICATE');
    if (children.length) {
      for (const key of ['quantity','revenue']) {
        const values = sourceOptions.map(option => key === 'quantity' ? option.quantity : option.revenue.known);
        assert(values.every(value => value !== null), 'OPTION_SOURCE_UNKNOWN');
        assert(eq(values.reduce((sum,value) => sum.plus(decimal(value)), decimal('0')).toFixed(), key === 'quantity' ? basis.quantity : basis.revenue.known), 'OPTION_SOURCE_TOTAL_MISMATCH');
      }
    }
    return {...row, sourceOptions};
  });
}
async function replay(pointer, snapshot, actor, dryRun = false) {
  return worker.$transaction(async tx => {
    const partition = { platform: pointer.platform, scopeKey: pointer.scopeKey, date: day(pointer.businessDate) };
    await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(21408,hashtext(${JSON.stringify(partition)}))::text`);
    await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(21407,2)::text`);
    const current = await tx.unifiedSourcePublication.findUniqueOrThrow({ where: { sourceSystem_platform_scopeKey_businessDate: {
      sourceSystem: pointer.sourceSystem, platform: pointer.platform, scopeKey: pointer.scopeKey, businessDate: pointer.businessDate } } });
    const before = await tx.unifiedAggregationRun.findUniqueOrThrow({ where: { id: current.runId } });
    if (before.checkpoint?.mappingPlanHash === planHash && before.versions.nameRuleVersion === snapshot.versions.nameRuleVersion) return { status: 'ALREADY_APPLIED', date: partition.date, platform: partition.platform, runId: before.id };
    const running = await tx.unifiedAggregationRun.findFirst({ where: { sourceSystem: pointer.sourceSystem, platform: pointer.platform,
      scopeKey: pointer.scopeKey, businessDate: pointer.businessDate, status: 'STAGING', leaseExpiresAt: { gt: new Date() } }, select: { id: true } });
    if (running) return { status: 'ACTIVE_SOURCE_WORKER', ...partition };
    const currentConfig = await new UnifiedManagementRepository(tx).snapshot(tx);
    assert.equal(currentConfig.versions.configurationVersion, snapshot.versions.configurationVersion, 'CONFIGURATION_CHANGED');
    const facts = await tx.unifiedDailyFact.findMany({ where: { runId: before.id, component: 'NATIVE_RESULT' }, select: { id: true, productName: true, attribution: true, payload: true } });
    const rules = snapshot.rules.filter(rule => rule.kind === 'NAME').map(rule => ruleName(rule, snapshot.products.find(product => product.id === rule.productId).canonicalName));
    const originals = facts.map(fact => { assert(fact.payload.nativeResult, 'NATIVE_PAYLOAD_MISSING'); return fact.payload.nativeResult; });
    const hydrated = await hydrateOptions(tx, originals, pointer);
    const mapped = mapNativeProducts(hydrated, pointer.scopeKey, partition.date, snapshot.products, rules, snapshot.versions.nameRuleVersion);
    conserve(originals, mapped);
    const replacements = prepareNativeResultFacts(mapped);
    const at = new Date(), id = randomUUID();
    await tx.unifiedAggregationRun.create({ data: {
      id, sourceSystem: before.sourceSystem, platform: before.platform, scopeKey: before.scopeKey, businessDate: before.businessDate,
      status: 'STAGING', requestedBy: actor.id, reason, attempts: 1, contractVersion: before.contractVersion,
      versions: { ...before.versions, nameRuleVersion: snapshot.versions.nameRuleVersion }, readSnapshotId: before.readSnapshotId,
      sourceFingerprint: digest([before.sourceFingerprint, snapshot.versions.nameRuleVersion, planHash]), sourceWatermarks: before.sourceWatermarks,
      controlTotals: before.controlTotals, issues: before.issues, checkpoint: { phase: 'MAPPING_REPLAY', previousRunId: before.id,
        financialSourceRunId: before.checkpoint?.financialSourceRunId ?? before.id, mappingPlanHash: planHash }, startedAt: at
    } });
    const copiedFacts = await tx.$executeRaw(Prisma.sql`INSERT INTO meta_ads.unified_daily_facts
      (id,run_id,component,fact_key,product_name,sale_unit_name,amount_krw,original_amount,currency,quantity,attribution,payload)
      SELECT gen_random_uuid(),${id}::uuid,component,fact_key,product_name,sale_unit_name,amount_krw,original_amount,currency,quantity,attribution,payload
      FROM meta_ads.unified_daily_facts WHERE run_id=${before.id}::uuid AND component<>'NATIVE_RESULT'`);
    if (replacements.length) await tx.unifiedDailyFact.createMany({ data: replacements.map(fact => ({
      id: randomUUID(), runId:id, component:fact.component, factKey:fact.factKey, productName:fact.productName,
      saleUnitName:fact.saleUnitName, amountKrw:fact.amountKrw, originalAmount:fact.originalAmount,
      currency:fact.currency, quantity:fact.quantity, attribution:fact.attribution, payload:json(fact)
    })) });
    await tx.$executeRaw(Prisma.sql`INSERT INTO meta_ads.unified_source_coverage
      (id,run_id,component,participation,collection_state,zero_confirmed,rows_present,source_as_of,is_estimate,details)
      SELECT gen_random_uuid(),${id}::uuid,component,participation,collection_state,zero_confirmed,rows_present,source_as_of,is_estimate,details
      FROM meta_ads.unified_source_coverage WHERE run_id=${before.id}::uuid`);
    await tx.$executeRaw(Prisma.sql`INSERT INTO meta_ads.unified_product_match_results
      (id,run_id,source_key,name_input_hash,rule_version,match_status,product_name,evidence)
      SELECT gen_random_uuid(),${id}::uuid,source_key,name_input_hash,rule_version,match_status,product_name,evidence
      FROM meta_ads.unified_product_match_results WHERE run_id=${before.id}::uuid`);
    const [check] = await tx.$queryRaw(Prisma.sql`WITH source AS (
      SELECT component,fact_key,sale_unit_name,amount_krw,original_amount,currency,quantity,
        CASE WHEN component='NATIVE_RESULT' THEN payload-'productName'-'attribution' #- '{nativeResult,productName}' #- '{nativeResult,audit}' #- '{nativeResult,issues}' ELSE payload END immutable
      FROM meta_ads.unified_daily_facts WHERE run_id=${before.id}::uuid AND component<>'NATIVE_RESULT'), target AS (
      SELECT component,fact_key,sale_unit_name,amount_krw,original_amount,currency,quantity,
        CASE WHEN component='NATIVE_RESULT' THEN payload-'productName'-'attribution' #- '{nativeResult,productName}' #- '{nativeResult,audit}' #- '{nativeResult,issues}' ELSE payload END immutable
      FROM meta_ads.unified_daily_facts WHERE run_id=${id}::uuid AND component<>'NATIVE_RESULT')
      SELECT (SELECT count(*)::int FROM source) source_rows,(SELECT count(*)::int FROM target) target_rows,
        (SELECT count(*)::int FROM ((SELECT * FROM source EXCEPT ALL SELECT * FROM target) UNION ALL (SELECT * FROM target EXCEPT ALL SELECT * FROM source)) differences) financial_differences`);
    assert.equal(check.source_rows, copiedFacts); assert.equal(check.target_rows, copiedFacts); assert.equal(check.financial_differences, 0, 'FINANCIAL_VALUES_CHANGED');
    await tx.unifiedAggregationRun.update({ where: { id }, data: { status: 'READY', completedAt: at } });
    const switched = await tx.unifiedSourcePublication.updateMany({ where: { sourceSystem: pointer.sourceSystem, platform: pointer.platform,
      scopeKey: pointer.scopeKey, businessDate: pointer.businessDate, runId: before.id }, data: { runId: id, revision: { increment: 1 }, updatedAt: at } });
    assert.equal(switched.count, 1, 'PUBLICATION_CHANGED');
    await tx.unifiedAggregationRun.update({ where: { id }, data: { status: 'PUBLISHED', publishedAt: at } });
    const result = { status: 'PUBLISHED', ...partition, runId: id, previousRunId: before.id, copiedFacts, nativeRows: replacements.length, optionRows: mapped.filter(row => row.audit?.optionParentProductKey).length, financialDifferences: 0 };
    if (dryRun) throw Object.assign(new Error('MAPPING_TRIAL_ROLLBACK'), { trialResult: { ...result, status: 'ROLLED_BACK' } });
    return result;
  }, { timeout: 30000 }).catch(error => { if (dryRun && error.trialResult) return error.trialResult; throw error; });
}
try {
  for (const [client, expected] of [[report, 'meta_ads_unified_report'], [worker, 'meta_ads_unified_worker']]) {
    const [role] = await client.$queryRaw`SELECT current_user::text role,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`;
    assert.equal(role.role, expected); assert(!role.rolsuper && !role.rolbypassrls);
  }
  const identity = JSON.parse(readFileSync('docs/product-performance/research/11-products-operator-identity.json', 'utf8')).rows;
  const admin = await source.appUser.findUnique({ where: { id: identity.id }, select: { id: true, role: true, isActive: true } });
  assert(admin?.isActive && admin.role === 'SUPER_ADMIN', 'OPERATOR_INACTIVE');
  const actor = { id: admin.id, permissions: permissionsForRole(admin.role) };
  let snapshot = await management.snapshot();
  if (params.action === 'preflight') {
    assert(!state.appliedAt, 'ALREADY_APPLIED');
    if (state.baseline) assert.deepEqual(json(snapshot), state.baseline, 'BASELINE_CHANGED');
    state.baseline = json(snapshot); state.pointersBefore = await publications(report);
    const history = await worker.$queryRaw`SELECT min(t.payload->>'date') first_date,max(t.payload->>'date') last_date,count(*)::int days
      FROM public.daily_sales_unit_profits t WHERE t.payload->>'storeId'=${plan.optionStore} AND t.payload->>'canonicalSalesUnitId'=${plan.optionParentId}
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(t.payload->'childRows')='array' THEN t.payload->'childRows' ELSE '[]'::jsonb END) c
        WHERE c->>'canonicalSalesUnitId'=${plan.optionId})`;
    state.optionHistory = history; state.preflightAt = new Date().toISOString(); persist();
    console.log(JSON.stringify({status:'PASS',action:'preflight',products:snapshot.products.length,rules:snapshot.rules.length,partitions:state.pointersBefore.length,optionHistory:history}));
  } else {
    await checkBaseline(snapshot);
    const virtual = () => ({...snapshot,rules:[...snapshot.rules.filter(rule => !plan.links.some(link => link.ruleId === rule.id)),...plan.links.map(link => ({id:link.ruleId??randomUUID(),...configurationRule({kind:'NAME',productId:snapshot.products.find(product=>product.canonicalName===link.targetName).id,
      platform:link.platform,scopeKey:link.scopeKey,validFrom:link.validFrom,validTo:null,active:true,payload:{matchType:'EXACT',terms:[link.sourceName],nameField:`native:${link.group}`},reason},link.targetName)}))]});
    if (params.action === 'trial') {
      const results=[];
      for (const platform of ['COUPANG','NAVER']) {
        const pointer=state.pointersBefore.find(pointer=>pointer.platform===platform && day(new Date(pointer.businessDate))===plan.through && (platform!=='NAVER'||pointer.scopeKey===plan.optionStore));
        assert(pointer); pointer.businessDate=new Date(pointer.businessDate); results.push(await replay(pointer,virtual(),actor,true));
      }
      assert(results.every(row=>row.status==='ROLLED_BACK')); state.trial=results; persist(); console.log(JSON.stringify({status:'PASS',action:'trial',results}));
    } else if(params.action === 'apply') {
      assert(state.trial?.length===2, 'TRIAL_REQUIRED');
      for(const link of plan.links) {
        if(snapshot.rules.some(rule=>sameRule(rule,link,snapshot)))continue;
        const before=link.ruleId?snapshot.rules.find(rule=>rule.id===link.ruleId):undefined;
        if(before)assert.equal(snapshot.products.find(product=>product.id===before.productId).canonicalName,link.previousTarget,'PREVIOUS_TARGET_CHANGED');
        const input={kind:'NAME',productId:snapshot.products.find(product=>product.canonicalName===link.targetName).id,
          platform:link.platform,scopeKey:link.scopeKey,validFrom:link.validFrom,validTo:null,active:true,
          payload:{matchType:'EXACT',terms:[link.sourceName],nameField:`native:${link.group}`},reason,...(before?{expectedVersion:before.version}:{})};
        const preview=await service.previewRule({...input,...(before?{id:before.id}:{})}); assert(preview.canSave,'RULE_PREVIEW_CONFLICT');
        const result=await service.saveRule({...input,expectedConfigurationVersion:preview.versions.configurationVersion},actor,before?.id);
        state.rules.push({id:result.rule.id,sourceName:link.sourceName,targetName:link.targetName,action:before?'UPDATE':'CREATE',before:before?json(before):null,after:result.rule});persist(); snapshot=await management.snapshot();
      }
      await checkBaseline(snapshot);assert(plan.links.every(link=>snapshot.rules.some(rule=>sameRule(rule,link,snapshot))));
      state.configurationVersion=snapshot.versions.configurationVersion;state.appliedAt=new Date().toISOString();persist();console.log(JSON.stringify({status:'PASS',action:'apply',saved:state.rules.length,rules:snapshot.rules.length}));
    } else if(params.action==='replay') {
      assert(state.appliedAt,'APPLY_REQUIRED');assert.equal(snapshot.versions.configurationVersion,state.configurationVersion,'CONFIGURATION_CHANGED');
      const pointers=await publications(worker),limit=Number(params.limit??'2000');let processed=0,already=0;
      for(const pointer of pointers) {
        if(state.replays.some(result=>result.runId===pointer.runId&&result.status==='PUBLISHED')){already++;continue;}
        const result=await replay(pointer,snapshot,actor);if(result.status!=='ALREADY_APPLIED')state.replays.push(result);persist();processed++;
        if(processed%25===0)console.log(JSON.stringify({action:'replay',processed,already,total:pointers.length}));if(processed>=limit)break;
      }
      console.log(JSON.stringify({status:'PASS',action:'replay',processed,already,total:pointers.length}));
    } else if(params.action==='verify') {
      const pointers=await publications(report);
      const runs=await report.unifiedAggregationRun.findMany({where:{id:{in:pointers.map(pointer=>pointer.runId)}},select:{versions:true}});
      const stale=runs.filter(run=>run.versions.nameRuleVersion!==snapshot.versions.nameRuleVersion).length;
      const totals=await report.$queryRaw`SELECT p.platform,f.product_name,sum((n->'revenue'->>'known')::numeric)::text revenue,
        sum((n->'adSpend'->>'known')::numeric)::text ads,sum((n->'netProfit'->>'known')::numeric)::text net,sum((n->>'quantity')::numeric)::text quantity
        FROM meta_ads.unified_source_publications p JOIN meta_ads.unified_daily_facts f ON f.run_id=p.run_id
        CROSS JOIN LATERAL(SELECT f.payload->'nativeResult' n) x WHERE p.business_date=${plan.through}::date AND f.component='NATIVE_RESULT' AND n->>'kind'='PRODUCT'
        AND f.product_name IN ('러닝양말','퍼펙트슬라이드','아이언볼','자이로볼') GROUP BY 1,2 ORDER BY 1,2`;
      const expected=[['COUPANG','러닝양말','243400','71242','30874.80727272728'],['COUPANG','퍼펙트슬라이드','254000','0','96438.8909090909'],['NAVER','아이언볼','411600','0','243033']];
      for(const [platform,name,revenue,ads,net] of expected){const actual=totals.find(row=>row.platform===platform&&row.product_name===name);assert(actual,'TARGET_RESULT_MISSING');assert(eq(actual.revenue,revenue));assert(eq(actual.ads,ads));assert(decimal(actual.net).minus(net).abs().lt('0.000002'),'TARGET_NET_CHANGED');}
      assert.equal(stale,0,'STALE_PARTITIONS_REMAIN');
      const audits=await report.unifiedMappingAudit.findMany({where:{entityId:{in:state.rules.map(rule=>rule.id)},actorUserId:actor.id},select:{action:true,entityId:true}});
      assert(state.rules.every(rule=>audits.some(a=>a.action===rule.action&&a.entityId===rule.id)),'AUDIT_MISSING');
      process.env.UNIFIED_NATIVE_RESULTS_READ_ENABLED='true';
      const { UnifiedReportRepository } = require('../apps/api/dist/unified-performance/report.repository.js');
      const { UnifiedReportService } = require('../apps/api/dist/unified-performance/report.service.js');
      const { UnifiedAggregationRepository } = require('../apps/api/dist/unified-performance/aggregation.repository.js');
      const reports = new UnifiedReportService(new UnifiedReportRepository(management), new UnifiedAggregationRepository(report));
      const response=await reports.read('daily-products',{from:'2026-11-01',to:plan.through,compareFrom:'2026-11-01',compareTo:'2026-11-01',platforms:['META','GOOGLE','CAFE24','NAVER','COUPANG']},actor);
      for(const [platform,name,revenue,ads,net] of expected){
        const product=response.products.find(product=>product.productName===name);assert(product,'DAILY_PRODUCT_MISSING');
        const market=product.current.byMarketplace.find(row=>row.marketplace===(platform==='NAVER'?'NAVER_SMARTSTORE':'COUPANG'));assert(market,'DAILY_MARKET_MISSING');
        for(const [field,value] of [['revenue',revenue],['adSpend',ads],['estimatedProfit',net]])assert(eq(market.display[field].value,quantizeMoney(decimal(value))),'DAILY_DISPLAY_MISMATCH');
      }
      assert(!response.summary.warnings.includes('CONFIGURATION_CHANGED_REBUILD_RECOMMENDED'),'DAILY_CONFIGURATION_WARNING');
      state.verification={at:new Date().toISOString(),status:'PASS',partitions:pointers.length,stale,totals,actualDailyReportChecks:9,sourceWrites:0,financialDifferences:0};persist();console.log(JSON.stringify(state.verification));
    }
  }
} catch (error) {
  const message = String(error.message ?? '');
  state.lastFailure = { at: new Date().toISOString(), action: params.action, code: error.code ?? null, databaseCode: error.meta?.code ?? null,
    safeReason: message.match(/^[A-Z][A-Z0-9_]{3,100}$/)?.[0] ?? null, diagnostic: String(error.meta?.message ?? '').match(/(?:permission denied for|relation|column|schema)[^\n]{0,160}/i)?.[0] ?? null };
  persist(); console.log(JSON.stringify({ status: 'FAILED', ...state.lastFailure })); process.exitCode = 1;
} finally { await report.$disconnect(); await worker.$disconnect(); await source.$disconnect(); }
