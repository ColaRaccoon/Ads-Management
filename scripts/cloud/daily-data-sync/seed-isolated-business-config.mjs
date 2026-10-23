// Root-only bridge: existing internal configuration, never orders or new CSV.
import { PrismaClient } from '@prisma/client';
import {createHash} from 'node:crypto';
import {readFileSync,lstatSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import { prepareConfiguration, seedConfiguration } from '../../../apps/api/src/daily-sync/cafe24-live-configuration.ts';
import { databaseUrlWithConnectionLimit } from '../../../apps/api/src/common/prisma.service.ts';
let failureStage = 'INPUT';
const stages = new Set(['INPUT','TARGET','CONFIGURATION','RUNTIME_IDENTITY','FRESH_COUNTS','SEED','READBACK']);
const safeCodes = new Set(['TARGET','TARGET_CERTIFICATE_REJECTED','IDENTITY','INPUT_BOUND','FRESH_CONFIGURATION_REQUIRED','READBACK',
  'CONFIGURATION_REQUIRED','CONFIGURATION_INVALID','CONFIGURATION_INVENTORY_MISMATCH',
  'CONFIGURATION_FINGERPRINT_MISMATCH','CONFIGURATION_ALREADY_SEEDED_REVIEW_REQUIRED',
  'CONFIGURATION_SEED_STATE_MISMATCH']);
const errorTypes = new Set(['Error','TypeError','SyntaxError','PrismaClientInitializationError','PrismaClientKnownRequestError',
  'PrismaClientValidationError','PrismaClientUnknownRequestError','PrismaClientRustPanicError']);
export const businessCertificatePath=fileURLToPath(new URL('../../../deploy/cloud/certs/supabase-prod-ca-2021.crt',import.meta.url));
export function validateBusinessCertificate(path=businessCertificatePath, io={readFileSync,lstatSync}) {
  try {
    if(resolve(path)!==resolve(businessCertificatePath)) throw new Error();
    const info=io.lstatSync(path);
    if(!info.isFile() || info.isSymbolicLink() || info.size<1 || info.size>16384) throw new Error();
    const pem=io.readFileSync(path,'utf8').replace(/\r\n/g,'\n');
    if(createHash('sha256').update(pem).digest('hex')!=='700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7') throw new Error();
    return path;
  } catch {throw new Error('TARGET_CERTIFICATE_REJECTED');}
}
export function businessFailureDiagnostic(error, stage = failureStage) {
  const prismaCode = [error?.code,error?.errorCode].find(value => typeof value === 'string' && /^P\d{4}$/.test(value));
  const code = prismaCode ??
    (typeof error?.message === 'string' && safeCodes.has(error.message) ? error.message : 'UNCLASSIFIED');
  return {state:'PHASE08_BUSINESS_CONFIGURATION_FAILED', stage:stages.has(stage) ? stage : 'INPUT',
    code, errorType:typeof error?.name === 'string' && errorTypes.has(error.name) ? error.name : 'UNCLASSIFIED',
    inspectBeforeRetry:true, rawErrorSuppressed:true};
}

export function assertBusinessDatabaseTarget(input) {
  if (input?.projectRef !== 'ehnfrrmbkvlsbpvqcvkr' || input?.freshVerified !== true) throw new Error('TARGET');
  const url = new URL(input.databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
      url.hostname !== 'aws-0-ap-northeast-2.pooler.supabase.com' || url.port !== '5432' ||
      url.pathname !== '/postgres' || url.hash ||
      decodeURIComponent(url.username) !== 'phase08_runtime.ehnfrrmbkvlsbpvqcvkr' ||
      url.searchParams.get('schema') !== 'phase08_meta_ads' ||
      url.searchParams.get('sslmode') !== 'verify-full' || !url.password) throw new Error('TARGET');
  const permitted = new Set(['schema', 'sslmode', 'connection_limit', 'pool_timeout', 'connect_timeout']);
  const seen = new Set();
  for (const [key] of url.searchParams) {
    if (!permitted.has(key) || seen.has(key)) throw new Error('TARGET');
    seen.add(key);
  }
  // Only the reviewed local Windows bridge needs an explicit CA file. The
  // original caller URI still cannot supply any certificate path or TLS bypass.
  if(process.platform==='win32') url.searchParams.set('sslrootcert',validateBusinessCertificate());
  return databaseUrlWithConnectionLimit(url.toString(), '1');
}
export function assertBusinessTarget(input) {
  const url = assertBusinessDatabaseTarget(input);
  failureStage = 'CONFIGURATION';
  prepareConfiguration(input.configuration);
  return url;
}
export async function diagnoseBusinessTarget(input, factory = (datasourceUrl) => new PrismaClient({datasourceUrl})) {
  failureStage = 'TARGET';
  const url = assertBusinessDatabaseTarget(input);
  failureStage = 'RUNTIME_IDENTITY';
  const db = factory(url);
  try {
    await db.$transaction(async tx => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      const rows = await tx.$queryRawUnsafe("SELECT current_database() AS database, current_user AS role, current_setting('transaction_read_only') AS readonly");
      if(rows.length !== 1 || rows[0].database !== 'postgres' || rows[0].role !== 'phase08_runtime' || rows[0].readonly !== 'on') throw new Error('IDENTITY');
    },{timeout:20000,maxWait:2000});
    return {state:'PHASE08_BUSINESS_TARGET_READONLY_VERIFIED',operatingReads:0,operatingWrites:0,targetWrites:0,providerRequests:0,csvUploads:0};
  } finally { await db.$disconnect(); }
}

