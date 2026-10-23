// Source-byte review only. No provider or shared database access.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const frozen='C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/full-app-build-20261016-meta-history-v22';
const manifest=JSON.parse(readFileSync(`${frozen}/source-content-manifest.json`,'utf8'));
const files=['sync-contract.ts','scheduled-occurrence.ts','scheduled-sync.service.ts','scheduled-checkpoint.ts','provider-run-scope.ts','sync-foundation.service.ts','meta-sync-runner.service.ts','google-sync-runner.service.ts','cafe24-sync-runner.service.ts','cafe24-scheduled-chunk.ts','cafe24-scheduled-bootstrap.ts','cafe24-scheduled-activation.ts','cafe24-order-adapter.ts'];
const rows=[];const sha=b=>createHash('sha256').update(b).digest('hex');
for(const name of files){const path=`apps/api/src/daily-sync/${name}`,entry=manifest.files.find(x=>x.name===path);assert(entry,`manifest entry ${path}`);const old=readFileSync(`${frozen}/${path}`),current=readFileSync(path);assert.equal(sha(old),entry.sha256);assert.equal(old.length,entry.size);rows.push({path,frozenSha256:entry.sha256,currentSha256:sha(current),sameBytes:old.equals(current)});}
const out={kind:'PHASE10_INDEPENDENT_SCHEDULER_SOURCE_REUSE',at:new Date().toISOString(),frozenSource:manifest.sourceContentSha256??manifest.sourceSha??null,frozenManifestSha256:sha(readFileSync(`${frozen}/source-content-manifest.json`)),reviewScope:'DATE_SELECTION_AND_RUN_BOUNDARY_ONLY',rows,changed:rows.filter(x=>!x.sameBytes).map(x=>x.path),providerRequests:0,remoteRequests:0,repeating08ClockTrialRequiredByThisCheck:false,semanticReviewRequiredForChangedFiles:true};
const dest='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/independent/resume-20261020/scheduler-source-reuse-v1.json';writeFileSync(dest,JSON.stringify(out,null,2),{flag:'wx'});console.log(JSON.stringify(out));
