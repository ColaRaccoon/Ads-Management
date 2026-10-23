import {REVIEWED_SOURCE_SHA256,REVIEWED_DEPLOYMENT_ID,REVIEWED_EVIDENCE_PUBLIC_KEY_B64,ISOLATED_IDENTITY,FIXED_CONNECTIONS,assertReviewedDeployment} from './deployment-evidence.mjs';
import {assertSchedule,jobPlan} from './core.mjs';
import {buildManagementBatch,effectiveScheduleRange} from './management-batch.mjs';
import {gunzipSync} from 'node:zlib';
export function checkedDefinitions(definitions) {
  if(!Array.isArray(definitions)||definitions.length!==3)throw new Error('PHASE08_PARENT_DEFINITIONS_REJECTED');
  const fields=['key','connectionId','provider','timeZone','anchorAt','windowMinutes','targetId'];
  const rows=definitions.map(row=>{
    if(!row || Object.keys(row).length!==fields.length || !fields.every(key=>Object.hasOwn(row,key)))throw new Error('PHASE08_PARENT_DEFINITIONS_REJECTED');
    const result=assertSchedule(row);
    if(row.targetId!==ISOLATED_IDENTITY.targetId || !FIXED_CONNECTIONS.some(expected=>expected.provider===row.provider && expected.connectionId===row.connectionId))throw new Error('PHASE08_PARENT_DEFINITIONS_REJECTED');
    return {...row,cadenceDays:result.cadenceDays};
  });
  if(new Set(rows.map(row=>row.key)).size!==3 || new Set(rows.map(row=>row.provider)).size!==3)throw new Error('PHASE08_PARENT_DEFINITIONS_REJECTED');
  return rows;
}
export async function parentBridge(input) {
  if(input?.action==='metadata') {
    for(const value of input.values??[]) {
      const decode=text=>{if(typeof text!=='string'||text.length>2097152)throw new Error('BOUND');const bytes=Buffer.from(text,'base64');if(bytes.toString('base64')!==text)throw new Error('BASE64');return bytes;};
      if(input.values.length!==2 || typeof value.original!=='string' || Boolean(value.json)===Boolean(value.gzip))throw new Error('METADATA');
      const actual=value.json?decode(value.json):gunzipSync(decode(value.gzip),{maxOutputLength:1048576});
      const original=decode(value.original);
      if(!original.equals(actual))throw new Error('METADATA');
    }
    if(input.values?.length!==2)throw new Error('METADATA');
    return {state:'PHASE08_METADATA_BYTES_VERIFIED'};
  }
  if(input?.action==='pins')return {sourceSha:REVIEWED_SOURCE_SHA256,deploymentId:REVIEWED_DEPLOYMENT_ID,publicKeyB64:REVIEWED_EVIDENCE_PUBLIC_KEY_B64,identity:ISOLATED_IDENTITY,connections:FIXED_CONNECTIONS};
  if(input?.action==='definitions') {
    const rows=checkedDefinitions(input.definitions);
    const now=Date.parse(input.observedAt);if(!Number.isFinite(now))throw new Error('PHASE08_PARENT_DATE_REJECTED');
    return {definitions:input.definitions,managementDefinitions:rows.map(({key,connectionId,provider,anchorAt,windowMinutes,cadenceDays})=>({key,connectionId,provider,anchorAt,windowMinutes,cadenceDays})),ranges:rows.map(row=>({provider:row.provider,connectionId:row.connectionId,...effectiveScheduleRange(row,now)}))};
  }
  if(input?.action==='loaded') {
    const rows=checkedDefinitions(input.definitions);
    for(const [name,fields] of [['appSchedules',['key','connectionId','anchorAt','windowMinutes']],['managementSchedules',['key','connectionId','provider','anchorAt','windowMinutes','cadenceDays']]]) {
      const actual=input[name];
      if(!Array.isArray(actual)||![0,3].includes(actual.length))throw new Error('LOADED');
      if(actual.length) {
        const wanted=rows.map(row=>Object.fromEntries(fields.map(key=>[key,row[key]]))).sort((a,b)=>a.key.localeCompare(b.key));
        const checked=actual.map(row=>{if(!row||Object.keys(row).length!==fields.length||!fields.every(key=>Object.hasOwn(row,key)))throw new Error('LOADED');return Object.fromEntries(fields.map(key=>[key,row[key]]));}).sort((a,b)=>a.key.localeCompare(b.key));
        if(JSON.stringify(wanted)!==JSON.stringify(checked))throw new Error('LOADED');
      }
    }
    return {state:'PHASE08_LOADED_DEFINITIONS_VERIFIED'};
  }
  if(input?.action==='validate')return {state:'PHASE08_SIGNED_EVIDENCE_VERIFIED',payload:assertReviewedDeployment(input.envelope)};
  if(input?.action==='build')return {state:'PHASE08_BATCH_PREPARED',sql:await buildManagementBatch(input.mode,input.definitions??[],input.envelope)};
  if(input?.action==='snapshot') {
    const before=input.before,after=input.after,mode=input.mode;
    if(!['install','configure','resume','enable'].includes(mode))throw new Error('MODE');
    if(!before || !after || before.preserved_schema_digest!==after.preserved_schema_digest || before.other_cron_digest!==after.other_cron_digest)throw new Error('PRESERVATION');
    const state=after.snapshot;
    if(!state?.installed || state.settings?.length!==1 || state.settings[0].targetId!==ISOLATED_IDENTITY.targetId || state.settings[0].origin!==ISOLATED_IDENTITY.origin || state.settings[0].stopped!==(mode!=='enable'))throw new Error('STATE');
    if(mode==='install') {
      if(state.schedules.some(row=>row.paused!==true) || state.jobs.some(row=>row.active!==false))throw new Error('INERT');
    } else {
      const rows=checkedDefinitions(input.definitions),active=['resume','enable'].includes(mode);
      for(const row of rows) {
        const found=state.schedules.filter(actual=>actual.key===row.key);
        if(found.length!==1 || found[0].paused!==!active || ['connectionId','provider','anchorAt','windowMinutes','cadenceDays'].some(key=>found[0][key]!==row[key]))throw new Error('SCHEDULE');
      }
      const wanted=rows.flatMap(jobPlan).map(job=>({...job,active,database:'postgres',username:'postgres'})).sort((a,b)=>a.name.localeCompare(b.name));
      const names=new Set(wanted.map(job=>job.name));
      const actual=state.jobs.filter(job=>names.has(job.name)).map(({name,cron,command,active,database,username})=>({name,cron,command,active,database,username})).sort((a,b)=>a.name.localeCompare(b.name));
      if(JSON.stringify(actual)!==JSON.stringify(wanted) || state.jobs.some(job=>!names.has(job.name)&&job.active))throw new Error('JOBS');
    }
    return {state:'PHASE08_BATCH_READBACK_VERIFIED'};
  }
  throw new Error('PHASE08_PARENT_ACTION_REJECTED');
}
if(process.argv[1]?.endsWith('scheduler-parent-bridge.mjs')) {
  let raw='';
  try {for await(const bytes of process.stdin){raw+=bytes;if(Buffer.byteLength(raw)>1048576)throw new Error('INPUT_BOUND');}
    const input=JSON.parse(raw);raw='';process.stdout.write(JSON.stringify(await parentBridge(input)));
  } catch {process.stdout.write(JSON.stringify({state:'PHASE08_SCHEDULER_PARENT_REJECTED'}));process.exitCode=1;}
  finally {raw='';}
}
