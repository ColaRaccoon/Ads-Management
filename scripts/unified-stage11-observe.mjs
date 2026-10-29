// Read-only public/unauthenticated preflight. Never submits jobs or provider requests.
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function readinessArguments(args) {
  if (args.length !== 3 || args[0] !== '--readiness') throw Error('READINESS_ARGUMENTS_INVALID');
  const values = Object.fromEntries(args.slice(1).map(value => {
    const match = /^--(expected-release|output)=(.+)$/.exec(value);
    if (!match) throw Error('READINESS_ARGUMENTS_INVALID');
    return [match[1],match[2]];
  }));
  if (!/^[a-f0-9]{40}$/.test(values['expected-release'] ?? '') || !/^11-app-[a-z0-9-]{1,80}\.json$/.test(values.output ?? ''))
    throw Error('READINESS_ARGUMENTS_INVALID');
  return {expectedRelease:values['expected-release'],output:values.output};
}

export function readinessPayload(httpStatus, value, expectedRelease) {
  const payload = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const releaseId = typeof payload.releaseId === 'string' && /^[a-f0-9]{40}$/.test(payload.releaseId) ? payload.releaseId : null;
  const fingerprint = typeof payload.runtimeConfigFingerprint === 'string' && /^[a-f0-9]{64}$/.test(payload.runtimeConfigFingerprint) ? payload.runtimeConfigFingerprint : null;
  const checks = {httpOk:httpStatus===200,readyStatus:payload.status==='ready',releaseFormat:releaseId!==null,
    releaseMatches:releaseId===expectedRelease,fingerprintFormat:fingerprint!==null,
    exactPayloadKeys:JSON.stringify(Object.keys(payload).sort())===JSON.stringify(['releaseId','runtimeConfigFingerprint','status'])};
  return {status:Object.values(checks).every(Boolean)?'PASS':'FAIL',httpStatus,releaseId,runtimeConfigFingerprint:fingerprint,checks};
}

async function readSmallJson(response) {
  if (!response.body) throw Error('READINESS_BODY_MISSING');
  const reader = response.body.getReader(); let size=0; const parts=[];
  try {
    while (true) {
      const next=await reader.read(); if(next.done) break;
      size+=next.value.length; if(size>16384) {await reader.cancel();throw Error('READINESS_BODY_LIMIT');}
      parts.push(next.value);
    }
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  } finally {reader.releaseLock();}
}

async function readiness(args) {
  const input=readinessArguments(args);
  const evidence={stage:11,kind:'EXACT_RELEASE_READINESS',observedAt:new Date().toISOString(),remoteWrites:0,
    endpoint:'https://patimagroup-work.com/backend-api/health/ready',expectedRelease:input.expectedRelease,
    authentication:'internal probe token; memory only',status:'FAIL',httpStatus:null,releaseId:null,runtimeConfigFingerprint:null};
  let token=process.env.INTERNAL_PROBE_TOKEN;
  delete process.env.INTERNAL_PROBE_TOKEN;
  try {
    if(typeof token!=='string'||token.length<32||token.length>8192) throw Error('READINESS_TOKEN_UNAVAILABLE');
    const response=await fetch(evidence.endpoint,{method:'GET',redirect:'manual',credentials:'omit',cache:'no-store',
      headers:{'x-internal-probe-token':token},signal:AbortSignal.timeout(15000)});
    evidence.httpStatus=response.status;
    Object.assign(evidence,readinessPayload(response.status,await readSmallJson(response),input.expectedRelease));
  } catch {
    // Neither fetch/parser errors nor raw response bodies are safe to persist.
    evidence.errorCode='READINESS_REQUEST_FAILED';
  } finally {token=null;}
  writeFileSync(join('docs/product-performance/research',input.output),JSON.stringify(evidence,null,2)+'\n');
  process.stdout.write(JSON.stringify({stage:11,check:evidence.kind,status:evidence.status,httpStatus:evidence.httpStatus,releaseId:evidence.releaseId})+'\n');
  if(evidence.status!=='PASS')process.exitCode=1;
}

async function publicObservation() {
const origin = process.env.UNIFIED_STAGE11_OBSERVE_ORIGIN ?? 'https://patimagroup-work.com';
const parsed = new URL(origin);
if (parsed.origin !== origin || parsed.protocol !== 'https:' || parsed.username || parsed.password)
  throw Error('STAGE11_INVALID_OBSERVE_ORIGIN');
const observations = { stage: 11, at: new Date().toISOString(), origin, remoteWrites: 0,
  authenticated: false, samples: [], limitation: 'Public routing/liveness and unauthenticated denial only; not report totals or runtime-role proof.' };
for (const path of ['/backend-api/health/live', '/backend-api/health/ready', '/backend-api/auth/me',
  '/backend-api/unified-performance/options', '/products/performance', '/storefront', '/login']) {
  const start = performance.now();
  try {
    const response = await fetch(origin + path, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(15000) });
    const bytes = await response.arrayBuffer();
    const headers = Object.fromEntries(['content-type', 'cache-control', 'x-release-id', 'x-runtime-config-fingerprint',
      'x-content-type-options', 'x-frame-options', 'strict-transport-security', 'location'].map(key => [key, response.headers.get(key)]));
    const sample = { path, status: response.status, elapsedMs: performance.now()-start, bodyBytes: bytes.byteLength, headers };
    // Retain no HTML, cookies, auth token or financial payload.
    if (headers['content-type']?.includes('application/json')) {
      let data; try { data=JSON.parse(new TextDecoder().decode(bytes)); } catch {}
      if (data && typeof data === 'object') sample.safeJson = Object.fromEntries(['status','code','error','statusCode'].filter(key => key in data).map(key=>[key,data[key]]));
    }
    observations.samples.push(sample);
  } catch (error) {
    observations.samples.push({ path, error: error.name, elapsedMs: performance.now()-start });
  }
}
writeFileSync('docs/product-performance/research/11-app-public-observation.json', JSON.stringify(observations,null,2)+'\n');
console.log(JSON.stringify(observations,null,2));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  try {
    if(process.argv.length>2) await readiness(process.argv.slice(2));
    else await publicObservation();
  } catch {process.stderr.write('STAGE11_OBSERVATION_FAILED\n');process.exitCode=1;}
}
