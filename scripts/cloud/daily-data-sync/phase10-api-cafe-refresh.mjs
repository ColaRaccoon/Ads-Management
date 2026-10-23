// Root-orchestrated one-time renewal of the existing isolated Cafe24 pair.
// No order read, scheduler change, checkpoint resume or original token restore.
import {PrismaClient} from '@prisma/client';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {readFileSync,lstatSync,existsSync} from 'node:fs';
import {assertBusinessDatabaseTarget} from './seed-isolated-business-config.mjs';
import {CredentialVault} from '../../../apps/api/src/daily-sync/credential-vault.ts';
import {Cafe24OauthService} from '../../../apps/api/src/daily-sync/cafe24-oauth.service.ts';
import {ProviderFailure} from '../../../apps/api/src/daily-sync/bounded-request.ts';
const ID='0c35defe-45fc-4a54-bc79-704df7bca5b1';
const PRIVATE='C:/Users/seong/AppData/Local/MetaAdsPhase08Runtime';
const ENV_KEYS=['DAILY_SYNC_CAFE24_CLIENT_ID','DAILY_SYNC_CAFE24_CLIENT_SECRET','DAILY_SYNC_CAFE24_REDIRECT_URI','DAILY_SYNC_CAFE24_ISOLATED_ORIGIN','DAILY_SYNC_CAFE24_RAILWAY_CALLBACK_ENABLED','DAILY_SYNC_ACTIVE_KEY_VERSION','DAILY_SYNC_CREDENTIAL_KEY_V1'];
const fail=()=>{throw Error('PHASE10_REFRESH_SAFE_REJECTED');};
const hash=value=>createHash('sha256').update(value).digest('hex');
function protectSnapshot(snapshot,operationKey){
 const path=`${PRIVATE}/phase10-cafe-pair-before-${operationKey}.dpapi`;
 if(!lstatSync(PRIVATE).isDirectory()||lstatSync(PRIVATE).isSymbolicLink()||existsSync(path))fail();
 // DPAPI plaintext travels only through stdin. No token or key is passed on a
 // command line. The file receives an explicit current-user-only Windows ACL.
 const script=`$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;$raw=[Console]::In.ReadToEnd();$plain=[Text.Encoding]::UTF8.GetBytes($raw);try{$sealed=[Security.Cryptography.ProtectedData]::Protect($plain,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);$stream=[IO.File]::Open($env:PHASE10_BACKUP_FILE,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$stream.Write($sealed,0,$sealed.Length);$stream.Flush($true)}finally{$stream.Dispose()};$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$acl=[Security.AccessControl.FileSecurity]::new();$acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false);$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','Allow'));Set-Acl -LiteralPath $env:PHASE10_BACKUP_FILE -AclObject $acl;$read=Get-Acl -LiteralPath $env:PHASE10_BACKUP_FILE;if(-not $read.AreAccessRulesProtected -or $read.Access.Count -ne 1 -or $read.Access[0].IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){throw 'ACL_REJECTED'}}finally{[Array]::Clear($plain,0,$plain.Length);$raw=$null}`;
 const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{
  input:JSON.stringify(snapshot),encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:8192,
  env:{SystemRoot:process.env.SystemRoot,PATH:process.env.PATH,TEMP:process.env.TEMP,USERPROFILE:process.env.USERPROFILE,PHASE10_BACKUP_FILE:path}});
 if(result.status!==0||result.error||!lstatSync(path).isFile()||lstatSync(path).isSymbolicLink())fail();
 const bytes=readFileSync(path);if(bytes.length<128||bytes.length>65536)fail();return{path,sha256:hash(bytes),currentUserDpapi:true,currentUserOnlyAcl:true};
}
export async function refreshPhase10CafeOnce(input,{factory=url=>new PrismaClient({datasourceUrl:url}),request=fetch,protect=protectSnapshot,
 makeAuth=(db,tracked)=>new Cafe24OauthService(db,new CredentialVault(db),tracked)}={}){
 let db,stage='TARGET',calls=0,blockedRepeats=0,backup=null,submitted=false;const previous={};
 try{
  if(input?.classification!=='SAME_SCOPE_EXACT_PAIR_REFRESH_ONCE'||input.projectRef!=='ehnfrrmbkvlsbpvqcvkr'||
    !/^20261019-[a-z0-9-]{3,40}$/.test(input.operationKey??'')||new Date().toISOString().slice(0,10)!=='2026-10-19'||
    input.env?.SUPABASE_DATABASE_SCHEMA!=='phase08_meta_ads'||input.env?.SUPABASE_DATABASE_RUNTIME_USER!=='phase08_runtime')fail();
  stage='CONFIGURATION';const env=input.env,redirect=new URL(env.DAILY_SYNC_CAFE24_REDIRECT_URI??'');
  const isolatedOrigins=new Set(['https://phase08-daily-data-sync-production.up.railway.app','https://cafe24-callback-test-production.up.railway.app','https://grand-fascination-staging.up.railway.app']);
  if((env.DAILY_SYNC_ACTIVE_KEY_VERSION??'1')!=='1'||! /^[A-Za-z0-9+/]{43}=$/.test(env.DAILY_SYNC_CREDENTIAL_KEY_V1??'')||
    !/^[A-Za-z0-9]{8,128}$/.test(env.DAILY_SYNC_CAFE24_CLIENT_ID??'')||typeof env.DAILY_SYNC_CAFE24_CLIENT_SECRET!=='string'||!env.DAILY_SYNC_CAFE24_CLIENT_SECRET||env.DAILY_SYNC_CAFE24_CLIENT_SECRET.length>512||
    redirect.protocol!=='https:'||redirect.origin!==env.DAILY_SYNC_CAFE24_ISOLATED_ORIGIN||!isolatedOrigins.has(redirect.origin)||redirect.pathname!=='/backend-api/integrations/cafe24/oauth/callback'||redirect.search||redirect.hash||redirect.port||redirect.username||redirect.password||
    redirect.origin==='https://grand-fascination-staging.up.railway.app'&&env.DAILY_SYNC_CAFE24_RAILWAY_CALLBACK_ENABLED!=='true')fail();
  db=factory(assertBusinessDatabaseTarget({projectRef:input.projectRef,freshVerified:true,databaseUrl:input.databaseUrl}));
  const snapshot=async expectedRevision=>db.$transaction(async tx=>{
   await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');await tx.$executeRawUnsafe("SET LOCAL statement_timeout='5000'");
   const identity=await tx.$queryRawUnsafe("SELECT current_database() AS database,current_user AS role,current_schema() AS schema,current_setting('transaction_read_only') AS readonly,(SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='phase08_meta_ads' AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity) AS tables,(SELECT count(*)::int FROM sync_leases WHERE connection_id=$1::uuid AND expires_at>clock_timestamp()) AS leases",ID);
   if(identity.length!==1||identity[0].database!=='postgres'||identity[0].role!=='phase08_runtime'||identity[0].schema!=='phase08_meta_ads'||identity[0].readonly!=='on'||identity[0].tables!==68||identity[0].leases!==0)fail();
   const connection=await tx.sourceConnection.findUnique({where:{id:ID},select:{id:true,provider:true,externalAccountId:true,shopKey:true,currencyCode:true,timeZone:true,enabled:true,accessState:true,credentialRef:true,credentialExpiresAt:true}});
   if(!connection||connection.provider!=='CAFE24'||connection.externalAccountId!=='didadi0729'||connection.shopKey!=='shop1'||connection.currencyCode!=='KRW'||connection.timeZone!=='Asia/Seoul'||!connection.enabled||connection.accessState!=='READY'||connection.credentialRef!==`source_credentials:${ID}:CAFE24_REFRESH`)fail();
   const pair=await tx.sourceCredential.findMany({where:{connectionId:ID},orderBy:{kind:'asc'}});
   if(pair.length!==2||pair.some(row=>!['CAFE24_ACCESS','CAFE24_REFRESH'].includes(row.kind)||row.revision!==expectedRevision||row.keyVersion!==1||row.refreshOwner!==null||row.refreshUntil!==null||!(row.expiresAt instanceof Date)||!Number.isFinite(row.expiresAt.getTime())||row.iv.length!==12||row.authTag.length!==16||row.ciphertext.length<1||row.ciphertext.length>8192))fail();
   const access=pair.find(row=>row.kind==='CAFE24_ACCESS'),refresh=pair.find(row=>row.kind==='CAFE24_REFRESH');
   if(!access||!refresh||refresh.expiresAt.getTime()<Date.now()+12*60000)fail();
   if(expectedRevision===6&&(access.expiresAt.toISOString()!=='2026-10-17T19:00:16.000Z'||refresh.expiresAt.toISOString()!=='2026-10-31T17:00:16.000Z'||access.expiresAt>Date.now()))fail();
   if(expectedRevision===7&&access.expiresAt.getTime()<Date.now()+11*60000)fail();
   return{identity:identity[0],connection,pair:pair.map(row=>({...row,ciphertext:Buffer.from(row.ciphertext).toString('base64'),iv:Buffer.from(row.iv).toString('base64'),authTag:Buffer.from(row.authTag).toString('base64')}))};
  },{timeout:10000,maxWait:1000});
  stage='REVISION6_READONLY';const before=await snapshot(6),beforeSha=hash(JSON.stringify(before));
  stage='PROTECTED_BACKUP';backup=protect(before,input.operationKey);
  if(!backup?.currentUserDpapi||!backup?.currentUserOnlyAcl||typeof backup.sha256!=='string'||!/^[a-f0-9]{64}$/.test(backup.sha256))fail();
  stage='FRESH_REVISION6_READONLY';if(hash(JSON.stringify(await snapshot(6)))!==beforeSha)fail();
  for(const name of ENV_KEYS){previous[name]=process.env[name];if(input.env[name]===undefined)delete process.env[name];else process.env[name]=input.env[name];}
  const tracked=async(url,options={})=>{
   if(String(url)!=='https://didadi0729.cafe24api.com/api/v2/oauth/token'||options.method!=='POST'||typeof options.body!=='string')fail();
   const body=new URLSearchParams(options.body);if([...body.keys()].sort().join()!=='grant_type,refresh_token'||body.get('grant_type')!=='refresh_token'||!body.get('refresh_token'))fail();
   if(calls!==0){blockedRepeats++;throw new ProviderFailure('PROVIDER_AUTH_REQUIRED',false);}
   calls++;submitted=true;
   const response=await request(url,{...options,redirect:'error',signal:AbortSignal.any([AbortSignal.timeout(20000),...(options.signal?[options.signal]:[])])});
   if(!response.ok)return response;
   // A refresh must retain exactly the existing read_order permission. The
   // ordinary OAuth client accepts a superset, which is too broad here.
   stage='TOKEN_SCOPE_RESPONSE';const length=response.headers.get('content-length');
   if(length!==null&&(!/^\d+$/.test(length)||Number(length)>32768))fail();
   if(!response.body)fail();const reader=response.body.getReader(),chunks=[];let bytes=0;
   try{while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>32768||chunks.length>=512){await reader.cancel();fail();}chunks.push(part.value);}}
   finally{reader.releaseLock();}
   const responseBytes=Buffer.concat(chunks.map(chunk=>Buffer.from(chunk))),parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(responseBytes));
   stage='TOKEN_SCOPE_EXACT';if(!Array.isArray(parsed?.scopes)||parsed.scopes.length!==1||parsed.scopes[0]!=='mall.read_order')fail();
   return new Response(responseBytes,{status:response.status,statusText:response.statusText,headers:response.headers});
  };
  stage='EXACT_PAIR_REFRESH_POST';let access=await makeAuth(db,tracked).accessToken(ID,'didadi0729','shop1');access='';
  stage='REVISION7_READONLY';const after=await snapshot(7);
  if(calls!==1||blockedRepeats!==0)fail();
  return{kind:'PHASE10_EXISTING_ISOLATED_CAFE_PAIR_REFRESHED',observedAt:new Date().toISOString(),classification:input.classification,operationKey:input.operationKey,
   protectedBackup:backup,beforeSha256:beforeSha,afterSha256:hash(JSON.stringify(after)),providerTokenPostRequests:calls,providerOrderRequests:0,blockedRepeatRequests:blockedRepeats,
   beforeRevisions:[6,6],afterRevisions:[7,7],afterAccessExpiresAt:after.pair.find(row=>row.kind==='CAFE24_ACCESS').expiresAt.toISOString(),afterRefreshExpiresAt:after.pair.find(row=>row.kind==='CAFE24_REFRESH').expiresAt.toISOString(),
   refreshOwnerReleased:true,connectionReady:true,originalPairRestored:false,checkpointResumed:false,sourceRunWritesPerformed:0,productionWrites:0,rawValuesReturned:0};
 }catch{throw Object.assign(Error('PHASE10_REFRESH_SAFE_FAILURE'),{safeDiagnostic:{kind:'PHASE10_CAFE_REFRESH_FAILED',stage,providerTokenPostRequests:calls,providerOrderRequests:0,blockedRepeatRequests:blockedRepeats,submitted,protectedBackup:backup,inspectActualStateBeforeAnyRetry:true,rawErrorSuppressed:true}});}
 finally{for(const name of Object.keys(previous)){if(previous[name]===undefined)delete process.env[name];else process.env[name]=previous[name];}await db?.$disconnect().catch(()=>{});if(input){input.env=undefined;input.databaseUrl=undefined;}}
}
if(process.argv[1]?.endsWith('phase10-api-cafe-refresh.mjs')){
 let input,raw='',output;try{for await(const part of process.stdin){raw+=part;if(Buffer.byteLength(raw)>2097152)fail();}input=JSON.parse(raw);raw='';output=await refreshPhase10CafeOnce(input);}
 catch(error){output=error.safeDiagnostic??{kind:'PHASE10_CAFE_REFRESH_FAILED',rawErrorSuppressed:true};process.exitCode=1;}
 finally{input=undefined;raw='';}process.stdout.write(JSON.stringify(output));
}
