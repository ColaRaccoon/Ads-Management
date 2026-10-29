import { existsSync, lstatSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, delimiter, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const target = Object.freeze({ projectRef:'iygjmosbelbosfxidqxv', host:'aws-1-ap-northeast-2.pooler.supabase.com', port:'5432',
  project:'6fe72710-1fc8-445a-a77f-da2da8fee200', service:'b0835b08-7799-4c1c-8bcd-90746b9d4248', environment:'01ab3d5a-1036-45b0-aa9c-47179339c9be' });
const allowedScripts = new Set(['scripts/unified-stage11-role-check.ts', 'scripts/unified-stage11-reconcile.ts',
  'scripts/unified-aggregation-worker.ts', 'scripts/unified-stage11-operator.ts']);
const reject = () => { throw Error('STAGE11_RUNTIME_REJECTED'); };

/** Pure validation; callers must never serialize the returned credential-bearing URLs. */
export function validateStage11Runtime(env) {
  const secrets = JSON.parse(env.UNIFIED_STAGE11_SECRETS_JSON ?? '{}');
  if (secrets.projectRef !== target.projectRef || secrets.reportRole !== 'meta_ads_unified_report' ||
      secrets.workerRole !== 'meta_ads_unified_worker' || !/^[a-f0-9]{64}$/i.test(secrets.reportPassword ?? '') ||
      !/^[a-f0-9]{64}$/i.test(secrets.workerPassword ?? '') || secrets.reportPassword === secrets.workerPassword ||
      env.SUPABASE_DATABASE_PROJECT_REF !== target.projectRef) reject();
  const legacy = new URL(env.DATABASE_URL ?? 'invalid:');
  const overrides = ['host','port','user','password','database','dbname','search_path','options'];
  if (!['postgres:','postgresql:'].includes(legacy.protocol) || legacy.hostname !== target.host || legacy.port !== target.port ||
      decodeURIComponent(legacy.username) !== `meta_ads_prod_runtime.${target.projectRef}` || legacy.pathname !== '/postgres' ||
      legacy.searchParams.getAll('schema').length !== 1 || legacy.searchParams.get('schema') !== 'meta_ads' || legacy.hash ||
      legacy.searchParams.get('sslmode') !== 'verify-full' || legacy.searchParams.has('sslaccept') ||
      overrides.some(key => legacy.searchParams.has(key))) reject();
  const roleUrl = (role, password) => { const url = new URL(legacy); url.username = `${role}.${target.projectRef}`; url.password = password; return url; };
  return { secrets, legacy, report:roleUrl(secrets.reportRole,secrets.reportPassword), worker:roleUrl(secrets.workerRole,secrets.workerPassword) };
}

export function allowedStage11Script(value) {
  if (!allowedScripts.has(value)) reject();
  const path = resolve(value);
  if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) reject();
  return path;
}

function railwayBinary() {
  // npx's PATH contains its exact installed package; execute the native binary without a shell.
  for (const entry of (process.env.PATH ?? '').split(delimiter)) {
    if (!entry) continue;
    const root = resolve(entry, '../@railway/cli'), manifest = join(root,'package.json');
    const binary = join(root,'bin',process.platform === 'win32' ? 'railway.exe' : 'railway');
    if (!existsSync(manifest) || !existsSync(binary)) continue;
    const metadata = JSON.parse(readFileSync(manifest,'utf8'));
    if (metadata.name === '@railway/cli' && metadata.version === '5.71.0' && lstatSync(binary).isFile()) return binary;
  }
  reject();
}

function cliEnvironment() {
  // The setter needs OS login/keychain context, not legacy/provider/worker credentials.
  const names = ['PATH','PATHEXT','SYSTEMROOT','WINDIR','COMSPEC','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA',
    'HOME','HOMEDRIVE','HOMEPATH','RAILWAY_TOKEN','RAILWAY_API_TOKEN','RAILWAY_HOME','HTTP_PROXY','HTTPS_PROXY','NO_PROXY',
    'SSL_CERT_FILE','NODE_EXTRA_CA_CERTS'];
  return Object.fromEntries(names.filter(name => process.env[name] !== undefined).map(name=>[name,process.env[name]]));
}

