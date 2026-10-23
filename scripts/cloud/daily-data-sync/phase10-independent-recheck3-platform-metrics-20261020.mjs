import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation';
const base=root+'/recheck-20261020-v3';
const bytes=await readFile(base+'/railway-load-metrics.json'),m=JSON.parse(bytes);
const loadBytes=await readFile(base+'/light-load.json'),load=JSON.parse(loadBytes);
const hash=b=>createHash('sha256').update(b).digest('hex');
const start=Date.parse(m.windowStart),end=Date.parse(m.windowEnd);
const expected=['CPU_USAGE','MEMORY_USAGE_GB','MEMORY_LIMIT_GB'];
const checks={identity:m.kind==='BOUNDED_CANDIDATE_PLATFORM_METRICS'&&m.serviceId==='4b30daa8-9333-46b7-ad89-cfd64ff5266c'&&m.deployment==='597af377-927d-4b66-9b66-51ee859a9a5f'&&m.deployment===load.deploymentId,
 request:m.requestSucceeded===true&&m.requestedSampleSeconds===60&&m.remoteMutations===0&&m.rawLogsSaved===0,
 scope:m.scope==='EXACT_ISOLATED_SERVICE_NOT_DEPLOYMENT_DIMENSION'&&m.rssMetricAvailable===false&&m.oomMetricAvailable===false,
 window:Number.isFinite(start)&&Number.isFinite(end)&&Date.parse(m.loadStart)===Date.parse(load.loadStartedAt)&&Date.parse(m.loadEnd)===Date.parse(load.loadFinishedAt)&&start===Date.parse(load.loadStartedAt)-60000&&end===Date.parse(load.loadFinishedAt)+60000,
 series:m.series.length===3&&expected.every(name=>m.series.filter(s=>s.measurement===name).length===1),};
const summaries=m.series.map(s=>{
 if(!Array.isArray(s.values)||s.values.length!==3||!s.values.every(p=>Number.isSafeInteger(p.ts)&&p.ts*1000>=start&&p.ts*1000<=end&&Number.isFinite(p.value)&&p.value>=0))throw Error('METRIC_SHAPE');
 return {measurement:s.measurement,sampleCount:s.values.length,minimum:Math.min(...s.values.map(p=>p.value)),maximum:Math.max(...s.values.map(p=>p.value)),samples:s.values};
});
const out={kind:'INDEPENDENT_RECHECK3_PLATFORM_METRICS_PROJECTION',at:new Date().toISOString(),status:Object.values(checks).every(Boolean)?'PASS_SCOPED_PROJECTION':'FAIL',checks,summaries,sourceSha256:hash(bytes),loadSha256:hash(loadBytes),
 limits:['Service-level60second buckets include startup/restoration and are not specific to one deployment.','CPU values are retained in provider metric units without percentage conversion.','MEMORY_USAGE_GB is not process RSS and does not identify per-request peak.','OOM absence and unsampled resource peaks are not established.','No sampled resource metric proves the cause of p95 or fixes the5038.68ms failure.'],ownRemoteRequests:0,ownProtectedMaterialReads:0,originalEvidenceModified:0};
const path=root+'/independent/resume-20261020/platform-metrics-recheck3-v1.json';await writeFile(path,JSON.stringify(out,null,2)+'\n',{flag:'wx'});process.stdout.write(JSON.stringify({status:out.status,checks,summaries,path,sha256:hash(await readFile(path))})+'\n');if(out.status!=='PASS_SCOPED_PROJECTION')process.exitCode=1;
