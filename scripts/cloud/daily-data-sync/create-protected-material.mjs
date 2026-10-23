// Protected caller captures stdout in memory, then stores only CurrentUser DPAPI.
// No network, provider requests or plaintext files are created here.
import { randomBytes, randomUUID, createPrivateKey, sign, createPublicKey, verify } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sealMetaVaultRecord } from '../../../apps/api/src/daily-sync/meta-protected-credential-resolver.ts';
import { validateMetaMcpCatalog } from '../../../apps/api/src/daily-sync/meta-mcp-wire-reader.ts';
const REF='ehnfrrmbkvlsbpvqcvkr';
const ORIGIN='https://phase08-daily-data-sync-production.up.railway.app';
const PRINCIPAL='daily-data-automation-ads-read@meta-ads-daily-automation.iam.gserviceaccount.com';
const secret=()=>randomBytes(32).toString('base64');
const encoded=value=>Buffer.from(JSON.stringify(value)).toString('base64');
export function createPhase08Material(input) {
  const old=input.oldRuntime;
  if(old?.SUPABASE_URL!==`https://${REF}.supabase.co` || old.SUPABASE_DATABASE_PROJECT_REF!==REF ||
    !old.SUPABASE_PUBLISHABLE_KEY || !old.SUPABASE_SECRET_KEY ||
    !/^[a-f0-9]{64}$/.test(input.sourceContentSha256 ?? '') ||
    input.jwk?.kid!=='1d7ff107-9e41-4935-86e2-b575337c6cfb' || input.jwk.kty!=='EC' || input.jwk.crv!=='P-256') throw new Error('PHASE08_MATERIAL_REJECTED');
  const adc=input.googleAdc;
  if(adc?.type!=='impersonated_service_account' || adc.source_credentials?.type!=='authorized_user' ||
    adc.service_account_impersonation_url!==`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${PRINCIPAL}:generateAccessToken`) throw new Error('PHASE08_MATERIAL_REJECTED');
  validateMetaMcpCatalog(input.catalog,input.reporting,input.catalog?.client_conversation_id,'PURCHASE_V1');
  const ids={googleConnectionId:randomUUID(),metaConnectionId:randomUUID(),cafe24ConnectionId:randomUUID(),
    googleCredentialId:randomUUID(),metaCredentialId:randomUUID(),storageSubject:randomUUID()};
  const now=Math.floor(Date.now()/1000);
  const claims={iss:`https://${REF}.supabase.co/auth/v1`,aud:'authenticated',sub:ids.storageSubject,
    role:'phase08_storage_app',iat:now,exp:now+6*86400};
  const header=Buffer.from(JSON.stringify({alg:'ES256',typ:'JWT',kid:input.jwk.kid})).toString('base64url');
  const payload=Buffer.from(JSON.stringify(claims)).toString('base64url');
  const message=Buffer.from(`${header}.${payload}`);
  const key=createPrivateKey({key:input.jwk,format:'jwk'});
  const signature=sign('sha256',message,{key,dsaEncoding:'ieee-p1363'});
  if(!verify('sha256',message,{key:createPublicKey(key),dsaEncoding:'ieee-p1363'},signature)) throw new Error('PHASE08_MATERIAL_REJECTED');
  const vaultKey=randomBytes(32);
  let record;
  try {record=sealMetaVaultRecord({credentialRef:`vault://meta/${ids.metaCredentialId}`,connectionId:ids.metaConnectionId,
    accountId:'2138525300002203',transport:'MCP',token:input.metaToken,inspectorToken:input.inspectorToken},vaultKey);}
  finally {input.metaToken=undefined;input.inspectorToken=undefined;}
  const runtimePassword=randomBytes(32).toString('hex');
  const dbHost='aws-0-ap-northeast-2.pooler.supabase.com';
  const env={NODE_ENV:'production',APP_ENV:'production',DEPLOYMENT_MODE:'cloud_container',AUTH_PROVIDER:'supabase',STORAGE_PROVIDER:'supabase',
    PORT:'8000',API_INTERNAL_PORT:'4200',API_PROXY_TARGET:'http://127.0.0.1:4200/api',
    API_NODE_MAX_OLD_SPACE_MB:'512',WEB_NODE_MAX_OLD_SPACE_MB:'192',NEXT_TELEMETRY_DISABLED:'1',HSTS_ENABLED:'true',
    RELEASE_GIT_SHA:'9e9a1f82bb02346575565b031a43e17e13758dc8',
    PHASE08_SOURCE_CONTENT_SHA256:input.sourceContentSha256,PHASE08_VERIFIED_ORIGIN:ORIGIN,
    APP_ALLOWED_ORIGINS:ORIGIN,AUTH_INVITE_REDIRECT_ORIGIN:ORIGIN,AUTH_COOKIE_NAMESPACE:'phase08',AUTH_COOKIE_SECURE:'true',
    AUTH_SESSION_HANDLE_SECRET:secret(),AUTH_AUTHORIZATION_VERSION_SECRET:secret(),AUTH_CSRF_SECRET:secret(),INTERNAL_PROBE_TOKEN:secret(),
    TRUST_PROXY_HOPS:'1',DEPLOYMENT_ENVIRONMENT_ID:'phase08-daily-data-sync-08',RUNTIME_API_TARGET_ID:'phase08-full-app',
    RUNTIME_DATABASE_ID:'phase08-isolated-db',RUNTIME_STORAGE_ID:'phase08-isolated-storage',
    PRISMA_CONNECTION_LIMIT:'3',PRISMA_IDLE_DISCONNECT_MS:'60000',HEAVY_OPERATION_CONCURRENCY:'1',
    READINESS_TIMEOUT_MS:'5000',DATABASE_READINESS_TIMEOUT_MS:'4000',
    SUPABASE_DATABASE_PROJECT_REF:REF,SUPABASE_DATABASE_CONNECTION_MODE:'session_pooler',SUPABASE_DATABASE_HOST:dbHost,
    SUPABASE_DATABASE_RUNTIME_USER:'phase08_runtime',SUPABASE_DATABASE_NAME:'postgres',SUPABASE_DATABASE_SCHEMA:'phase08_meta_ads',
    DATABASE_URL:`postgresql://phase08_runtime.${REF}:${runtimePassword}@${dbHost}:5432/postgres?schema=phase08_meta_ads&sslmode=verify-full&connection_limit=3&pool_timeout=10&connect_timeout=10`,
    SUPABASE_URL:old.SUPABASE_URL,SUPABASE_JWT_ISSUER:`${old.SUPABASE_URL}/auth/v1`,SUPABASE_JWT_AUDIENCE:'authenticated',
    SUPABASE_PUBLISHABLE_KEY:old.SUPABASE_PUBLISHABLE_KEY,SUPABASE_SECRET_KEY:old.SUPABASE_SECRET_KEY,
    SUPABASE_STORAGE_ACCESS_MODE:'rls',SUPABASE_STORAGE_TOKEN_ROLE:'phase08_storage_app',SUPABASE_STORAGE_TOKEN_SUBJECT:ids.storageSubject,
    SUPABASE_STORAGE_BUCKET:'meta-ads-phase08-isolated',SUPABASE_STORAGE_READINESS_KEY:'health/readiness-sentinel',
    SUPABASE_STORAGE_ACCESS_TOKEN:`${header}.${payload}.${signature.toString('base64url')}`,
    DAILY_SYNC_FEATURE_ENABLED:'false',DAILY_SYNC_SCHEDULE_ENABLED:'false',DAILY_SYNC_ALLOWED_ACCOUNTS:'[]',DAILY_SYNC_SCHEDULES:'[]',
    DAILY_SYNC_MACHINE_TOKEN:secret(),DAILY_SYNC_TARGET_ID:'phase08-full-app',DAILY_SYNC_CREDENTIAL_KEY_V1:secret(),
    DAILY_SYNC_ACTIVE_KEY_VERSION:'1',DAILY_SYNC_CHECKPOINT_KEY_B64:secret(),
    DAILY_SYNC_GOOGLE_CREDENTIAL_REF:`vault://google/${ids.googleCredentialId}`,
    PHASE08_GOOGLE_TARGET_PRINCIPAL:PRINCIPAL,PHASE08_GOOGLE_ADC_JSON_B64:encoded(adc),
    DAILY_SYNC_META_TRANSPORT:'MCP',DAILY_SYNC_META_MCP_USE_CASE:'OWN_ACCOUNT_INTERNAL_REPORTING',
    DAILY_SYNC_META_CREDENTIAL_REF:`vault://meta/${ids.metaCredentialId}`,DAILY_SYNC_META_VAULT_BACKEND:'ENCRYPTED_FILE',
    DAILY_SYNC_META_VAULT_KEY:vaultKey.toString('base64'),PHASE08_META_REF_UUID:ids.metaCredentialId,
    PHASE08_META_RECORD_B64:Buffer.from(record).toString('base64'),
    PHASE08_META_CATALOG_JSON_B64:encoded(input.catalog),PHASE08_META_REPORT_SCHEMA_JSON_B64:encoded(input.reporting)};
  vaultKey.fill(0);
  return {version:1,projectRef:REF,origin:ORIGIN,serviceId:'4b30daa8-9333-46b7-ad89-cfd64ff5266c',
    ids,env,runtimePassword,storageExpiresAt:new Date(claims.exp*1000).toISOString(),providerRequests:0};
}
if(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  try {let input='';for await(const bytes of process.stdin){input+=bytes;if(input.length>3_000_000)throw new Error();}
    const result=createPhase08Material(JSON.parse(input));input='';process.stdout.write(JSON.stringify(result));}
  catch {process.stderr.write('PHASE08_MATERIAL_PREPARATION_FAILED');process.exitCode=1;}
}
