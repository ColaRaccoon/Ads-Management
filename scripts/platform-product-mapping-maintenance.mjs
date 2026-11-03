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
const planPath = 'docs/product-performance/approved/platform-product-links-20261103.json';
const planText = readFileSync(planPath, 'utf8').replaceAll('\r\n', '\n');
const planHash = digest(planText); assert.equal(params['plan-sha'], planHash);
const plan = JSON.parse(planText); assert.equal(plan.kind, 'USER_APPROVED_NATIVE_PRODUCT_LINKS'); assert.equal(plan.links.length, 73);
assert.equal(plan.newProductNames.length, 4); assert.equal(plan.targetProject, 'iygjmosbelbosfxidqxv');
const dir = 'reports/platform-product-mapping-audit-20261103/deployment'; mkdirSync(dir, { recursive: true });
const stateFile = `${dir}/mapping-state.json`;
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { planHash, products: [], rules: [], replays: [], sourceWrites: 0 };
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
const reason = '2026-11-03 사용자 승인: 운영 DB 대조표 73개 제품 연결 및 신규 기준 4개. 원천 금액과 수량 보존.';
const fields = group => `native:${group}`;
const sameRule = (rule, link, snapshot) => rule.kind === 'NAME' && rule.active && rule.platform === link.platform && rule.scopeKey === link.scopeKey &&
  rule.payload.nameField === fields(link.platform) && rule.payload.matchType === 'EXACT' && rule.payload.terms?.length === 1 &&
  rule.payload.terms[0] === link.sourceName.normalize('NFC').trim().toLowerCase() && day(rule.validFrom) === link.validFrom && rule.validTo === null &&
  snapshot.products.find(product => product.id === rule.productId)?.canonicalName === link.targetName;
