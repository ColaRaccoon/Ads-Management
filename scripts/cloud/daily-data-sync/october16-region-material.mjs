import {createHash} from 'node:crypto';
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const hash=v=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
let raw='';
try{
 for await(const part of process.stdin){raw+=part;if(Buffer.byteLength(raw)>262144)throw Error('BOUND');}
 const x=JSON.parse(raw),d=x.deploy,v=x.variables;
 if(!['sfo','sin'].includes(x.region)||!d||!v||v.PHASE08_SOURCE_CONTENT_SHA256!=='f1b78cdbdb2a7bd7c6c86da5891c8725181297c4f1b431893bb44042d4ff9b09'||v.SUPABASE_DATABASE_PROJECT_REF!=='ehnfrrmbkvlsbpvqcvkr'||v.SUPABASE_DATABASE_SCHEMA!=='phase08_meta_ads'||v.SUPABASE_DATABASE_RUNTIME_USER!=='phase08_runtime'||v.RUNTIME_API_TARGET_ID!=='phase08-full-app'||d.registryCredentials!==null||d.numReplicas!==1||d.sleepApplication!==true||d.restartPolicyType!=='NEVER'||d.startCommand!=='node deploy/cloud/phase08-launch.mjs'||JSON.stringify(canonical(d.limitOverride))!==JSON.stringify({containers:{cpu:1,memoryBytes:1000000000}})||JSON.stringify(canonical(d.multiRegionConfig))!==JSON.stringify({[x.region]:{numReplicas:1}}))throw Error('SCOPE');
 const {multiRegionConfig,...other}=d;
 process.stdout.write(JSON.stringify({state:'PHASE08_REGION_MATERIAL_VERIFIED',region:x.region,variablesSha:hash(v),variableCount:Object.keys(v).length,deployWithoutRegionSha:hash(other),deploySha:hash(d),replicas:1,cpu:1,memoryBytes:1000000000,sleepApplication:true,rawValuesReturned:0}));
}catch{process.stdout.write(JSON.stringify({state:'PHASE08_REGION_MATERIAL_REJECTED',rawErrorSuppressed:true}));process.exitCode=1;}finally{raw='';}
