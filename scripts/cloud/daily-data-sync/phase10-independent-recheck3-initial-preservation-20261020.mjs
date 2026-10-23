import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const base = 'C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/recheck-20261020-v3';
const out = 'C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/independent/resume-20261020/final-preservation-recheck3-initial-v1.json';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const files = ['bounded-plan-v2.json', 'final-held.json', 'restore-ready.json', 'light-load.json', 'db-load-telemetry.json'];
const receipts = await Promise.all(files.map(async name => {
  const bytes = await readFile(join(base, name));
  if (bytes.length > 2097152) throw new Error('PUBLIC_RECEIPT_SIZE');
  return { name, sha256: hash(bytes), value: JSON.parse(bytes) };
}));
const [plan, final, ready, load, telemetry] = receipts.map(x => x.value);
const before = plan.snapshot;
const after = final.snapshot;
const allowed = ['app_auth_sessions', 'app_users', 'security_audit_events', 'security_rate_limit_buckets'];
const keys = ['runtime_grants_md5', 'job_definitions_md5', 'other_jobs_md5', 'original152_md5', 'call_md5', 'storage_objects_md5'];
const oldTables = new Map(before.table_digests.map(x => [x.table, x]));
const newTables = new Map(after.table_digests.map(x => [x.table, x]));
const changed = after.table_digests.filter(x => {
  const old = oldTables.get(x.table);
  return !old || old.rows !== x.rows || old.md5 !== x.md5;
}).map(x => x.table).sort();
const equalLists = (a,b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const aggregates = Object.fromEntries(keys.map(key => [key, typeof before[key] === 'string' && before[key] === after[key]]));
const checks = {
  tableCount68: oldTables.size === 68 && newTables.size === 68 && equalLists(oldTables.keys(), newTables.keys()),
  changedExactlyFour: equalLists(changed, allowed),
  reportedChangesMatch: equalLists(changed, final.changedTables),
  aggregatePreservation: Object.values(aggregates).every(Boolean),
  identity: before.db === 'postgres' && after.db === 'postgres' && before.principal === 'postgres' && after.principal === 'postgres',
  forceRls: before.force_rls === 68 && after.force_rls === 68,
  runtimeHeld: after.runtime_role.login === false && ['super','createdb','createrole','bypassrls','replication'].every(k => after.runtime_role[k] === false) && after.runtime_backends === 0 && after.live_leases === 0,
  scheduledHeld: after.stopped === true && after.paused === 3 && after.jobs === 149 && after.active_jobs === 0,
  deployment: final.deployment.id === '58aebafe-e551-4316-a962-7bbe7ffe5f5b' && final.deployment.id === ready.deploymentId && final.deployment.deploymentStopped === true && final.unstopped === 0,
  securityImage: ready.http === 200 && ready.imageDigest === 'sha256:f1ffbe1208fa87980155d6ebc2cf4b6f468be7aacbe8bdf7852201cf871349f0' && ready.releaseId === '5bda544ec579a15745a93f89ee4fbc69bb7102f5',
  authAttested: final.stableUsersPreserved === true && final.oldSessionChanges === 0 && final.oldAuditChanges === 0 && final.unrevoked === 0,
  logout: load.logoutVerified === true && load.sessionMayRemain === false,
  noUnexpected: final.unexpected.length === 0 && final.sharedChanges === 0 && final.operatingChanges === 0,
  incidentRemainsBlocked: final.incidentResolved === false && final.normalResume === false,
};
const start = Date.parse(load.loadStartedAt), finish = Date.parse(load.loadFinishedAt);
const overlapping = telemetry.samples.filter(x => Date.parse(x.at) >= start && Date.parse(x.at) <= finish);
const hist = key => overlapping.reduce((result, sample) => { result[sample[key]] = (result[sample[key]] ?? 0) + 1; return result; }, {});
const result = {
  kind: 'PHASE10_INDEPENDENT_RECHECK_FINAL_PRESERVATION_AUDIT', at: new Date().toISOString(),
  status: Object.values(checks).every(Boolean) ? 'PASS_CONTAINMENT_WITH_EXTERNAL_RESIDUALS' : 'FAIL_AUDIT', checks,
  sourceReceiptHashes: Object.fromEntries(receipts.map(x => [x.name, x.sha256])),
  changedTablesRecomputed: changed, unchangedTableCount: 68 - changed.length, aggregateHashesRecomputed: aggregates,
  rowDeltas: changed.map(table => ({ table, before: oldTables.get(table).rows, after: newTables.get(table).rows })),
  restoredDeploymentId: final.deployment.id,
  publicBaselineReuseBasis: 'Reviewed PrepareReadTest requires fresh68 digests identical to private prep.snapshot, represented by public bounded-plan-v2.snapshot.',
  privateAuthBeforeImageIndependentlyOpened: false,
  privateAuthAttestationsBasis: 'Reviewed Get-ResumeAuth compares all app_users fields except last_login_at/updated_at, old session/audit IDs with full-row hashes; Final attests comparisons. No independent protected before-image read.',
  telemetry: { sampleCount: telemetry.sampleCount, failedSamples: telemetry.failedSamples, overlappingSamples: overlapping.length,
    activeHistogram: hist('active'), idleInTransactionHistogram: hist('idleInTransaction'), runtimeBackendsHistogram: hist('runtimeBackends'),
    maxLockWait: Math.max(...overlapping.map(x => x.lockWait)), maxActiveWait: Math.max(...overlapping.map(x => x.activeWait)),
    limitation: 'Sampled aggregate states do not identify query duration, Prisma queue time, wait type, or causal saturation; no absence-of-waits claim.' },
  performanceAcceptance: 'FAIL_5038.68_MS_GT_5000',
  ownRemoteRequests: 0, ownRemoteMutations: 0, ownProtectedMaterialReads: 0, rawUserRowsReturned: 0,
};
await writeFile(out, JSON.stringify(result,null,2)+'\n', {flag:'wx'});
process.stdout.write(JSON.stringify({status:result.status, checks, changed, unchangedTableCount:result.unchangedTableCount, telemetry:result.telemetry, path:out, sha256:hash(await readFile(out))})+'\n');
if (result.status === 'FAIL_AUDIT') process.exitCode = 1;
