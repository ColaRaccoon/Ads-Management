// Local-only, protected normalized input. This file never fetches provider data.
import 'reflect-metadata';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {readFileSync,readdirSync,writeFileSync,existsSync,mkdirSync,unlinkSync} from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Prisma,PrismaClient} from '@prisma/client';
import {normalizeProductNo} from '../../../apps/api/src/domain/cafe24-matcher.ts';

export const CLOSURE='07a2a332703b4027f891e168e9544caab22daa7b5b61526598de1de7023dc509';
export const OPERATION='20261020-cafe08-full-read-b';
const E='C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation';
const CANDIDATE=E+'/candidate-20261020-v5';
const require=createRequire(import.meta.url);
export const sha=value=>createHash('sha256').update(value).digest('hex');
const reject=()=>{throw Error('LOCAL_LIVE_INPUT_REJECTED');};
export function canonicalJson(value){if(value===null||typeof value!=='object')return JSON.stringify(value);if(Array.isArray(value))return'['+value.map(canonicalJson).join(',')+']';return'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonicalJson(value[key])).join(',')+'}';}
export function changedQuantity(value){const quantity=new Prisma.Decimal(value);return(quantity.gt('0.0001')?quantity.minus('0.0001'):quantity.plus('0.0001')).toFixed(4);}
export function ownedPasswordPath(root){if(!/^C:\/Users\/seong\/AppData\/Local\/MetaAdsPhase08Runtime\/cafe-live-local-[a-f0-9-]{36}$/.test(root))reject();const target=path.resolve(root,'initdb-owner-password.txt');if(path.dirname(target)!==path.resolve(root)||path.basename(target)!=='initdb-owner-password.txt')reject();return target;}
export async function publishedAuditCount(db,runId,day){return db.securityAuditEvent.count({where:{action:'SYNC_UNIT_PUBLISHED',targetId:runId+':'+day}});}
export function assertBaselineValues(orders,versions,lines){
 if(orders.length!==versions.length||orders.length!==lines.length)reject();
 for(const row of orders){
  const v=versions.find(x=>x.orderNo===row.orderNo.trim()&&x.lineOrderNo===row.lineOrderNo.trim()),l=lines.find(x=>x.orderNo===row.orderNo.trim()&&x.lineOrderNo===row.lineOrderNo.trim());if(!v||!l||v.version!==1||v.fingerprintKeyVersion!==2||l.importVersion!==1||l.productName!==row.productName||!v.isCurrent||!l.isCurrent)reject();
  const expected={orderNo:row.orderNo.trim(),lineOrderNo:row.lineOrderNo.trim(),productNo:normalizeProductNo(row.productNo),optionName:row.optionName.trim(),paymentMethod:row.paymentMethod,totalPaidInputSource:row.totalPaidInputSource??null,providerCouponSignal:row.providerCouponSignal??null};
  for(const [key,value]of Object.entries(expected))if((v[key]??null)!==value||(l[key]??null)!==value)reject();
  for(const key of ['orderStatus','lineStatus'])if((v[key]??null)!==(row[key]??null))reject();
  for(const stored of [v,l])if(JSON.stringify(stored.providerPaymentCodes??null)!==JSON.stringify(row.providerPaymentCodes??null))reject();
  for(const field of decimals){if(row[field]==null){if(v[field]!=null)reject();}else if(v[field]==null||!new Prisma.Decimal(v[field]).eq(row[field]))reject();if(!['cancelAmountKrw','refundAmountKrw','discountAmountKrw','couponAmountKrw'].includes(field)){if(row[field]==null){if(l[field]!=null)reject();}else if(l[field]==null||!new Prisma.Decimal(l[field]).eq(row[field]))reject();}}
  for(const field of dateFields){if(row[field]==null){if(v[field]!=null)reject();}else if(!(v[field] instanceof Date)||v[field].getTime()!==row[field].getTime())reject();if(['orderedAt','orderDate','providerUpdatedAt'].includes(field)&&(l[field]?.getTime()??null)!==(row[field]?.getTime()??null))reject();}
 }
}
export function assertLocalSocket(args){const first=Array.isArray(args[0])?args[0][0]:args[0];const host=typeof first==='object'&&first!==null?first.host:args[1],port=typeof first==='object'&&first!==null?first.port:first;if(host!=='127.0.0.1'||Number(port)!==55436||typeof first==='object'&&first?.path)reject();}
const exactKeys=(value,keys)=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k)))reject();};
const dateFields=['orderedAt','orderDate','providerUpdatedAt','cancelledAt','refundedAt'];
const decimals=['quantity','salePriceKrw','totalOrderKrw','totalPaidKrw','actualOrderPriceKrw','actualPaymentKrw','actualShippingFeeKrw','initialOrderPriceKrw','initialPaymentKrw','initialShippingFeeKrw','cancelAmountKrw','refundAmountKrw','discountAmountKrw','couponAmountKrw'];
const rowKeys=['orderNo','lineOrderNo','productNo','productName','optionName',...dateFields,...decimals,'paymentMethod','totalPaidInputSource','providerPaymentCodes','providerCouponSignal','orderStatus','lineStatus'];
export function rehydrateLine(row,day){
 exactKeys(row,rowKeys);const out={...row};
 for(const field of dateFields){if(row[field]==null){if(['orderedAt','orderDate'].includes(field))reject();if(field in row)out[field]=null;continue;}if(typeof row[field]!=='string'||!/^\d{4}-\d\d-\d\dT/.test(row[field])||!Number.isFinite(Date.parse(row[field])))reject();out[field]=new Date(row[field]);}
 if(out.orderDate.toISOString()!==day+'T00:00:00.000Z')reject();
 for(const field of decimals){if(row[field]==null){if(['quantity','salePriceKrw','totalPaidKrw'].includes(field))reject();continue;}if(typeof row[field]!=='string'||!/^\d+(?:\.\d+)?$/.test(row[field])||!new Prisma.Decimal(row[field]).isFinite())reject();/* Writer accepts decimal strings, not Number/Decimal objects. */}
 if(['orderNo','lineOrderNo','productNo','productName'].some(k=>typeof out[k]!=='string'||!out[k].trim())||typeof out.optionName!=='string')reject();
 return out;
}
export function validateInput(input){
 exactKeys(input,['kind','days','sourceClosureSha256']);
 if(input.kind!=='CAFE08_LOCAL_LIVE_INPUT_V1'||input.sourceClosureSha256!==CLOSURE||!Array.isArray(input.days)||input.days.length!==2)reject();
 return ['2026-10-16','2026-10-17'].map(day=>{
  const entry=input.days.find(v=>v?.envelope?.day===day);if(!entry)reject();exactKeys(entry,['envelope','proof']);
  const {envelope:e,proof}=entry;
  exactKeys(e,['kind','version','operationKey','day','eligibleSecretRollback','sourcePins','normalizedPayloadBase64','normalizedPayloadSha256','normalizedPayloadBytes']);
  if(e.kind!=='CAFE08_NORMALIZED_WRITER_INPUT'||e.version!==1||e.operationKey!==OPERATION||e.eligibleSecretRollback!==false||!e.sourcePins||typeof e.normalizedPayloadBase64!=='string')reject();
  const bytes=Buffer.from(e.normalizedPayloadBase64,'base64');try{
   if(bytes.length<2||bytes.length>2097152||bytes.toString('base64')!==e.normalizedPayloadBase64||bytes.length!==e.normalizedPayloadBytes||sha(bytes)!==e.normalizedPayloadSha256)reject();
   const p=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes));
   exactKeys(p,['kind','version','day','orders','orderCount','lineCount','pageCount','fetchedAt','completeTwoPass','normalizerSourceClosureSha256','eligibleSecretRollback']);
   if(p.kind!=='CAFE08_NORMALIZED_DAY_PAYLOAD'||p.version!==1||p.day!==day||p.eligibleSecretRollback!==false||p.completeTwoPass!==true||p.normalizerSourceClosureSha256!==CLOSURE||!Array.isArray(p.orders)||p.orders.length<1||p.orders.length>10000||p.lineCount!==p.orders.length||!Number.isSafeInteger(p.orderCount)||p.orderCount<1||p.orderCount>500||!Number.isSafeInteger(p.pageCount)||p.pageCount<1||p.pageCount>2050||typeof p.fetchedAt!=='string'||!Number.isFinite(Date.parse(p.fetchedAt))||Date.parse(p.fetchedAt)>Date.now())reject();
   // Deliberate small projection: PS must derive these only from the frozen public day receipt.
   exactKeys(proof,['day','completeTwoPass','normalizedPayloadSha256','normalizedPayloadBytes','orderCount','lineCount','pageCount','fetchedAt','sourcePins']);
   if(proof.day!==day||proof.completeTwoPass!==true||proof.normalizedPayloadSha256!==e.normalizedPayloadSha256||proof.normalizedPayloadBytes!==bytes.length||proof.orderCount!==p.orderCount||proof.lineCount!==p.lineCount||proof.pageCount!==p.pageCount||proof.fetchedAt!==p.fetchedAt||canonicalJson(proof.sourcePins)!==canonicalJson(e.sourcePins))reject();
   const orders=p.orders.map(row=>rehydrateLine(row,day));if(new Set(orders.map(r=>r.orderNo)).size!==p.orderCount||new Set(orders.map(r=>r.orderNo+'\0'+r.lineOrderNo)).size!==orders.length)reject();
   return {day,orders,pageCount:p.pageCount,fetchedAt:new Date(p.fetchedAt),payloadSha256:e.normalizedPayloadSha256,orderCount:p.orderCount};
  }finally{bytes.fill(0);}
 });
}
export function sourceClosure(repo){
 const root=path.join(repo,'apps/api/src');const files=[];
 const walk=dir=>{for(const entry of readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory())walk(file);else if(entry.name.endsWith('.ts'))files.push(file);}};walk(root);files.sort();
 const rows=files.map(file=>{const name=path.relative(repo,file).replaceAll('\\','/'),b=readFileSync(file);if(!b.equals(readFileSync(path.join(CANDIDATE,name))))reject();return{name,bytes:b.length,sha256:sha(b)};});
 if(rows.length!==285||sha(JSON.stringify(rows))!==CLOSURE)reject();return rows.length;
}
export function localConfiguration(){
 const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
 return {DAILY_SYNC_FEATURE_ENABLED:'true',DAILY_SYNC_SCHEDULE_ENABLED:'false',DAILY_SYNC_ALLOWED_ACCOUNTS:'["CAFE24/didadi0729/shop1"]',DAILY_SYNC_CAFE24_APP_API_VERSION:'2026-09-01',DAILY_SYNC_CAFE24_APP_API_VERSION_VERIFIED_AT:day,DAILY_SYNC_CAFE24_SELLER_DROPDOWN:'true',DAILY_SYNC_CAFE24_SELLER_DROPDOWN_VERIFIED_AT:day,DAILY_SYNC_CAFE24_RAW_ALL_ITEMS_V1_VERIFIED:'true',DAILY_SYNC_CAFE24_RAW_ALL_ITEMS_V1_VERIFIED_AT:day,DAILY_SYNC_CAFE24_VERIFIED_V1_STATUSES:'["C40","C48","E00","N00","N20","N30","N40","R00","R30","R40","C47"]',DAILY_SYNC_CAFE24_OBSERVATION_REBASELINE_REQUIRED:'false',DAILY_SYNC_CAFE24_OBSERVATION_KEY_VERSION:'2',DAILY_SYNC_CAFE24_OBSERVATION_KEY_B64:randomBytes(32).toString('base64')};
}
export async function runLocal(input,{privateRoot,publicRoot,repo=process.cwd()}={}){
 const days=validateInput(input);sourceClosure(repo);
 if(!/^C:\/Users\/seong\/AppData\/Local\/MetaAdsPhase08Runtime\/cafe-live-local-[a-f0-9-]{36}$/.test(privateRoot)||!/^C:\/Users\/seong\/AppData\/Local\/MetaAdsPhase10Evaluation\/cafe-live-input-local-20261020-v1\/attempt-[a-f0-9-]{36}$/.test(publicRoot)||!existsSync(privateRoot)||existsSync(publicRoot))reject();
 // The only network target is the new owned native PostgreSQL listener.
 globalThis.fetch=()=>{throw Error('EGRESS_FORBIDDEN');};const originalConnect=net.Socket.prototype.connect;
 net.Socket.prototype.connect=function(...args){assertLocalSocket(args);return originalConnect.apply(this,args);};
 const priorEnv={...process.env};for(const name of Object.keys(process.env))if(!['SystemRoot','PATH','TEMP','TMP','TSX_TSCONFIG_PATH'].includes(name))delete process.env[name];Object.assign(process.env,localConfiguration());
 const bin='C:/Users/seong/AppData/Local/MetaAdsCafe24Phase06Harness/node_modules/@embedded-postgres/windows-x64/native/bin';
 const {Client}=require('C:/Users/seong/AppData/Local/MetaAdsCafe24Phase06Harness/node_modules/pg');
 const data=privateRoot+'/pg-data',dbName='cafe_local_'+randomUUID().replaceAll('-',''),owner='cafe_live_owner',ownerPassword=randomBytes(32).toString('hex'),runtimePassword=randomBytes(32).toString('hex');let pg,db,started=false,stage='PORT_GUARD';
 const result={kind:'CAFE08_ACTUAL_NORMALIZED_INPUT_LOCAL_WRITER',status:'FAIL',days:[],providerRequests:0,remoteRequests:0,realProviderCredentialsUsed:false,productEdits:0,sourceFileCount:285,sourceClosureSha256:CLOSURE,localConfigOnly:true,remoteHoldChanged:false,observationHistoryRebaselineProven:false,legacyMappingCopied:false,rawValuesReturned:0,privateNativeRoot:privateRoot,localDatabaseAuthentication:'SCRAM_SHA_256',randomLocalOwnerRuntimeCredentialsBits:256,temporaryPlaintextPasswordFilesCreated:0,temporaryPasswordFileRemaining:null};
 const command=(exe,args)=>{const r=spawnSync(exe,args,{encoding:'utf8',windowsHide:true,timeout:60000,maxBuffer:1048576});if(r.status!==0)reject();};
 try{
  await new Promise((resolve,rejectPort)=>{const server=net.createServer();server.once('error',rejectPort);server.listen(55436,'127.0.0.1',()=>server.close(resolve));});
  stage='NATIVE_INIT';const passwordPath=ownedPasswordPath(privateRoot),passwordBytes=Buffer.from(ownerPassword+'\n');
  try{writeFileSync(passwordPath,passwordBytes,{flag:'wx'});result.temporaryPlaintextPasswordFilesCreated=1;command(bin+'/initdb.exe',['-D',data,'-U',owner,'--auth-local=scram-sha-256','--auth-host=scram-sha-256','--pwfile='+passwordPath,'--encoding=UTF8','--locale=C']);}
  finally{passwordBytes.fill(0);if(result.temporaryPlaintextPasswordFilesCreated===1){if(ownedPasswordPath(privateRoot)!==passwordPath)reject();unlinkSync(passwordPath);}result.temporaryPasswordFileRemaining=existsSync(passwordPath);}
  if(result.temporaryPasswordFileRemaining)reject();
  command(bin+'/pg_ctl.exe',['-D',data,'-l',privateRoot+'/postgres.log','-o','-h 127.0.0.1 -p 55436 -c password_encryption=scram-sha-256 -c log_statement=none -c log_min_error_statement=panic -c log_parameter_max_length_on_error=0','-w','start']);started=true;
  pg=new Client({host:'127.0.0.1',port:55436,user:owner,password:ownerPassword,database:'postgres'});await pg.connect();await pg.query(`CREATE DATABASE ${dbName}`);await pg.end();
  pg=new Client({host:'127.0.0.1',port:55436,user:owner,password:ownerPassword,database:dbName});await pg.connect();await pg.query('CREATE SCHEMA meta_ads;SET search_path=meta_ads,public');
  const migrations=readdirSync(repo+'/apps/api/prisma/migrations',{withFileTypes:true}).filter(x=>x.isDirectory()).map(x=>x.name).sort();if(migrations.length!==51)reject();
  for(const name of migrations){const bytes=readFileSync(`${repo}/apps/api/prisma/migrations/${name}/migration.sql`);if(!bytes.equals(readFileSync(`${CANDIDATE}/apps/api/prisma/migrations/${name}/migration.sql`)))reject();await pg.query(bytes.toString('utf8'));}result.migrations=51;
  await pg.query(`CREATE ROLE cafe_live_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS CONNECTION LIMIT 3 PASSWORD '${runtimePassword}';GRANT USAGE ON SCHEMA meta_ads TO cafe_live_runtime;GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA meta_ads TO cafe_live_runtime;GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA meta_ads TO cafe_live_runtime`);
  let denied=0;for(const [user,password]of [[owner,'incorrect-local-only'],['cafe_live_runtime','incorrect-local-only'],['cafe_live_runtime',undefined]]){const other=new Client({host:'127.0.0.1',port:55436,user,password,database:dbName,connectionTimeoutMillis:5000});try{await other.connect();}catch{denied++;}finally{await other.end().catch(()=>{});}}if(denied!==3)reject();result.wrongOrMissingPasswordDenied=3;
  const tableNames=(await pg.query("SELECT tablename FROM pg_tables WHERE schemaname='meta_ads'")).rows;if(tableNames.length!==68)reject();
  for(const {tablename}of tableNames){if(!/^[a-z0-9_]+$/.test(tablename))reject();await pg.query(`ALTER TABLE meta_ads."${tablename}" ENABLE ROW LEVEL SECURITY;ALTER TABLE meta_ads."${tablename}" FORCE ROW LEVEL SECURITY;CREATE POLICY local_live_fixture ON meta_ads."${tablename}" FOR ALL TO cafe_live_runtime USING(true) WITH CHECK(true)`);}
  const tableProof=(await pg.query("SELECT count(*)::int AS tables,count(*) FILTER(WHERE c.relrowsecurity AND c.relforcerowsecurity AND pg_get_userbyid(c.relowner)='cafe_live_owner')::int AS forced FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='meta_ads' AND c.relkind='r'")).rows[0];
  const roleProof=(await pg.query("SELECT rolname,rolsuper,rolbypassrls,rolconnlimit FROM pg_roles WHERE rolname='cafe_live_runtime'")).rows[0];if(tableProof.tables!==68||tableProof.forced!==68||roleProof.rolsuper||roleProof.rolbypassrls||roleProof.rolconnlimit!==3)reject();result.localRls={tables:68,enabledAndForced:68,ownerSeparated:true,runtimeBypass:false,fixturePolicies:68};
  process.env.DATABASE_URL=`postgresql://cafe_live_runtime:${runtimePassword}@127.0.0.1:55436/${dbName}?schema=meta_ads&connection_limit=3`;
  db=new PrismaClient({datasourceUrl:process.env.DATABASE_URL,log:[]});await db.$connect();
  const identity=await db.$queryRawUnsafe('SELECT current_database() AS database,current_user AS role');if(identity[0].database!==dbName||identity[0].role!=='cafe_live_runtime')reject();
  const {SyncFoundationService}=await import('../../../apps/api/src/daily-sync/sync-foundation.service.ts');const {Cafe24CanonicalWriterService}=await import('../../../apps/api/src/daily-sync/cafe24-canonical-writer.service.ts');const {HeavyOperationGate}=await import('../../../apps/api/src/common/heavy-operation.ts');
  const foundation=new SyncFoundationService(db,new HeavyOperationGate({heavyOperationConcurrency:1},{}));const writer=new Cafe24CanonicalWriterService(db,foundation);
  const connection=await db.sourceConnection.create({data:{provider:'CAFE24',externalAccountId:'didadi0729',shopKey:'shop1',displayName:'Local live input only',currencyCode:'KRW',timeZone:'Asia/Seoul',enabled:true,accessState:'READY'}});
  await db.sourcePolicy.create({data:{connectionId:connection.id,dataKind:'CAFE24_ORDER',primarySource:'API',fromDate:new Date('2026-10-16T00:00:00Z'),version:1,effectiveAt:new Date(),reason:'LOCAL_LIVE_INPUT_ONLY'}});
  const snapshot=async day=>{
   const where={connectionId:connection.id,orderDate:new Date(day+'T00:00:00Z')};
   const value={versions:await db.cafe24OrderApiVersion.findMany({where,orderBy:{id:'asc'}}),lines:await db.cafe24OrderLine.findMany({where,orderBy:{id:'asc'}}),links:await db.sourceRecordLink.findMany({where:{connectionId:connection.id},orderBy:{id:'asc'}}),coverage:await db.sourceCoverage.findMany({where:{connectionId:connection.id},orderBy:[{dataKind:'asc'},{metricDate:'asc'}]})};
   return {digest:sha(JSON.stringify(value)),versions:value.versions.length,current:value.lines.filter(v=>v.isCurrent).length,unmatched:value.lines.filter(v=>v.isCurrent&&v.validationStatus==='UNMATCHED').length};
  };
  const canonicalState=async()=>({v:await db.cafe24OrderApiVersion.findMany({orderBy:{id:'asc'}}),l:await db.cafe24OrderLine.findMany({orderBy:{id:'asc'}}),k:await db.sourceRecordLink.findMany({orderBy:{id:'asc'}})});
  const canonical=async()=>sha(JSON.stringify(await canonicalState()));
  const publish=async(day,orders,label,expectFailure=false)=>{
   const run=await foundation.queueRun({connectionId:connection.id,fromDate:day.day,toDate:day.day,trigger:'MANUAL',actorUserId:null,requestKey:'local-live:'+label+':'+randomUUID()});const claim=await foundation.claimRun(run.id);if(!claim)reject();let rejected=false;
   const before=expectFailure?await snapshot(day.day):null;const beforeRun=expectFailure?sha(JSON.stringify(await db.syncRun.findUnique({where:{id:run.id},include:{units:true}}))):null;
   try{await writer.publishCafe24Day({connectionId:connection.id,runId:run.id,generation:claim.generation,metricDate:new Date(day.day+'T00:00:00Z'),pageCount:day.pageCount,policyVersion:1,completeDaySnapshot:true,fetchedAt:day.fetchedAt,orders});}catch{rejected=true;if(expectFailure&&(await snapshot(day.day)).digest!==before.digest)reject();if(expectFailure&&sha(JSON.stringify(await db.syncRun.findUnique({where:{id:run.id},include:{units:true}})))!==beforeRun)reject();}
   finally{await foundation.finishRun(claim);claim.release();}
   const actualRun=await db.syncRun.findUniqueOrThrow({where:{id:run.id}});if(rejected!==expectFailure||(!expectFailure&&actualRun.status!=='SUCCEEDED'))reject();
   if(expectFailure){if((await snapshot(day.day)).digest!==before.digest||await publishedAuditCount(db,run.id,day.day)!==0)reject();}
   return actualRun.status;
  };
  for(const day of days){
   stage='LOCAL_DAY_BASELINE';await publish(day,day.orders,'baseline');const first=await snapshot(day.day);if(first.current!==day.orders.length||first.versions!==day.orders.length||first.unmatched!==day.orders.length)reject();const where={connectionId:connection.id,orderDate:new Date(day.day+'T00:00:00Z'),isCurrent:true};assertBaselineValues(day.orders,await db.cafe24OrderApiVersion.findMany({where}),await db.cafe24OrderLine.findMany({where}));
   stage='LOCAL_V1_METADATA_REKEY_ONLY';await db.cafe24OrderApiVersion.updateMany({where:{connectionId:connection.id,orderDate:new Date(day.day+'T00:00:00Z'),isCurrent:true},data:{fingerprintKeyVersion:1,contentFingerprint:'0'.repeat(64)}});const metadataOnly=await canonical();await publish(day,day.orders,'rekey');if(await canonical()!==metadataOnly)reject();
   // Coverage now names a new successful run, but canonical versions and rows must stay byte equal.
   const stable=await canonical();await publish(day,day.orders,'identical-replay');if(await canonical()!==stable)reject();
   stage='LOCAL_CLONED_CONTENT_CHANGE';const beforeChange=await canonicalState(),changed=day.orders.map(row=>({...row}));changed[0].quantity=changedQuantity(changed[0].quantity);
   const previousVersion=beforeChange.v.find(v=>v.isCurrent&&v.orderDate.toISOString().slice(0,10)===day.day&&v.orderNo===changed[0].orderNo.trim()&&v.lineOrderNo===changed[0].lineOrderNo.trim());if(!previousVersion)reject();const previousLine=beforeChange.l.find(v=>v.isCurrent&&v.orderNo===previousVersion.orderNo&&v.lineOrderNo===previousVersion.lineOrderNo);if(!previousLine)reject();
   const unaffected=value=>sha(JSON.stringify({v:value.v.filter(v=>v.canonicalKeyHash!==previousVersion.canonicalKeyHash),l:value.l.filter(v=>v.orderLineKey!==previousLine.orderLineKey),k:value.k.filter(v=>v.canonicalKeyHash!==previousVersion.canonicalKeyHash)}));
   await publish(day,changed,'cloned-quantity-variant');const revised=await snapshot(day.day),afterChange=await canonicalState();if(revised.current!==day.orders.length||revised.versions!==first.versions+1||unaffected(beforeChange)!==unaffected(afterChange))reject();
   const newVersion=afterChange.v.find(v=>v.isCurrent&&v.canonicalKeyHash===previousVersion.canonicalKeyHash),newLine=afterChange.l.find(v=>v.isCurrent&&v.orderLineKey===previousLine.orderLineKey);if(!newVersion||!newLine||newVersion.version!==2||newVersion.fingerprintKeyVersion!==2||newLine.importVersion!==2||!newVersion.quantity.eq(changed[0].quantity)||!newLine.quantity.eq(changed[0].quantity)||newVersion.id===previousVersion.id||newLine.id===previousLine.id||afterChange.k.filter(v=>v.isCurrent&&v.canonicalKeyHash===previousVersion.canonicalKeyHash&&v.version===2&&v.recordId===newLine.id).length!==1)reject();
   stage='LOCAL_OMISSION_TX_ROLLBACK';await publish(day,changed.slice(1),'omission',true);
   stage='LOCAL_REQUIRED_FIELD_REJECTION';const malformed=changed.map(row=>({...row}));malformed[0].quantity=null;await publish(day,malformed,'required-field',true);
   result.days.push({day:day.day,normalizedPayloadSha256:day.payloadSha256,orderCount:day.orderCount,lineCount:day.orders.length,baselineVersion1:true,allUnmatched:true,v1MetadataOnlyRekeyNoBusinessRevision:true,identicalReplayNoDuplicate:true,clonedContentVariantAddsExactlyOneVersion:true,omissionRejectedTransactionPreserved:true,requiredFieldRejectedNoPublish:true,currentCount:revised.current,versionCount:revised.versions});
  }
  if(await db.cafe24ObservedOrderRevision.count()!==0||await db.cafe24ObservedDayCheckpoint.count()!==0)reject();
  result.observationTablesRemainEmpty=true;result.status='PASS';
 }catch{result.failure={stage,safeCode:'LOCAL_LIVE_INPUT_REJECTED',rawErrorSuppressed:true};}
 finally{
  await db?.$disconnect().catch(()=>{});await pg?.end().catch(()=>{});
  if(started){result.postgresStopExit=spawnSync(bin+'/pg_ctl.exe',['-D',data,'-m','fast','-w','stop'],{windowsHide:true,stdio:'ignore',timeout:30000}).status;if(result.postgresStopExit!==0)result.status='FAIL';}
  else result.postgresStarted=false;
  net.Socket.prototype.connect=originalConnect;for(const k of Object.keys(process.env))if(!(k in priorEnv))delete process.env[k];Object.assign(process.env,priorEnv);
 }
 mkdirSync(publicRoot,{recursive:true});writeFileSync(publicRoot+'/result.json',JSON.stringify(result,null,2)+'\n',{flag:'wx'});return result;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 let text='';try{if(process.env.CAFE_LIVE_LOCAL_PARENT!=='20261020-ROOT')reject();for await(const part of process.stdin){text+=part;if(Buffer.byteLength(text)>8388608)reject();}const wire=JSON.parse(text);text='';const result=await runLocal(wire.input,{privateRoot:wire.privateRoot,publicRoot:wire.publicRoot});process.stdout.write(JSON.stringify({status:result.status,days:result.days,postgresStopExit:result.postgresStopExit??null,rawValuesReturned:0}));if(result.status!=='PASS')process.exitCode=1;}catch{process.stdout.write('{"status":"FAIL","safeCode":"LOCAL_LIVE_INPUT_REJECTED","rawErrorSuppressed":true,"rawValuesReturned":0}');process.exitCode=1;}finally{text='';}
}