async function checkBaseline(snapshot) {
  for (const before of plan.baselineProducts) {
    const current = snapshot.products.find(product => product.id === before.id); assert(current, 'BASE_PRODUCT_MISSING');
    for (const key of ['canonicalName', 'active', 'version']) assert.deepEqual(current[key], before[key], 'BASE_PRODUCT_CHANGED');
  }
  for (const before of plan.baselineRules) {
    const current = snapshot.rules.find(rule => rule.id === before.id); assert(current, 'BASE_RULE_MISSING');
    for (const key of ['kind', 'productId', 'platform', 'scopeKey', 'payload', 'active', 'version']) assert.deepEqual(current[key], before[key], 'BASE_RULE_CHANGED');
  }
  assert(snapshot.products.filter(product => !plan.baselineProducts.some(before => before.id === product.id)).every(product => plan.newProductNames.includes(product.canonicalName)), 'UNEXPECTED_PRODUCT_ADDITION');
  assert(snapshot.rules.filter(rule => !plan.baselineRules.some(before => before.id === rule.id)).every(rule => plan.links.some(link => sameRule(rule, link, snapshot))), 'UNEXPECTED_RULE_ADDITION');
}
async function publications(client) { return client.unifiedSourcePublication.findMany({ where: { businessDate: { lte: new Date(plan.through) } }, orderBy: [{ businessDate: 'asc' }, { platform: 'asc' }, { scopeKey: 'asc' }] }); }
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
    const changes = facts.map(fact => {
      const row = fact.payload.nativeResult; assert(row, 'NATIVE_PAYLOAD_MISSING');
      const mapped = mapNativeProducts([row], pointer.scopeKey, partition.date, snapshot.products, rules, snapshot.versions.nameRuleVersion)[0];
      const productName = mapped.kind === 'SUMMARY' ? null : mapped.productName;
      const attribution = mapped.kind === 'SUMMARY' ? fact.attribution : productName ? 'DIRECT' : 'UNALLOCATED';
      return { id: fact.id, product_name: productName, attribution, payload: { ...fact.payload, productName, attribution, nativeResult: mapped } };
    });
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
      SELECT gen_random_uuid(),${id}::uuid,f.component,f.fact_key,CASE WHEN c.id IS NULL THEN f.product_name ELSE c.product_name END,
        f.sale_unit_name,f.amount_krw,f.original_amount,f.currency,f.quantity,coalesce(c.attribution,f.attribution),coalesce(c.payload,f.payload)
      FROM meta_ads.unified_daily_facts f LEFT JOIN jsonb_to_recordset(${JSON.stringify(changes)}::jsonb)
        AS c(id uuid,product_name text,attribution text,payload jsonb) ON c.id=f.id WHERE f.run_id=${before.id}::uuid`);
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
      FROM meta_ads.unified_daily_facts WHERE run_id=${before.id}::uuid), target AS (
      SELECT component,fact_key,sale_unit_name,amount_krw,original_amount,currency,quantity,
        CASE WHEN component='NATIVE_RESULT' THEN payload-'productName'-'attribution' #- '{nativeResult,productName}' #- '{nativeResult,audit}' #- '{nativeResult,issues}' ELSE payload END immutable
      FROM meta_ads.unified_daily_facts WHERE run_id=${id}::uuid)
      SELECT (SELECT count(*)::int FROM source) source_rows,(SELECT count(*)::int FROM target) target_rows,
        (SELECT count(*)::int FROM ((SELECT * FROM source EXCEPT ALL SELECT * FROM target) UNION ALL (SELECT * FROM target EXCEPT ALL SELECT * FROM source)) differences) financial_differences`);
    assert.equal(check.source_rows, copiedFacts); assert.equal(check.target_rows, copiedFacts); assert.equal(check.financial_differences, 0, 'FINANCIAL_VALUES_CHANGED');
    await tx.unifiedAggregationRun.update({ where: { id }, data: { status: 'READY', completedAt: at } });
    const switched = await tx.unifiedSourcePublication.updateMany({ where: { sourceSystem: pointer.sourceSystem, platform: pointer.platform,
      scopeKey: pointer.scopeKey, businessDate: pointer.businessDate, runId: before.id }, data: { runId: id, revision: { increment: 1 }, updatedAt: at } });
    assert.equal(switched.count, 1, 'PUBLICATION_CHANGED');
    await tx.unifiedAggregationRun.update({ where: { id }, data: { status: 'PUBLISHED', publishedAt: at } });
    const result = { status: 'PUBLISHED', ...partition, runId: id, previousRunId: before.id, copiedFacts, nativeRows: changes.length, financialDifferences: 0 };
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
  let snapshot = await management.snapshot(); await checkBaseline(snapshot);
  if (params.action === 'preflight') {
    const virtualProducts = [...snapshot.products, ...plan.newProductNames.filter(name => !snapshot.products.some(p => p.canonicalName === name)).map((canonicalName, i) => ({ id: `preview-${i}`, canonicalName, active: true }))];
    for (const link of plan.links) configurationRule({ kind: 'NAME', productId: virtualProducts.find(p => p.canonicalName === link.targetName).id,
      platform: link.platform, scopeKey: link.scopeKey, validFrom: link.validFrom, validTo: null,
      payload: { matchType: 'EXACT', terms: [link.sourceName], nameField: fields(link.platform) }, reason }, link.targetName);
    state.preflight = { at: new Date().toISOString(), configurationVersion: snapshot.versions.configurationVersion,
      products: snapshot.products.length, rules: snapshot.rules.length, publications: await publications(report) };
    persist(); console.log(JSON.stringify({ status: 'PASS', action: 'preflight', products: snapshot.products.length, rules: snapshot.rules.length, partitions: state.preflight.publications.length, approvedLinks: 73 }));
  } else if (params.action === 'trial') {
    const virtualProducts = [...snapshot.products, ...plan.newProductNames.map(canonicalName => ({ id: randomUUID(), canonicalName, active: true }))];
    const virtualRules = plan.links.map(link => ({ id: randomUUID(), ...configurationRule({ kind: 'NAME',
      productId: virtualProducts.find(product => product.canonicalName === link.targetName).id, platform: link.platform, scopeKey: link.scopeKey,
      validFrom: link.validFrom, validTo: null, payload: { matchType: 'EXACT', terms: [link.sourceName], nameField: fields(link.platform) }, reason }, link.targetName) }));
    const virtual = { ...snapshot, products: virtualProducts, rules: [...snapshot.rules, ...virtualRules] };
    const pointers = await publications(worker);
    const results = [];
    for (const platform of ['NAVER', 'COUPANG', 'CAFE24']) {
      const pointer = pointers.filter(pointer => pointer.platform === platform && day(pointer.businessDate) === plan.through).at(-1);
      assert(pointer); const before = pointer.runId; const result = await replay(pointer, virtual, actor, true);
      assert.equal(result.status, 'ROLLED_BACK');
      const after = await worker.unifiedSourcePublication.findFirst({ where: { platform, scopeKey: pointer.scopeKey, businessDate: pointer.businessDate } });
      assert.equal(after.runId, before); assert.equal(await worker.unifiedAggregationRun.count({ where: { id: result.runId } }), 0);
      results.push(result);
    }
    state.trial = { status: 'PASS', results, committedWrites: 0 }; persist();
    console.log(JSON.stringify({ status: 'PASS', action: 'trial', results, committedWrites: 0 }));
  } else if (params.action === 'apply') {
    assert(state.preflight, 'PREFLIGHT_REQUIRED');
    for (const name of plan.newProductNames) {
      if (snapshot.products.some(product => product.canonicalName === name)) continue;
      const input = { canonicalName: name, active: true, reason }; assert((await service.previewProduct(input)).canSave);
      const result = await service.saveProduct(input, actor); state.products.push({ id: result.product.id, name }); persist(); snapshot = await management.snapshot();
    }
    for (const link of plan.links) {
      if (snapshot.rules.some(rule => sameRule(rule, link, snapshot))) continue;
      const input = { kind: 'NAME', productId: snapshot.products.find(product => product.canonicalName === link.targetName).id,
        platform: link.platform, scopeKey: link.scopeKey, validFrom: link.validFrom, validTo: null, active: true,
        payload: { matchType: 'EXACT', terms: [link.sourceName], nameField: fields(link.platform) }, reason };
      const preview = await service.previewRule(input); assert(preview.canSave, 'RULE_PREVIEW_CONFLICT');
      const result = await service.saveRule({ ...input, expectedConfigurationVersion: preview.versions.configurationVersion }, actor);
      state.rules.push({ id: result.rule.id, sourceName: link.sourceName, targetName: link.targetName, platform: link.platform });
      persist(); snapshot = await management.snapshot();
      if (state.rules.length % 10 === 0) console.log(JSON.stringify({ action: 'apply', rulesSaved: state.rules.length }));
    }
    await checkBaseline(snapshot); assert(plan.links.every(link => snapshot.rules.some(rule => sameRule(rule, link, snapshot))));
    state.configurationVersion = snapshot.versions.configurationVersion; state.nameRuleVersion = snapshot.versions.nameRuleVersion; state.appliedAt = new Date().toISOString(); persist();
    console.log(JSON.stringify({ status: 'PASS', action: 'apply', createdProducts: state.products.length, savedRules: state.rules.length, products: snapshot.products.length }));
  } else if (params.action === 'replay') {
    assert(state.appliedAt, 'APPLY_REQUIRED'); assert.equal(snapshot.versions.configurationVersion, state.configurationVersion, 'CONFIGURATION_CHANGED');
    const pointers = (await publications(worker)).sort((a, b) => b.businessDate - a.businessDate || a.platform.localeCompare(b.platform)), limit = Number(params.limit ?? '1000'); assert(Number.isInteger(limit) && limit > 0 && limit <= 2000);
    let processed = 0, already = 0;
    for (const pointer of pointers) {
      if (state.replays.some(result => result.runId === pointer.runId && result.status === 'PUBLISHED')) { already++; continue; }
      const result = await replay(pointer, snapshot, actor);
      if (result.status !== 'ALREADY_APPLIED') state.replays.push(result);
      persist(); processed++;
      if (processed % 25 === 0) console.log(JSON.stringify({ action: 'replay', processed, already, total: pointers.length, published: state.replays.filter(r => r.status === 'PUBLISHED').length }));
      if (processed >= limit) break;
    }
    console.log(JSON.stringify({ status: 'PASS', action: 'replay', processed, already, total: pointers.length, financialDifferences: 0 }));
  } else {
    assert(state.appliedAt, 'APPLY_REQUIRED');
    const rows = await report.$queryRaw(Prisma.sql`SELECT p.platform,p.scope_key,p.business_date::text date,r.id,r.versions->>'nameRuleVersion' name_version
      FROM meta_ads.unified_source_publications p JOIN meta_ads.unified_aggregation_runs r ON r.id=p.run_id WHERE p.business_date<=${plan.through}::date`);
    const stale = rows.filter(row => row.name_version !== snapshot.versions.nameRuleVersion);
    const missing = await report.$queryRaw(Prisma.sql`SELECT DISTINCT p.platform,f.product_name FROM meta_ads.unified_source_publications p JOIN meta_ads.unified_daily_facts f ON f.run_id=p.run_id
      LEFT JOIN meta_ads.unified_products product ON product.canonical_name=f.product_name AND product.active
      WHERE f.component='NATIVE_RESULT' AND f.payload->'nativeResult'->>'kind'='PRODUCT' AND f.product_name IS NOT NULL AND product.id IS NULL`);
    const linkResults = await report.$queryRaw(Prisma.sql`WITH links AS (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(plan.links.map(link => ({ platform: link.platform, scope_key: link.scopeKey, source_name: link.sourceName, target_name: link.targetName, valid_from: link.validFrom })))}::jsonb)
        AS l(platform text,scope_key text,source_name text,target_name text,valid_from date))
      SELECT l.platform,l.source_name,l.target_name,count(f.id)::int published_rows,
        count(f.id) FILTER(WHERE f.product_name IS DISTINCT FROM l.target_name)::int incorrectly_assigned
      FROM links l LEFT JOIN meta_ads.unified_source_publications p ON p.platform=l.platform AND p.scope_key=l.scope_key AND p.business_date>=l.valid_from
      LEFT JOIN meta_ads.unified_daily_facts f ON f.run_id=p.run_id AND f.component='NATIVE_RESULT' AND f.payload->'nativeResult'->>'kind'='PRODUCT'
        AND coalesce(f.payload->'nativeResult'->'audit'->>'sourceProductName',f.product_name)=l.source_name
      GROUP BY 1,2,3 ORDER BY 1,2`);
    const auditedIds = [...state.products.map(product => product.id), ...state.rules.map(rule => rule.id)];
    const auditRecords = await report.unifiedMappingAudit.count({ where: { actorUserId: actor.id, entityId: { in: auditedIds }, action: 'CREATE' } });
    assert.equal(linkResults.length, 73); assert(linkResults.every(result => result.published_rows > 0 && result.incorrectly_assigned === 0), 'APPROVED_LINK_NOT_APPLIED');
    assert.equal(auditRecords, 77, 'CONFIGURATION_AUDIT_INCOMPLETE');
    state.verification = { at: new Date().toISOString(), products: snapshot.products.length, rules: snapshot.rules.length,
      stalePartitions: stale, unmappedPublishedNames: missing, approvedLinksVerified: linkResults.length, configurationAuditRecords: auditRecords, linkResults, replayedPartitions: state.replays.filter(r => r.status === 'PUBLISHED').length,
      financialDifferences: state.replays.reduce((n, r) => n + (r.financialDifferences ?? 0), 0), sourceWrites: 0 };
    persist(); assert.equal(stale.length, 0, 'STALE_PARTITIONS_REMAIN'); assert.equal(missing.length, 0, 'UNMAPPED_NAMES_REMAIN');
    const { linkResults: _links, ...summary } = state.verification; console.log(JSON.stringify({ status: 'PASS', action: 'verify', ...summary }));
  }
} catch (error) {
  const message = String(error.message ?? '');
  state.lastFailure = { at: new Date().toISOString(), action: params.action, code: error.code ?? null, databaseCode: error.meta?.code ?? null,
    safeReason: message.match(/^[A-Z][A-Z0-9_]{3,100}$/)?.[0] ?? null, diagnostic: String(error.meta?.message ?? '').match(/(?:permission denied for|relation|column|schema)[^\n]{0,160}/i)?.[0] ?? null };
  persist(); console.log(JSON.stringify({ status: 'FAILED', ...state.lastFailure })); process.exitCode = 1;
} finally { await report.$disconnect(); await worker.$disconnect(); await source.$disconnect(); }