function setRailwayRuntime(report) {
  const result = spawnSync(railwayBinary(), ['variable','set','UNIFIED_RUNTIME_DATABASE_URL','--stdin','--skip-deploys',
    '--project',target.project,'--service',target.service,'--environment',target.environment],
    {env:cliEnvironment(),input:report.toString(),encoding:'utf8',windowsHide:true,
      stdio:['pipe','pipe','pipe'],maxBuffer:1048576,timeout:120000});
  // CLI variable output can contain the value even with --json; discard both streams entirely.
  if (result.status !== 0 || result.error) throw Error('STAGE11_RUNTIME_VARIABLE_SET_FAILED');
  const receipt = {stage:11,operation:'RESTRICTED_REPORT_RUNTIME_VARIABLE_SET',status:'PASS',observedAt:new Date().toISOString(),
    projectId:target.project,serviceId:target.service,environmentId:target.environment,key:'UNIFIED_RUNTIME_DATABASE_URL',
    secretTransport:'stdin only; stdout/stderr discarded',skipDeploys:true,featureActivation:false};
  writeFileSync('docs/product-performance/research/11-app-runtime-variable-result.json',JSON.stringify(receipt,null,2)+'\n');
  process.stdout.write(JSON.stringify({stage:11,operation:receipt.operation,status:'PASS',skipDeploys:true})+'\n');
}

function main() {
  let context, caPath, caDirectory, childEnv;
  try {
    // Parsing is inside the safe catch: malformed JSON/URL errors may echo their input.
    context = validateStage11Runtime(process.env);
    delete process.env.UNIFIED_STAGE11_SECRETS_JSON;
    if (process.argv[2] === '--set-railway-runtime') {
      if (process.argv.length !== 3) reject();
      // Keep the original Linux TLS policy; never deploy a Windows temporary certificate path.
      setRailwayRuntime(context.report); return;
    }
    const script = allowedStage11Script(process.argv[2]);
    const ca = readFileSync('deploy/cloud/certs/supabase-prod-ca-2021.crt','utf8').replaceAll('\r\n','\n');
    if (createHash('sha256').update(ca).digest('hex') !== '700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7') reject();
    caDirectory = mkdtempSync(join(tmpdir(),'unified-stage11-ca-'));
    caPath = join(caDirectory,'public-ca.pem'); writeFileSync(caPath,ca,{flag:'wx',mode:0o600});
    for (const url of [context.legacy,context.report,context.worker]) {
      url.searchParams.delete('sslrootcert'); url.searchParams.set('sslcert',caPath);
      url.searchParams.set('sslmode','require'); url.searchParams.set('sslaccept','strict');
    }
    childEnv = {...process.env,DATABASE_URL:context.legacy.toString(),UNIFIED_RUNTIME_DATABASE_URL:context.report.toString(),
      UNIFIED_AGGREGATION_DATABASE_URL:context.worker.toString(),UNIFIED_STAGE11_RECONCILE_DATABASE_URL:context.worker.toString(),
      // Enable only the reviewed local maintenance child while the deployed HTTP feature remains OFF.
      UNIFIED_PERFORMANCE_ENABLED:'true',PRISMA_CONNECTION_LIMIT:'1',TSX_TSCONFIG_PATH:'apps/api/tsconfig.json'};
    const result = spawnSync(process.execPath,['--import','tsx',script,...process.argv.slice(3)],
      {env:childEnv,windowsHide:true,stdio:['ignore','pipe','pipe'],encoding:'utf8',timeout:600000,maxBuffer:2097152});
    if (result.error || result.status === null) throw Error('STAGE11_CHILD_EXECUTION_FAILED');
    // Reviewed children persist their own evidence. Never forward raw stdout or stderr.
    process.stdout.write(JSON.stringify({stage:11,script:basename(script),exitCode:result.status,
      status:result.status === 0 ? 'PASS' : result.status === 2 ? 'REVIEW_REQUIRED' : 'FAILED'})+'\n');
    process.exitCode = result.status;
  } catch {
    process.stderr.write('STAGE11_RESTRICTED_RUNTIME_FAILED\n'); process.exitCode = 1;
  } finally {
    delete process.env.UNIFIED_STAGE11_SECRETS_JSON;
    if (childEnv) for (const name of ['DATABASE_URL','UNIFIED_RUNTIME_DATABASE_URL','UNIFIED_AGGREGATION_DATABASE_URL','UNIFIED_STAGE11_RECONCILE_DATABASE_URL']) delete childEnv[name];
    if (context) { context.secrets.reportPassword=null; context.secrets.workerPassword=null;
      context.legacy.password='';context.report.password='';context.worker.password=''; }
    // Exact mkdtemp/created file paths only; no recursive removal or external target.
    try { if (caPath) unlinkSync(caPath); if (caDirectory) rmdirSync(caDirectory); }
    catch { process.stderr.write('STAGE11_PUBLIC_CA_CLEANUP_FAILED\n'); process.exitCode=1; }
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main();