export async function seedBusinessConfiguration(input, factory = (datasourceUrl) => new PrismaClient({datasourceUrl})) {
  failureStage = 'TARGET';
  const datasourceUrl = assertBusinessTarget(input);
  failureStage = 'RUNTIME_IDENTITY';
  const db = factory(datasourceUrl);
  try {
    const identity = await db.$queryRawUnsafe('SELECT current_database() AS database, current_user AS role');
    if (identity.length !== 1 || identity[0].database !== 'postgres' || identity[0].role !== 'phase08_runtime') throw new Error('IDENTITY');
    failureStage = 'FRESH_COUNTS';
    const counts = await Promise.all([db.product.count(), db.productCostRule.count(), db.cafe24ProductRule.count(), db.cafe24CouponRule.count()]);
    if (counts.some(count => count !== 0)) throw new Error('FRESH_CONFIGURATION_REQUIRED');
    failureStage = 'SEED';
    const result = await seedConfiguration(db, input.configuration);
    // The existing nonempty path compares every stored field without writing.
    failureStage = 'READBACK';
    const checked = await seedConfiguration(db, input.configuration);
    if (checked.configurationFingerprint !== result.configurationFingerprint) throw new Error('READBACK');
    return {state:'PHASE08_BUSINESS_CONFIGURATION_SEEDED', ...checked,
      source:'CURRENT_INTERNAL_CONFIGURATION', operatingWrites:0, providerRequests:0, csvUploads:0};
  } finally { await db.$disconnect(); }
}

if (process.argv[1]?.endsWith('seed-isolated-business-config.mjs')) {
  let raw = '';
  try {
    for await (const bytes of process.stdin) {
      raw += bytes;
      if (Buffer.byteLength(raw) > 1_048_576) throw new Error('INPUT_BOUND');
    }
    const input = JSON.parse(raw); raw = '';
    process.stdout.write(JSON.stringify(await (process.argv.includes('--diagnose-target') ? diagnoseBusinessTarget(input) : seedBusinessConfiguration(input))));
  } catch (error) {
    process.stdout.write(JSON.stringify(businessFailureDiagnostic(error)));
    process.exitCode = 1;
  } finally { raw = ''; }
}
