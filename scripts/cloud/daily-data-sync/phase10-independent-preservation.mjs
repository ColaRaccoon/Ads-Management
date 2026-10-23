import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/independent';
const [beforeLabel,afterLabel,outLabel]=process.argv.slice(2);for(const label of [beforeLabel,afterLabel,outLabel])assert.match(label??'',/^[a-z0-9-]+$/);
const hash=b=>createHash('sha256').update(b).digest('hex');
const [beforeRaw,afterRaw]=await Promise.all([beforeLabel,afterLabel].map(label=>readFile(`${root}/${label}.json`,'utf8')));
const before=JSON.parse(beforeRaw),after=JSON.parse(afterRaw);
const a=new Map(before.recent.table_digests.map(t=>[t.table,t])),b=new Map(after.recent.table_digests.map(t=>[t.table,t]));
assert.equal(a.size,68);assert.equal(b.size,68);assert.deepEqual([...a.keys()].sort(),[...b.keys()].sort());
const allowedAuth=new Set(['app_auth_sessions','app_users','local_edge_request_nonces','security_audit_events','security_rate_limit_buckets']);
const changed=[];for(const[name,previous]of a){const next=b.get(name);if(previous.md5!==next.md5||previous.rows!==next.rows)changed.push({table:name,beforeRows:previous.rows,afterRows:next.rows,allowedAuthenticationEvidence:allowedAuth.has(name)});}
const unexpected=changed.filter(t=>!t.allowedAuthenticationEvidence);assert.deepEqual(unexpected,[]);
const protectedMetadata={};for(const key of ['jobs_md5','schedules_md5','settings_md5','call_md5','original152_md5','storage_objects_md5']){assert.equal(before.snapshot[key],after.snapshot[key]);protectedMetadata[key]=true;}
const variableChanges=[];for(const[name,sha]of Object.entries(before.variableNameHashes))if(after.variableNameHashes[name]!==sha)variableChanges.push(name);
const out={kind:'PHASE10_INDEPENDENT_PRESERVATION_COMPARISON',observedAt:new Date().toISOString(),before:{file:beforeLabel,at:before.observedAt,sha256:hash(beforeRaw)},after:{file:afterLabel,at:after.observedAt,sha256:hash(afterRaw)},tablesCompared:68,coreTablesCompared:63,allCoreTableRowsAndDigestsUnchanged:true,allowedAuthenticationTableChanges:changed,unexpectedTableChanges:unexpected,protectedMetadata,variableChanges,afterDeploymentId:after.deploymentId,afterStatus:after.status,afterActualReleaseSha:after.actualReleaseSha,afterImageDigest:after.imageDigest,afterRuntimeBackends:after.snapshot.runtime_backends,afterLeases:after.snapshot.live_leases,scope:'This comparison begins after the authorized token rotation and earlier authentication checks; it does not claim the initial 68-table hash remained identical.',appHttpRequests:0,providerRequests:0,databaseWrites:0};
await writeFile(`${root}/${outLabel}.json`,JSON.stringify(out,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(out));
