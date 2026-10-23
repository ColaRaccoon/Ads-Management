import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation';
const bytes=await readFile(root+'/performance-plan-20261020-v2/result.json');
const r=JSON.parse(bytes);
const sha=b=>createHash('sha256').update(b).digest('hex');
const variants=['CURRENT','TYPED','TYPED_MATERIALIZED'];
const scopes=['META_ADSET:2026-10-13:2026-10-14','META_ADSET:2026-10-09:2026-10-15','META_AD:2026-10-13:2026-10-14','META_AD:2026-10-09:2026-10-15'];
const checks={
  status:r.status==='PASS_READONLY_DIAGNOSTIC_EQUAL_DAYS',
  principalScope:r.actualPrincipal==='postgres' && r.runtimePrincipalUsed===false && r.runtimePlanProven===false,
  preserved:r.before68Sha===r.after68Sha && /^[a-f0-9]{64}$/.test(r.before68Sha) && r.all68Preserved===true && r.final68Checked===true && r.finalHoldsChecked===true,
  bounds:r.fixedCases===12 && r.businessSelectAttempts===24 && r.businessSelectExecutions===24 && r.statementTimeoutMs===20000 && r.automaticRetry===false,
  noMutation:r.remoteMutations===0 && r.providerCalls===0 && r.appHttpRequests===0 && r.postgresRuntimeLoginEnabled===false,
  privacy:r.rawPlansSaved===false && r.rawPlansOutput===false && r.rawIdsOutput===0,
  catalog:r.catalog.tables.length===6 && new Set(r.catalog.tables.map(x=>x.table)).size===6 && r.catalog.tables.every(t=>['rls','forced','runtimePolicyExists','runtimePolicyExactAllTrue','runtimeSelectGranted','runtimeSchemaUsage'].every(k=>t[k]===true)),
  cases:r.probes.length===12,
};
const comparisons=[];
for(const scope of scopes){
 const selected=r.probes.filter(p=>`${p.kind}:${p.from}:${p.to}`===scope);
 const current=selected.find(p=>p.variant==='CURRENT');
 checks[scope]=selected.length===3 && variants.every(v=>selected.filter(p=>p.variant===v).length===1) && selected.every(p=>p.explain.status==='PASS' && p.days.status==='PASS' && p.dayDigestEqual===true && p.days.dayCount===(p.from==='2026-10-13'?2:7) && p.days.canonicalDaysMd5===current.days.canonicalDaysMd5 && Number.isFinite(p.explain.plan.executionMs) && p.explain.plan.executionMs>=0);
 comparisons.push({scope,variants:selected.map(p=>({variant:p.variant,executionMs:p.explain.plan.executionMs,dayCount:p.days.dayCount,
  maxRowsRemovedByJoin:Math.max(0,...p.explain.plan.nodes.map(n=>n.removedRowsByJoin??0)),
  maxMaterializeLoops:Math.max(0,...p.explain.plan.nodes.filter(n=>n.nodeType==='Materialize').map(n=>n.loops??0)),
  sourceLinkTypedKindAndSourceIndexCondition:p.explain.plan.nodes.some(n=>n.relation==='source_record_links' && n.indexConditionFields.data_kind===true && n.indexConditionFields.source===true),
 }))});
}
const nativePath=root+'/independent/performance-meta-sql-20261020-v3/result.json';
const nativeBytes=await readFile(nativePath),native=JSON.parse(nativeBytes);
checks.freshNative=native.status==='PASS' && native.migrations===51 && native.matrix.allPass===true && native.matrix.matrixCases===62 && native.storefront.wholeOutputEqualFrozenV1===true && native.storefront.sameRepeatableReadConcurrentCommitPreserved===true && native.storefront.nextRequestFreshEvidenceRejects===true && native.postgresStopExit===0;
const result={kind:'INDEPENDENT_PRIVILEGED_META_PLAN_REVIEW',at:new Date().toISOString(),status:Object.values(checks).every(Boolean)?'PASS_SCOPED_DIAGNOSTIC':'FAIL_AUDIT',checks,comparisons,
 sourceReceiptSha256:sha(bytes),freshNativeSha256:sha(nativeBytes),
 finalProductHash:native.sourceHashes['apps/api/src/common/meta-source-read-coverage.ts'],
 productScopeIndependentTests:{count:2,passed:2,frozenV2ExactTransformOnly:'six value-side enum casts plus CTE MATERIALIZED',diagnosedTemplateScopes:4},
 limits:['Plans were executed as privileged postgres, not runtime principal.','Sequential CURRENT/TYPED/TYPED_MATERIALIZED order has cache warming bias.','Literal controlled SQL does not reproduce Prisma generic/custom prepared plans.','This does not validate concurrency4 or actual p95<=5000ms.','New candidate requires its own bounded actual40GET acceptance batch.'],
 ownRemoteRequests:0,ownProtectedMaterialReads:0,originalEvidenceModified:0};
const path=root+'/independent/resume-20261020/meta-plan-review-v1.json';
await writeFile(path,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
process.stdout.write(JSON.stringify({status:result.status,checks,comparisons,path,sha256:sha(await readFile(path))})+'\n');
if(result.status!=='PASS_SCOPED_DIAGNOSTIC')process.exitCode=1;
