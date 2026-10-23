// Read-only Prisma migration status diagnosis; URLs are constructed in memory.
import {execFileSync,spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
const inspect=JSON.parse(execFileSync('docker',['inspect','meta-ads-phase03-pg-0929'],{encoding:'utf8'}))[0];
if(inspect.State.Status!=='running'||inspect.NetworkSettings.Ports['5432/tcp']?.[0]?.HostIp!=='127.0.0.1'||inspect.NetworkSettings.Ports['5432/tcp']?.[0]?.HostPort!=='55433')throw Error('LOCAL_TARGET');
const env=inspect.Config.Env,password=env.find(s=>s.startsWith('POSTGRES_PASSWORD='))?.slice(18),user=env.find(s=>s.startsWith('POSTGRES_USER='))?.slice(14)??'postgres';
if(!password)throw Error('LOCAL_CREDENTIAL');
const url=name=>`postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:55433/${name}?schema=meta_ads&connection_limit=1`;
const target=url('phase09_storefront_20261019');
const checks=[];
for(const mode of ['SAME_SHADOW','DISTINCT_UNUSED_SHADOW']){
 const result=spawnSync(process.execPath,['node_modules/prisma/build/index.js','migrate','status','--schema','apps/api/prisma/schema.prisma'],{env:{...process.env,DATABASE_URL:target,SHADOW_DATABASE_URL:mode==='SAME_SHADOW'?target:url('phase09_shadow_unused_20261019')},encoding:'utf8',timeout:30000,maxBuffer:1048576,windowsHide:true});
 const text=String(result.stdout??'')+'\n'+String(result.stderr??'');
 checks.push({mode,exitCode:result.status,codes:[...new Set(text.match(/\bP\d{4}\b/g)??[])],sameDatabaseReason:/shadow[\s\S]{0,250}(same|identical)[\s\S]{0,250}(main|database)/i.test(text),allMigrationsApplied:/up to date|no pending migration/i.test(text),rawOutputSuppressed:true});
}
const evidence={kind:'PHASE09_LOCAL_SHADOW_STATUS_DIAGNOSIS',observedAt:new Date().toISOString(),targetDatabase:'phase09_storefront_20261019',checks,remoteCalls:0,proxyCalls:0,providerCalls:0,command:'prisma migrate status',resetOrMigrationApply:false};
writeFileSync('C:/Users/seong/AppData/Local/MetaAdsPhase09Evaluation/local09-shadow-status-diagnosis-20261019.json',JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(evidence));
