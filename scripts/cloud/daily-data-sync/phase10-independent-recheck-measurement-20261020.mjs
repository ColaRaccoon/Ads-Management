import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';

const base = 'C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/recheck-20261020-v1';
const outRoot = 'C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/independent/resume-20261020';
const source = 'd2b9551f84812846108bdc559adad2c39e6693245f31474ecd3ec1fa9a028f01';
const release = '8b0205842c01ace9d1fa09161059df093527d84f';
const paths = [
  '/backend-api/dashboard/summary?from=2026-10-14&to=2026-10-14&deliveryStatus=all',
  '/backend-api/storefront/summary?from=2026-10-09&to=2026-10-15'
];
const digest = b => createHash('sha256').update(b).digest('hex');
const requireTrue = (value, code) => { if (!value) throw new Error(code); };
async function load(name) {
  const bytes = await readFile(join(base, name));
  requireTrue(bytes.length <= 2 * 1024 * 1024, 'PUBLIC_RECEIPT_SIZE');
  return { value: JSON.parse(bytes.toString('utf8')), sha256: digest(bytes) };
}
function summarize(rows) {
  const times = rows.map(r => r.elapsedMs).sort((a,b) => a-b);
  return { requests: rows.length, errors: rows.filter(r => r.httpStatus !== 200).length,
    p95Ms: times[Math.ceil(times.length * .95) - 1], totalBytes: rows.reduce((s,r) => s+r.bytes,0) };
}
function sameSummary(left, right) {
  return ['requests','errors','p95Ms','totalBytes'].every(k => left[k] === right[k]);
}
const label = process.argv[2];
if (!/^[a-z0-9-]{3,80}$/.test(label ?? '')) { process.stdout.write('{"status":"REJECTED_LABEL"}\n'); process.exit(1); }
let result;
try {
  const [l,a,r,t] = await Promise.all(['light-load.json','acceptance-read.json','ready.json','db-load-telemetry.json'].map(load));
  const loadResult = l.value, acceptance = a.value, ready = r.value, telemetry = t.value;
  requireTrue(loadResult.kind === 'PHASE10_USER_REVISED_ACTUAL_CANDIDATE_LIGHT_LOAD' && loadResult.sourceSha === source && loadResult.releaseSha === release && ready.source === source && ready.releaseId === release && loadResult.deploymentId === ready.deploymentId, 'CANDIDATE_BINDING');
  requireTrue(loadResult.acceptanceSha256 === a.sha256 && acceptance.maximumP95Ms === 5000 && acceptance.requests === 40 && acceptance.concurrency === 4 && acceptance.maximumErrors === 0 && acceptance.featureOnForPublishedReadsOnly === true && acceptance.scheduleEnabled === false && acceptance.maximumReadTestWindowMinutes === 20, 'ACCEPTANCE_BINDING');
  const rows = loadResult.requests;
  requireTrue(Array.isArray(rows) && rows.length === 40 && new Set(rows.map(x => x.index)).size === 40, 'EXACT_FORTY');
  for (const row of rows) requireTrue(Number.isInteger(row.index) && row.index >= 0 && row.index < 40 && row.path === paths[row.index % 2] && Number.isFinite(row.elapsedMs) && row.elapsedMs >= 0 && Number.isSafeInteger(row.bytes) && row.bytes >= 0 && row.bytes <= 2097152 && row.responseLimitExceeded === false, 'ROW_SHAPE');
  const summary = summarize(rows);
  requireTrue(sameSummary(summary,loadResult.summary), 'SUMMARY_RECOMPUTATION');
  const endpoints = paths.map(path => {
    const current = summarize(rows.filter(row => row.path === path));
    const reported = loadResult.endpoints.filter(row => row.path === path);
    requireTrue(current.requests === 20 && reported.length === 1 && sameSummary(current,reported[0].summary), 'ENDPOINT_RECOMPUTATION');
    return { path, summary: current };
  });
  requireTrue(loadResult.concurrency === 4 && loadResult.automaticRetryAllowed === false && loadResult.warmupRequests === 2, 'SINGLE_BATCH');
  requireTrue(loadResult.logoutAttempted === true && loadResult.logoutVerified === true && loadResult.sessionMayRemain === false, 'LOGOUT');
  for (const held of [loadResult.heldControlsBefore,loadResult.heldControlsAfter]) requireTrue(held && held.deploymentId === ready.deploymentId && held.unstoppedDeployments === 1 && held.stopped === true && held.paused === 3 && held.inactiveJobs === 149 && held.providerEnabled === 0 && held.sensitiveGrants === 0 && held.liveLeases === 0 && held.runningRuns === 0 && held.featureEnabled === true && held.scheduleEnabled === false && held.privateReadPlanExact === true, 'HELD_CONTROLS');
  const dashboard = loadResult.warmupContractChecks.filter(row => row.endpoint === 'DASHBOARD');
  requireTrue(dashboard.length === 1 && dashboard[0].status === 'PASS' && dashboard[0].moneyFieldsChecked === 10 && dashboard[0].actualMetaSpendExact === true && dashboard[0].expectedMetaSpendUsd === '4968.99', 'ACTUAL_DECIMAL_CONTRACT');
  const start = Date.parse(loadResult.loadStartedAt), finish = Date.parse(loadResult.loadFinishedAt), deadline = Date.parse(loadResult.readScope?.testDeadline);
  requireTrue([start,finish,deadline].every(Number.isFinite) && start <= finish && finish < deadline && deadline-start <= 1200000, 'READ_TEST_WINDOW');
  const projection = await load('preload-meta-projection.json');
  requireTrue(loadResult.readScope.preloadMetaProjectionSha256 === projection.sha256 && loadResult.readScope.privatePlan === 'performance-recheck-20261020-v1' && loadResult.readScope.normalResume === false, 'PROJECTION_BINDING');
  requireTrue(telemetry.deployment === ready.deploymentId && telemetry.rawChildOutputSaved === false && telemetry.rawChildOutputForwarded === false && telemetry.queryTextAndSecretsCaptured === false && Array.isArray(telemetry.samples) && telemetry.sampleCount === telemetry.samples.length, 'TELEMETRY_BINDING');
  const overlappingSamples = telemetry.samples.filter(row => { const at = Date.parse(row.at); return at >= start && at <= finish; });
  result = { kind:'PHASE10_INDEPENDENT_ACTUAL_LOAD_RECOMPUTATION', at:new Date().toISOString(),
    status: summary.errors === 0 && summary.p95Ms <= 5000 && loadResult.status === 'PASS' ? 'PASS' : 'FAIL_ACCEPTANCE',
    candidate:{deploymentId:ready.deploymentId,source,release}, summary, endpoints,
    actualDecimal4968_99Exact:true, logoutVerified:true, heldControlsPreserved:true,
    evidenceHashes:{load:l.sha256,acceptance:a.sha256,ready:r.sha256,telemetry:t.sha256,projection:projection.sha256},
    overlappingTelemetrySamples:overlappingSamples.length,
    observedMaxRuntimeBackends:overlappingSamples.length ? Math.max(...overlappingSamples.map(x=>x.runtimeBackends)) : null,
    observedMaxLockWait:overlappingSamples.length ? Math.max(...overlappingSamples.map(x=>x.lockWait)) : null,
    limits:['telemetry is sampled; waits between samples remain unmeasured','concurrency4 is code/orchestrator evidence, not external request tracing','workload differs from historical v5; no speedup assertion','shared-credential and stale-CDN incident residuals remain blocked'],
    remoteCalls:0,protectedMaterialReads:0,originalReceiptsModified:0,rawResponseContentReturned:0 };
} catch {
  result = {kind:'PHASE10_INDEPENDENT_ACTUAL_LOAD_RECOMPUTATION',at:new Date().toISOString(),status:'AUDIT_REJECTED_SAFE',rawErrorSuppressed:true,remoteCalls:0,protectedMaterialReads:0};
}
const path = resolve(outRoot, `actual-load-${label}.json`);
await writeFile(path,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
process.stdout.write(JSON.stringify({status:result.status,summary:result.summary,path,remoteCalls:0})+'\n');
if(result.status !== 'PASS') process.exitCode = 1;
