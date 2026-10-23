import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const E='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation',S='scripts/cloud/daily-data-sync/';
const sha=v=>createHash('sha256').update(v).digest('hex'),read=p=>JSON.parse(readFileSync(p,'utf8'));
const previous=read(E+'/mixed-20261020-v2/tools.json'),compiled=read(E+'/portable-build-20261020-v2/compiled-proof.json');
assert.equal(sha(readFileSync(S+'phase10-resume-mixed-audit-v2.mjs')),'9edf80ee8a00411ae032042557df236131bea10e7950eb491833c3a1a9d25f78');
assert.equal(compiled.source,previous.source);assert.equal(compiled.image,previous.image);assert.equal(compiled.status,'PASS');assert.equal(compiled.compiledTreeSha256,sha(JSON.stringify(compiled.files)));
for(const f of compiled.files){const b=readFileSync(E+'/portable-build-20261020-v2/api-dist/'+f.name);assert.equal(b.length,f.bytes);assert.equal(sha(b),f.sha256);}
for(const f of previous.files)assert.equal(sha(readFileSync(S+f.name)),f.sha256);
function change(s,a,b){assert(s.includes(a));return s.replaceAll(a,b);}
let run=readFileSync(S+'phase10-resume-mixed-run-v3.mjs','utf8');
run=change(run,'phase10-resume-mixed-run-v3.mjs','phase10-resume-mixed-run-v4.mjs');
run=change(run,"evidence.candidateAfter=verifyClosure();evidence.finishedAt=new Date().toISOString();", "try{evidence.candidateAfter=verifyClosure();}catch{evidence.status='FAIL';evidence.finalClosureFailure={safeCode:'CANDIDATE_FINAL_CLOSURE_FAILED',rawSuppressed:true};process.exitCode=1;}evidence.finishedAt=new Date().toISOString();");
let audit=readFileSync(S+'phase10-resume-mixed-audit-v3.mjs','utf8');
audit=change(audit,"assert.equal(e.cleanupRemoveExit,0);",`assert.equal(Number(m.cgroup.memoryMax),999997440);const finalEvents=Object.fromEntries(m.cgroup.memoryEvents.trim().split(/\\n/).map(s=>{const[k,v]=s.trim().split(/\\s+/);return[k,Number(v)];}));for(const key of ['oom','oom_kill','max'])assert.equal(finalEvents[key],0);assert(Number(m.cgroup.memoryPeak)>0&&Number(m.cgroup.memoryPeak)<=999997440);assert.equal(e.cleanupRemoveExit,0);`);
audit=change(audit,'maxCgroupPeakBytes:Math.max(...samples.map(r=>r.cgroupPeak)),','maxCgroupPeakBytes:Math.max(...samples.map(r=>r.cgroupPeak)),sampledMaxCgroupPeakBytes:Math.max(...samples.map(r=>r.cgroupPeak)),finalKernelMemoryPeakBytes:Number(m.cgroup.memoryPeak),finalKernelMemoryEvents:finalEvents,');
const files=[['phase10-resume-mixed-run-v4.mjs',run],['phase10-resume-mixed-audit-v4.mjs',audit]];
for(const [name,body]of files)writeFileSync(S+name,body,{flag:'wx'});
const proof={...previous,kind:'C6_SYNTHETIC_MIXED_TOOL_HARDENING',at:new Date().toISOString(),previousToolsSha256:sha(readFileSync(E+'/mixed-20261020-v2/tools.json')),originalAuditCurrentReviewedSha256:'9edf80ee8a00411ae032042557df236131bea10e7950eb491833c3a1a9d25f78',compiledProofSha256:sha(readFileSync(E+'/portable-build-20261020-v2/compiled-proof.json')),compiledFilesVerified:compiled.files.length,finalClosureFailureSaved:true,sampledAndFinalPeakSeparate:true,files:files.map(([name,body])=>({name,sha256:sha(body)}))};
writeFileSync(E+'/mixed-20261020-v2/tools-v2.json',JSON.stringify(proof,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(proof));
