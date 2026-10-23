'use strict';
const assert=require('node:assert/strict');
function resourceSnapshot(raw){
  const numeric=(value,label)=>{assert(typeof value==='string'&&/^[1-9]\d*$/.test(value),label);const n=Number(value);assert(Number.isSafeInteger(n)&&n>0,label);return n;};
  const current=numeric(raw.current,'CGROUP_CURRENT_MISSING'),peak=numeric(raw.peak,'CGROUP_PEAK_MISSING'),max=numeric(raw.max,'CGROUP_MAX_MISSING');
  // Linux rounds Docker's exact1,000,000,000-byte request down to a4KiB page boundary.
  assert.equal(max,Math.floor(1000000000/4096)*4096);assert(current<=peak&&peak<=max,'MEMORY_LIMIT_EXCEEDED');
  assert(typeof raw.events==='string'&&raw.events.length>0,'MEMORY_EVENTS_MISSING');
  const events=Object.fromEntries(raw.events.split('\n').map(line=>{const m=/^([a-z_]+) (\d+)$/.exec(line);assert(m,'MEMORY_EVENTS_INVALID');return[m[1],Number(m[2])];}));
  for(const k of ['oom','oom_kill'])assert(Number.isSafeInteger(events[k])&&events[k]===0,'OOM_EVENT_OBSERVED_OR_MISSING');
  assert(Number.isSafeInteger(raw.rss)&&raw.rss>0&&Number.isSafeInteger(raw.heap)&&raw.heap>0,'RSS_HEAP_MISSING');
  assert(Number.isInteger(raw.heavy)&&raw.heavy>=0&&raw.heavy<=1,'HEAVY_LIMIT_EXCEEDED');
  return {at:raw.at,rss:raw.rss,heapUsed:raw.heap,heavy:raw.heavy,cgroupCurrent:current,cgroupPeak:peak,events};
}
function validateDbTelemetry(rows,reads,errors=[]){
  assert(Array.isArray(errors)&&errors.length===0,'DB_TELEMETRY_QUERY_FAILURE');
  assert(Array.isArray(rows)&&rows.length>0,'DB_TELEMETRY_EMPTY');assert(Array.isArray(reads)&&reads.length===40,'READ_BATCH_MISSING');
  const start=Math.min(...reads.map(r=>r.start)),end=Math.max(...reads.map(r=>r.end));
  for(const r of rows){for(const k of ['backends','active','idle_tx','locks'])assert(Number.isInteger(r[k])&&r[k]>=0,'DB_SAMPLE_INVALID');assert(r.backends<=3&&r.active<=r.backends&&r.idle_tx<=r.backends&&r.locks<=r.backends,'DB_POOL_LIMIT_EXCEEDED');}
  const during=rows.filter(r=>r.at>=start&&r.at<=end&&['MIXED_META','MIXED_CAFE24','MIXED_GOOGLE'].includes(r.stage));
  assert(during.length>0&&during.some(r=>r.backends>0),'DB_MIXED_SAMPLE_MISSING');
  return {samples:rows.length,mixedSamples:during.length,maxBackends:Math.max(...during.map(r=>r.backends)),maxActive:Math.max(...during.map(r=>r.active)),maxIdleTx:Math.max(...during.map(r=>r.idle_tx)),maxLockWait:Math.max(...during.map(r=>r.locks)),sampledOnly:true};
}
module.exports={resourceSnapshot,validateDbTelemetry};
