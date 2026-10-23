'use strict';
// Read-only mounted experiment. Uses the immutable image's compiled modules without editing them.
const { createRequire } = require('node:module');
const { createServer } = require('node:net');
const { createInterface } = require('node:readline');
const { readFileSync } = require('node:fs');
const { createHash, randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const { AsyncLocalStorage } = require('node:async_hooks');
const assert = require('node:assert/strict');
const originalWrite = process.stdout.write.bind(process.stdout);
const send = value => originalWrite(JSON.stringify(value) + '\n');
console.log = console.error = console.warn = console.info = () => {};
const sockets = new Map(); let socketId=0, web, app, stage='BOOTSTRAP', stageHistory=[], started=false, resumeData=null;
function mark(value) { stage=value; stageHistory.push({ stage, at:Date.now() }); send({t:'stage',stage,at:Date.now()}); }
const input=createInterface({input:process.stdin});
input.on('line', line => { try { const m=JSON.parse(line); if(m.t==='db-data')sockets.get(m.id)?.write(Buffer.from(m.data,'base64')); else if(m.t==='db-end')sockets.get(m.id)?.end(); else if(m.t==='start'&&!started){started=true;resumeData=m.resume??null;void run().catch(fail);} } catch { void fail(Error('FRAME_INVALID')); } });
const relay=createServer(socket=>{const id=++socketId;assert(id<=1000);sockets.set(id,socket);send({t:'db-open',id});socket.on('data',b=>send({t:'db-data',id,data:b.toString('base64')}));socket.on('end',()=>send({t:'db-end',id}));socket.on('error',()=>send({t:'db-end',id}));socket.on('close',()=>sockets.delete(id));});
relay.listen(55437,'127.0.0.1',()=>send({t:'relay-ready'}));
const req=createRequire('/srv/app/apps/api/dist/app.module.js');
const mod=name=>req(`/srv/app/apps/api/dist/${name}.js`);
const sha=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function cgroup(name){try{return readFileSync(`/sys/fs/cgroup/${name}`,'utf8').trim();}catch{return null;}}
const {resourceSnapshot}=require('/experiment/phase10-resume-mixed-proof.cjs');
async function fail(error) {
  send({t:'failure',stage, name:error?.name??'Error',safeCode:/^[A-Z][A-Z0-9_]{2,80}$/.test(error?.message??'')?error.message:'LOCAL_EXPERIMENT_FAILURE',
    prismaCode:/^P\d{4}$/.test(error?.code??'')?error.code:null,appCode:error?.getResponse?.()?.code??null,
    stackLocations:(error?.stack??'').split('\n').slice(1,5).map(x=>x.match(/(?:\/srv\/app|\/experiment)\/[A-Za-z0-9_./-]+:\d+:\d+/)?.[0]).filter(Boolean),rawSuppressed:true});
  await cleanup();process.exitCode=1;setTimeout(()=>process.exit(1),100).unref();
}
async function cleanup(){web?.kill('SIGTERM');await app?.close().catch(()=>{});relay.close();for(const s of sockets.values())s.destroy();input.close();}
async function run(){
  mark('CONFIGURATION');
  for(const k of Object.keys(process.env))if(/^(?:SUPABASE_|PHASE08_|DAILY_SYNC_|AUTH_|GOOGLE_)/.test(k))delete process.env[k];
  Object.assign(process.env,{NODE_ENV:'test',APP_ENV:'test',DEPLOYMENT_MODE:'legacy',AUTH_PROVIDER:'local',STORAGE_PROVIDER:'local',
    DATABASE_URL:'postgresql://phase10_mixed_runtime:synthetic-local-only@127.0.0.1:55437/phase10_mixed_20261020?schema=meta_ads&connection_limit=3',
    PRISMA_CONNECTION_LIMIT:'3',PRISMA_IDLE_DISCONNECT_MS:'0',HEAVY_OPERATION_CONCURRENCY:'1',INTERNAL_PROBE_TOKEN:'synthetic-probe-only-000000000000000000000',
    AUTH_COOKIE_SECURE:'false',AUTH_COOKIE_NAMESPACE:'mixed-fixture',APP_ALLOWED_ORIGINS:'http://127.0.0.1:8000',
    AUTH_SESSION_HANDLE_SECRET:'synthetic-session-handle-00000000000000000',AUTH_AUTHORIZATION_VERSION_SECRET:'synthetic-authorization-00000000000000000',AUTH_CSRF_SECRET:'synthetic-csrf-000000000000000000000000000',
    AUTH_LOCAL_SESSION_TOKEN_SECRET:'synthetic-local-session-00000000000000000',AUTH_LOCAL_SETUP_TOKEN_SECRET:'synthetic-local-setup-0000000000000000000',AUTH_LOCAL_RATE_LIMIT_SECRET:'synthetic-local-rate-00000000000000000000',
    UPLOAD_STORAGE_DIR:'/tmp/mixed/uploads',REPORT_STORAGE_DIR:'/tmp/mixed/reports',DAILY_SYNC_FEATURE_ENABLED:'true',DAILY_SYNC_SCHEDULE_ENABLED:'false',
    DAILY_SYNC_META_TRANSPORT:'MCP',DAILY_SYNC_META_MCP_USE_CASE:'OWN_ACCOUNT_INTERNAL_REPORTING',DAILY_SYNC_META_ACTION_REPORT_TIME:'MCP_PROVIDER_DEFAULT_UNVERIFIED',
    DAILY_SYNC_META_ATTRIBUTION_WINDOWS:'',DAILY_SYNC_CAFE24_APP_API_VERSION:'2026-09-01',DAILY_SYNC_CAFE24_APP_API_VERSION_VERIFIED_AT:'2026-10-20',
    DAILY_SYNC_CAFE24_SELLER_DROPDOWN:'true',DAILY_SYNC_CAFE24_SELLER_DROPDOWN_VERIFIED_AT:'2026-10-20',DAILY_SYNC_CAFE24_VERIFIED_V1_STATUSES:'["N30"]',
    DAILY_SYNC_CHECKPOINT_KEY_B64:Buffer.alloc(32,37).toString('base64'),DAILY_SYNC_CAFE24_OBSERVATION_KEY_VERSION:'2',DAILY_SYNC_CAFE24_OBSERVATION_KEY_B64:Buffer.alloc(32,38).toString('base64')});
  for(const key of ['INTERNAL_PROBE_TOKEN','AUTH_SESSION_HANDLE_SECRET','AUTH_AUTHORIZATION_VERSION_SECRET','AUTH_CSRF_SECRET','AUTH_LOCAL_SESSION_TOKEN_SECRET','AUTH_LOCAL_SETUP_TOKEN_SECRET','AUTH_LOCAL_RATE_LIMIT_SECRET'])process.env[key]=randomBytes(48).toString('base64url');
  assert.equal(cgroup('memory.max'),String(Math.floor(1000000000/4096)*4096));const cpu=cgroup('cpu.max')?.split(' ').map(Number);assert(cpu&&cpu.every(Number.isFinite)&&cpu[0]===cpu[1]);
  req('reflect-metadata');
  const {NestFactory}=req('@nestjs/core'),{ValidationPipe}=req('@nestjs/common');
  const {AppModule}=mod('app.module');
  mark('NEST_CREATE');app=await NestFactory.create(AppModule,{logger:false,bodyParser:false,abortOnError:false});
  const {PrismaService}=mod('common/prisma.service'),db=app.get(PrismaService);
  const {HTTP_SECURITY_CONFIG}=mod('common/http-security.config'),{AUTH_CONFIG}=mod('auth/auth.config');
  mod('common/http-server').configureHttpServer(app,app.get(AUTH_CONFIG),app.get(HTTP_SECURITY_CONFIG));mod('common/api-routing').configureApiPrefix(app);
  app.useGlobalFilters(new (mod('common/api-exception.filter').ApiExceptionFilter)());app.useGlobalPipes(new ValidationPipe({transform:true,whitelist:true,forbidNonWhitelisted:true,transformOptions:{enableImplicitConversion:false}}));
  mark('NEST_LISTEN');await app.listen(4200,'127.0.0.1');
  const id=await db.$queryRawUnsafe('SELECT current_database() AS database,current_user AS role');
  assert.deepEqual(id,[{database:'phase10_mixed_20261020',role:'phase10_mixed_runtime'}]);
  const {SyncFoundationService}=mod('daily-sync/sync-foundation.service'),foundation=app.get(SyncFoundationService);
  const meta=app.get(mod('daily-sync/meta-sync-runner.service').MetaSyncRunnerService),google=app.get(mod('daily-sync/google-sync-runner.service').GoogleSyncRunnerService),cafe=app.get(mod('daily-sync/cafe24-sync-runner.service').Cafe24SyncRunnerService);
  const heavy=app.get(mod('common/heavy-operation').HeavyOperationGate);
  assert([foundation,meta,google,cafe].every(x=>x.prisma===db));assert(meta.foundation===foundation&&google.foundation===foundation&&cafe.foundation===foundation);assert.equal(foundation.heavy,heavy);
  const {makeFixtures,ACCOUNT}=require('/experiment/phase10-resume-mixed-fixtures.cjs');
  const wire=mod('daily-sync/meta-mcp-wire-reader'),fixture=makeFixtures(wire.META_MCP_PURCHASE_FIELDS);
  const {MetaMcpAdsClient}=mod('daily-sync/meta-mcp-ads.client');
  meta.client=new MetaMcpAdsClient(fixture.catalog,fixture.reporting,new wire.MetaMcpWireReader(fixture.request,mod('daily-sync/meta-mcp-envelope').boundedMetaMcpEnvelope));
  google.client=new (mod('daily-sync/google-ads.client').GoogleAdsClient)({getAccessToken:async()=> 'synthetic-google-token-not-a-credential'},fixture.request);
  cafe.client=new (mod('daily-sync/cafe24-orders.client').Cafe24OrdersClient)(db,{accessToken:async()=> 'synthetic-cafe-token-not-a-credential'},fixture.request);
  mark('SEED_CONNECTIONS');
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const end=Date.parse(today+'T00:00:00Z')-86400000,days=Array.from({length:7},(_,i)=>new Date(end-(6-i)*86400000).toISOString().slice(0,10));
  const ref='vault://meta/90000000-0000-4000-8000-000000000001';let expiry=new Date(Date.now()+30*86400000);
  const makeConnection=async data=>resumeData?db.sourceConnection.findFirstOrThrow({where:{provider:data.provider,externalAccountId:data.externalAccountId}}):db.sourceConnection.create({data});
  const mc=await makeConnection({provider:'META',externalAccountId:ACCOUNT,shopKey:'default',displayName:'Synthetic Meta',currencyCode:'USD',timeZone:'Asia/Seoul',enabled:true,accessState:'READY',credentialRef:ref,credentialExpiresAt:expiry});expiry=mc.credentialExpiresAt;
  const gc=await makeConnection({provider:'GOOGLE',externalAccountId:'9000000001',shopKey:'default',displayName:'Synthetic Google',currencyCode:'KRW',timeZone:'Asia/Seoul',enabled:true,accessState:'READY',credentialRef:'vault://google/90000000-0000-4000-8000-000000000002',credentialExpiresAt:expiry});
  const cc=await makeConnection({provider:'CAFE24',externalAccountId:'didadi0729',shopKey:'shop1',displayName:'Synthetic Cafe',currencyCode:'KRW',timeZone:'Asia/Seoul',enabled:true,accessState:'READY',credentialExpiresAt:expiry});
  process.env.DAILY_SYNC_ALLOWED_ACCOUNTS=JSON.stringify([`META/${ACCOUNT}/default`,'GOOGLE/9000000001/default','CAFE24/didadi0729/shop1']);process.env.DAILY_SYNC_META_CREDENTIAL_REF=ref;process.env.DAILY_SYNC_GOOGLE_CREDENTIAL_REF=gc.credentialRef;
  meta.resolver={resolve:async input=>({...input,token:'synthetic-meta-token-with-forty-characters-0000000000',appId:'4474691502806219',authClass:'SYSTEM_USER',scopes:['ads_read','ads_mcp_management'],expiresAt:expiry,transport:'MCP',currencyCode:'USD',timeZone:'Asia/Seoul'})};
  if(!resumeData)for(const [c,kinds]of [[mc,['META_AD','META_ADSET']],[gc,['GOOGLE_CAMPAIGN']],[cc,['CAFE24_ORDER']]])for(const dataKind of kinds)await db.sourcePolicy.create({data:{connectionId:c.id,dataKind,primarySource:'API',fromDate:new Date(days[0]+'Z'),version:1,effectiveAt:new Date(),reason:'SYNTHETIC_MIXED'}});
  const {createCredential,ScryptWorkLimiter}=mod('auth/local-credentials');
  const user=resumeData?await db.appUser.findUniqueOrThrow({where:{normalizedUsername:'mixed-fixture'}}):await db.appUser.create({data:{name:'Synthetic mixed administrator',username:'mixed-fixture',normalizedUsername:'mixed-fixture',role:'SUPER_ADMIN',inviteStatus:'ACTIVE',isActive:true}});
  if(!resumeData)await db.localCredential.create({data:{appUserId:user.id,...await createCredential('SyntheticOnlyPassword-20261020',new ScryptWorkLimiter(1,1))}});
  const localAuth=app.get(mod('auth/local-auth.service').LocalAuthService),cookies=app.get(mod('auth/cookie.service').AuthCookieService);
  const login=await localAuth.login('mixed-fixture','SyntheticOnlyPassword-20261020');const cookie=`${cookies.sessionCookieName}=${encodeURIComponent(login.sessionToken)}`;
  const queue=(c,from,to,key,trigger='MANUAL')=>foundation.queueRun({connectionId:c.id,fromDate:from,toDate:to,trigger,actorUserId:trigger==='SCHEDULED'?null:user.id,requestKey:`mixed:${key}`});
  mark('SEED_ACTUAL_RUNNERS');
  if(!resumeData){
    for(const day of days){let r=await queue(mc,day,day,'seed-meta-'+day);assert.equal((await meta.execute(r.id)).status,'SUCCEEDED');r=await queue(gc,day,day,'seed-google-'+day);assert.equal((await google.execute(r.id)).status,'SUCCEEDED');}
    // Baseline fixture construction is not a second expensive Cafe network-read trial.
    const cafeSeed=await queue(cc,days[6],days[6],'seed-cafe'),claim=await foundation.claimRun(cafeSeed.id);assert(claim);
    try{const normalize=mod('daily-sync/cafe24-order-adapter').normalizeCafe24Order;const origins=new Map();
      const orders=Array.from({length:343},(_,i)=>normalize(fixture.order(i,days[6]),fixture.items(i),{verifiedSellerDropdown:true,csvOptionEvidence:{mallId:'didadi0729',shopKey:'shop1'},compositionOrigins:origins})).flat();
      await cafe.writer.publishCafe24Day({connectionId:cc.id,runId:cafeSeed.id,generation:claim.generation,metricDate:new Date(days[6]+'Z'),pageCount:4,policyVersion:1,completeDaySnapshot:true,fetchedAt:new Date(),orders});await foundation.finishRun(claim);
    }finally{claim.release();}
    // The experiment starts from an explicitly seeded, already-reviewed API-primary fixture.
    // Activation itself is outside this mixed workload and is not claimed as a new result.
    await db.sourceCoverage.update({where:{connectionId_dataKind_metricDate:{connectionId:cc.id,dataKind:'CAFE24_ORDER',metricDate:new Date(days[6]+'Z')}},data:{reconciliationStatus:'CAFE24_API_ONLY_VERIFIED'}});
  }
  assert.equal(await db.metaAdDailyMetric.count({where:{source:'API',isCurrent:true}}),3661);assert.equal(await db.metaAdsetDailyMetric.count({where:{source:'API',isCurrent:true}}),1400);assert.equal(await db.cafe24OrderLine.count({where:{source:'API',isCurrent:true}}),379);
  mark('NEXT_START');
  web=spawn(process.execPath,['--max-old-space-size=192','/srv/app/apps/web/server.js'],{cwd:'/srv/app',env:{NODE_ENV:'production',PORT:'8000',HOSTNAME:'127.0.0.1',API_INTERNAL_PORT:'4200',NEXT_TELEMETRY_DISABLED:'1'},stdio:['ignore','ignore','ignore']});
  const paths=[`/backend-api/dashboard/summary?from=${days[6]}&to=${days[6]}&deliveryStatus=all`,`/backend-api/storefront/summary?from=${days[0]}&to=${days[6]}`];
  const nativeFetch=globalThis.fetch;
  async function get(path){const begin=performance.now(),start=Date.now();const response=await nativeFetch('http://127.0.0.1:8000'+path,{headers:{cookie,'x-user-activity-age':'0'},signal:AbortSignal.timeout(30000)});const b=Buffer.from(await response.arrayBuffer());return {status:response.status,bytes:b.length,ms:Math.round((performance.now()-begin)*100)/100,start,end:Date.now()};}
  let ready=false;for(let i=0;i<100;i++){try{const r=await get(paths[0]);if(r.status===200){ready=true;break;}send({t:'warm-status',status:r.status});}catch{}await sleep(100);}assert(ready,'NEXT_WARMUP_FAILED');assert.equal((await get(paths[1])).status,200);
  const resources=[],collectionSpans=[],txSpans=[];const writeContext=new AsyncLocalStorage(),writeStarted=new Map();
  for(const [provider,writer,method]of [['META',meta.writer,'publishMetaDay'],['CAFE24',cafe.writer,'publishCafe24Day'],['GOOGLE',google.writer,'publish']]){
    const original=writer[method].bind(writer);writer[method]=(...args)=>writeContext.run(provider,()=>original(...args));
  }
  const txOriginal=db.$transaction.bind(db);db.$transaction=function(...args){
    const provider=writeContext.getStore();if(!provider||typeof args[0]!=='function')return txOriginal(...args);
    const original=args[0];args[0]=async tx=>{const s=Date.now();writeStarted.get(provider)?.();writeStarted.delete(provider);try{return await original(tx);}finally{txSpans.push({provider,start:s,end:Date.now(),canonicalWriter:true});}};return txOriginal(...args);
  };
  let monitorFailure=null;const captureResource=()=>resourceSnapshot({at:Date.now(),rss:process.memoryUsage().rss,heap:process.memoryUsage().heapUsed,heavy:heavy.active,current:cgroup('memory.current'),peak:cgroup('memory.peak'),max:cgroup('memory.max'),events:cgroup('memory.events')});resources.push(captureResource());
  const sampler=setInterval(()=>{try{assert(resources.length<10000,'RESOURCE_SAMPLE_LIMIT');resources.push(captureResource());}catch(e){monitorFailure=e;}},100);
  const rows=[];
  async function readPhase(provider,count,collect){
    assert.equal(monitorFailure,null,'RESOURCE_MONITOR_FAILED');mark('MIXED_'+provider);
    const s=Date.now();let collectDone=false,signal;
    const firstWrite=new Promise(resolve=>{signal=resolve;});writeStarted.set(provider,signal);
    const collection=collect().finally(()=>{collectDone=true;collectionSpans.push({provider,start:s,end:Date.now()});});
    await Promise.race([firstWrite,collection.then(()=>{throw Error('CANONICAL_WRITE_NOT_OBSERVED');})]);
    let index=0;const offset=rows.length;await Promise.all(Array.from({length:4},async()=>{while(index<count){const i=index++,n=offset+i,p=paths[n%2];const r=await get(p);rows.push({index:n,provider,path:p.split('?')[0],...r,collectionInFlightAtCompletion:!collectDone});}}));await collection;
  }
  fixture.setVersion(2);mark('MIXED_BATCH');
  const mr=await queue(mc,days[0],days[6],'mixed-meta','SCHEDULED');const gr=await queue(gc,days[0],days[6],'mixed-google','SCHEDULED');const cr=await queue(cc,days[6],days[6],'mixed-cafe','SCHEDULED');
  const deadline=new Date(Date.now()+30*60000);
  async function step(r,runner){assert(await foundation.prepareScheduledRetry(r.id,deadline));return runner.execute(r.id,{maxUnits:1,deadlineAt:Date.now()+65000});}
  if(!resumeData){
    await step(cr,cafe);const originalChunk=cafe.client.fetchScheduledChunk.bind(cafe.client);
    cafe.client.fetchScheduledChunk=async(...args)=>{
      assert(args[3]&&args[3].first.length===100,'CHECKPOINT_NOT_RELOADED');
      const cp=await db.$queryRawUnsafe('SELECT revision,octet_length(ciphertext)::int AS bytes,md5(ciphertext)::text AS digest FROM sync_unit_checkpoints');assert.equal(cp.length,1);assert(cp[0].bytes>0);
      const running=await db.syncRun.findUniqueOrThrow({where:{id:cr.id}});assert.equal(running.status,'RUNNING');
      assert.equal(await db.syncLease.count({where:{connectionId:cc.id,ownerRunId:cr.id,expiresAt:{gt:new Date()}}}),1);
      await localAuth.logout(login.sessionToken);await assert.rejects(localAuth.authenticateSession(login.sessionToken));clearInterval(sampler);resources.push(captureResource());assert.equal(monitorFailure,null,'FIRST_GENERATION_RESOURCE_MONITOR_FAILED');assert(resources.length>0);
      send({t:'checkpoint-restart',data:{resources,checkpoint:cp[0],fixtureRequests:fixture.counts,at:Date.now(),samePrismaInstance:true,activeRun:true,liveLease:true,insideFetchScheduledChunk:true,firstCount:args[3].first.length}});
      await new Promise(()=>{});
    };
    await step(cr,cafe);throw Error('SIGKILL_DID_NOT_OCCUR');
  }
  const cpAfter=await db.$queryRawUnsafe('SELECT revision,octet_length(ciphertext)::int AS bytes,md5(ciphertext)::text AS digest FROM sync_unit_checkpoints');assert.deepEqual(cpAfter,[resumeData.checkpoint]);
  mark('RECOVERY_LEASE_WAIT');
  while(await db.syncLease.count({where:{connectionId:cc.id,expiresAt:{gt:new Date()}}}))await sleep(1000);
  assert(await foundation.prepareScheduledRetry(cr.id,deadline));
  mark('CAFE_CHECKPOINT_CONTINUATIONS');let continuations=1;
  // Prepare the large day up to READY, retaining real 500ms per-item yielding and all GCM checkpoint writes.
  const checkpointMod=mod('daily-sync/scheduled-checkpoint');
  while(continuations<60){
    const leaseRow=await db.syncLease.findUniqueOrThrow({where:{connectionId:cc.id}});
    const state=await checkpointMod.loadScheduledCheckpoint(db,{runId:cr.id,connectionId:cc.id,generation:leaseRow.generation},days[6]);
    if(state.stage==='ITEMS_VERIFY'&&state.cursor>=state.count-20)break;
    await step(cr,cafe);continuations++;if(continuations%4===0)mark('CAFE_CHUNK_PROGRESS');
  }
  // Keep explicit-zero units, but overlap the Google reads with an actual positive-money replacement.
  let googleReadDay;
  for(let i=0;i<7;i++){const pending=await db.runUnit.findFirstOrThrow({where:{runId:gr.id,status:{not:'SUCCEEDED'}},orderBy:{unitKey:'asc'}});if(Number(pending.unitKey.slice(-2))%2===0){googleReadDay=pending.unitKey;break;}await step(gr,google);}
  assert(googleReadDay,'GOOGLE_POSITIVE_UNIT_MISSING');
  await readPhase('META',16,()=>step(mr,meta));await readPhase('CAFE24',12,()=>step(cr,cafe));await readPhase('GOOGLE',12,()=>step(gr,google));
  mark('COMPLETE_REMAINING_UNITS');
  for(let i=0;i<7;i++){if((await db.syncRun.findUniqueOrThrow({where:{id:mr.id}})).status!=='SUCCEEDED')await step(mr,meta);if((await db.syncRun.findUniqueOrThrow({where:{id:gr.id}})).status!=='SUCCEEDED')await step(gr,google);}
  assert.equal((await db.syncRun.findUniqueOrThrow({where:{id:cr.id}})).status,'SUCCEEDED');
  clearInterval(sampler);resources.push(captureResource());assert.equal(monitorFailure,null,'RESOURCE_MONITOR_FAILED');assert(resources.length>0);
  const finalCounts={ads:await db.metaAdDailyMetric.count({where:{source:'API',isCurrent:true}}),adsets:await db.metaAdsetDailyMetric.count({where:{source:'API',isCurrent:true}}),cafe:await db.cafe24OrderLine.count({where:{source:'API',isCurrent:true}}),google:await db.googleCampaignDailyCost.count({where:{source:'API',isCurrent:true}}),checkpoints:await db.$queryRawUnsafe('SELECT count(*)::int AS n FROM sync_unit_checkpoints')};
  assert.equal(finalCounts.ads,3661);assert.equal(finalCounts.adsets,1400);assert.equal(finalCounts.cafe,379);assert.equal(finalCounts.checkpoints[0].n,0);
  const finishedRuns=await db.syncRun.findMany({where:{id:{in:[mr.id,gr.id,cr.id]}},include:{units:true}});assert.equal(finishedRuns.length,3);
  for(const r of finishedRuns){assert.equal(r.status,'SUCCEEDED');assert.equal(r.units.length,r.connectionId===cc.id?1:7);assert(r.units.every(u=>u.status==='SUCCEEDED'));}
  const cv=await db.sourceCoverage.findMany({where:{connectionId:{in:[mc.id,gc.id,cc.id]}}});assert.equal(cv.length,22);
  for(const c of cv){assert.equal(c.lastSuccessRunId,c.connectionId===mc.id?mr.id:c.connectionId===gc.id?gr.id:cr.id);assert(['COMPLETE_ZERO','COMPLETE_NONZERO'].includes(c.state));}
  const metaMoney=await db.metaAdDailyMetric.aggregate({where:{source:'API',isCurrent:true},_sum:{spendUsd:true}});assert.equal(metaMoney._sum.spendUsd.toString(),'7322');
  assert.equal(await db.metaAdDailyMetric.count({where:{source:'API',isCurrent:true,importVersion:2}}),3661);
  assert.equal(await db.cafe24OrderLine.count({where:{source:'API',isCurrent:true,importVersion:2}}),379);
  const expectedGoogleRows=days.filter(d=>Number(d.slice(-2))%2===0).length*3;
  assert.equal(finalCounts.google,expectedGoogleRows);assert.equal(await db.googleCampaignDailyCost.count({where:{source:'API',isCurrent:true,version:2}}),expectedGoogleRows);
  const auditCount=await db.securityAuditEvent.count({where:{action:'SYNC_UNIT_PUBLISHED',targetId:{in:[...days.map(d=>`${mr.id}:${d}`),...days.map(d=>`${gr.id}:${d}`),`${cr.id}:${days[6]}`]}}});assert.equal(auditCount,15);
  mark('MALFORMED_PROVIDER_PRESERVATION');
  const currentMetaDigest=async()=>shaBuffer(JSON.stringify(await db.metaAdDailyMetric.findMany({where:{connectionId:mc.id,isCurrent:true,source:'API'},orderBy:{id:'asc'}}),(_k,v)=>typeof v==='bigint'?v.toString():v));
  const shaBuffer=b=>createHash('sha256').update(b).digest('hex');
  const beforeMeta=currentMetaDigest(),lastSuccessBefore=(await db.sourceCoverage.findMany({where:{connectionId:mc.id},orderBy:[{dataKind:'asc'},{metricDate:'asc'}]})).map(x=>[x.dataKind,x.metricDate.toISOString(),x.lastSuccessRunId,x.lastSuccessAt?.toISOString()]);
  const expectedMetaDigest=await beforeMeta;fixture.setFault('META_NULL_FREQUENCY');
  const bad=await queue(mc,days[6],days[6],'malformed-meta'),badResult=await meta.execute(bad.id);fixture.setFault(null);
  assert.equal(badResult.status,'ACTION_REQUIRED');assert.equal(badResult.safeErrorCode,'FIELD_UNSUPPORTED');assert.equal(await currentMetaDigest(),expectedMetaDigest);
  assert.deepEqual((await db.sourceCoverage.findMany({where:{connectionId:mc.id},orderBy:[{dataKind:'asc'},{metricDate:'asc'}]})).map(x=>[x.dataKind,x.metricDate.toISOString(),x.lastSuccessRunId,x.lastSuccessAt?.toISOString()]),lastSuccessBefore);
  assert.equal(await db.securityAuditEvent.count({where:{action:'SYNC_UNIT_PUBLISHED',targetId:`${bad.id}:${days[6]}`}}),0);
  await localAuth.logout(login.sessionToken);await assert.rejects(localAuth.authenticateSession(login.sessionToken));
  const sorted=rows.map(r=>r.ms).sort((a,b)=>a-b),p95=sorted[Math.ceil(sorted.length*.95)-1];assert.equal(rows.length,40);rows.sort((a,b)=>a.index-b.index);
  const overlap=rows.map(r=>({...r,collectorOverlap:collectionSpans.some(s=>s.provider===r.provider&&r.start<s.end&&r.end>s.start),transactionOverlap:txSpans.some(s=>s.provider===r.provider&&r.start<s.end&&r.end>s.start)}));
  for(const provider of ['META','CAFE24','GOOGLE'])assert(overlap.some(r=>r.provider===provider&&r.transactionOverlap),'NO_READ_CANONICAL_WRITE_OVERLAP');
  assert(resources.every(r=>r.heavy<=1));assert(resources.some(r=>r.heavy===1));assert.equal(fixture.counts.nonFixtureRequests,0);
  const sources=['app.module','daily-sync/sync-foundation.service','daily-sync/meta-sync-runner.service','daily-sync/cafe24-sync-runner.service','daily-sync/google-sync-runner.service','daily-sync/canonical-api-writer.service','daily-sync/cafe24-canonical-writer.service','common/prisma.service','metrics/dashboard-metrics.service','storefront/storefront-read.service'];
  send({t:'result',data:{kind:'SYNTHETIC_PROVIDER_ACTUAL_IMAGE_MIXED',status:rows.every(r=>r.status===200)&&p95<=5000?'PASS':'FAIL',p95,criteria:{requests:40,concurrency:4,p95Ms:5000,errors:0},rows:overlap,collectionSpans,txSpans,resources,finalCounts,continuations,fixtureRequests:fixture.counts,
    samePrismaInstance:true,poolLimit:3,heavyLimit:1,authGuardBypassed:false,actualLocalSessionChecks:true,loggedOut:true,runsSucceeded:3,unitsSucceeded:15,coverageBound:22,publicationAudits:auditCount,metaVersion2Rows:3661,metaCurrentSpendUsd:metaMoney._sum.spendUsd.toString(),googlePositiveReadDay:googleReadDay,malformedProvider:{status:badResult.status,code:badResult.safeErrorCode,canonicalPreserved:true,lastSuccessPreserved:true,publicationAudits:0},compiledHashes:Object.fromEntries(sources.map(p=>[p,sha(`/srv/app/apps/api/dist/${p}.js`)])),
    cgroup:{memoryMax:cgroup('memory.max'),memoryPeak:cgroup('memory.peak'),memoryEvents:cgroup('memory.events'),cpuMax:cgroup('cpu.max')},stageHistory,checkpointRecoveredAfterSigkill:!!resumeData,preKill:resumeData,
    limits:{syntheticProviders:true,actualExternalProvider:false,productionEnvironment:false,productionLauncher:false,productionAuthStorage:false,scheduledDateReuse08:true,scheduledClockNotRetested:true,dbOutsideCgroup:true,dbTunnelOverStdio:true,noExternalNetwork:true,checkpointProcessKillProven:!!resumeData,baselineCafeReconciliationSeeded:true,activationRetested:false}}});
  await cleanup();process.exitCode=0;setTimeout(()=>process.exit(0),100).unref();
}
