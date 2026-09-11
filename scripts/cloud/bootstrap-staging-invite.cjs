// Local maintenance only. Never included in the public application image.
const { randomUUID } = require('node:crypto');
const PROJECT = 'ehnfrrmbkvlsbpvqcvkr';
const ORIGIN = 'https://grand-fascination-staging.up.railway.app';
function checkInput(input) {
  const e = input.env;
  const u = new URL(e.DATABASE_URL);
  if (u.hostname !== 'aws-0-ap-northeast-2.pooler.supabase.com' || u.port !== '5432' ||
      u.pathname !== '/meta_ads_staging' || decodeURIComponent(u.username) !== `meta_ads_stg_runtime.${PROJECT}` ||
      u.searchParams.get('sslmode') !== 'verify-full' || e.SUPABASE_URL !== `https://${PROJECT}.supabase.co` ||
      e.AUTH_PROVIDER !== 'supabase' || e.AUTH_INVITE_REDIRECT_ORIGIN !== ORIGIN) throw new Error('TARGET_MISMATCH');
  if (typeof input.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email) || input.email.length > 254) throw new Error('INVALID_EMAIL');
  if (!['dry-run', 'execute'].includes(input.mode)) throw new Error('INVALID_MODE');
}
async function bootstrap(input, db, provider, markAttempt) {
  checkInput(input);
  const email = input.email.trim().toLowerCase();
  const fingerprint = await db.$queryRawUnsafe("SELECT current_database() AS db, (SELECT oid::int FROM pg_database WHERE datname=current_database()) AS oid, current_user AS role");
  if (fingerprint[0]?.db !== 'meta_ads_staging' || fingerprint[0]?.oid !== 25404 || fingerprint[0]?.role !== 'meta_ads_stg_runtime') throw new Error('DATABASE_MISMATCH');
  if (await db.appUser.count() !== 0) throw new Error('FIRST_ACCOUNT_ALREADY_EXISTS_NO_RESEND');
  // Other Auth identities may support storage/tests; never alter or adopt them.
  if (await provider.recipientExists(email)) throw new Error('AUTH_RECIPIENT_EXISTS_INSPECT_BEFORE_BOOTSTRAP');
  if (input.mode === 'dry-run') return { result: 'DRY_RUN_PASS', mailAttempts: 0 };
  const requestId = randomUUID();
  await markAttempt({ requestId, state: 'STARTED', mailAttempts: 0 });
  const pending = await db.$transaction(async tx => {
    await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtextextended('cloud-first-admin-invite', 0))");
    if (await tx.appUser.count() !== 0) throw new Error('FIRST_ACCOUNT_ALREADY_EXISTS_NO_RESEND');
    const user = await tx.appUser.create({ data: { email, normalizedEmail: email, name: 'PatimaGroup Administrator', role: 'SUPER_ADMIN', inviteStatus: 'PENDING_PROVIDER', invitationRequestId: requestId, invitationErrorCode: 'INVITATION_REQUEST_IN_PROGRESS' } });
    await tx.securityAuditEvent.create({ data: { actorType: 'SYSTEM', action: 'CLOUD_FIRST_ADMIN_INVITATION_REQUESTED', targetType: 'APP_USER', targetId: user.id, requestId, result: 'REQUESTED' } });
    return user;
  });
  // Once this boundary is crossed, failures require classification, never a retry.
  await markAttempt({ requestId, state: 'PROVIDER_ATTEMPT_STARTED', mailAttempts: 1 });
  const user = await provider.invite(email, `${ORIGIN}/invite/accept`, requestId);
  if (!user || !/^[0-9a-f-]{36}$/i.test(user.id) || user.email?.toLowerCase() !== email || user.user_metadata?.invitation_request_id !== requestId) throw new Error('PROVIDER_IDENTITY_MISMATCH');
  await db.$transaction(async tx => {
    await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtextextended('cloud-first-admin-invite', 0))");
    const current = await tx.appUser.findUnique({ where: { id: pending.id } });
    if (!current || current.invitationRequestId !== requestId || current.inviteStatus !== 'PENDING_PROVIDER' || current.authUserId) throw new Error('INVITATION_STATE_CHANGED');
    await tx.appUser.update({ where: { id: pending.id }, data: { authUserId: user.id, inviteStatus: 'INVITED', invitedAt: new Date(), invitationErrorCode: null, authzVersion: { increment: 1 } } });
    await tx.securityAuditEvent.create({ data: { actorType: 'SYSTEM', action: 'CLOUD_FIRST_ADMIN_INVITATION_SENT', targetType: 'APP_USER', targetId: pending.id, requestId, result: 'SUCCESS', afterJson: { role: 'SUPER_ADMIN', inviteStatus: 'INVITED' } } });
  });
  const verified = await db.appUser.findUnique({ where: { id: pending.id } });
  if (verified?.authUserId !== user.id || verified?.inviteStatus !== 'INVITED') throw new Error('POST_WRITE_VERIFICATION_FAILED');
  const result = { result: 'INVITED', mailAttempts: 1, requestId, emailVerified: false, passwordSetup: 'USER_ACTION_REQUIRED', operationalReady: false };
  await markAttempt(result);
  return result;
}
module.exports = { bootstrap, checkInput };
if (require.main === module) {
  (async () => {
    const fs = require('node:fs');
    const path = require('node:path');
    let raw = ''; for await (const chunk of process.stdin) raw += chunk;
    const input = JSON.parse(raw); raw = '';
    checkInput(input);
    const { PrismaClient } = require('@prisma/client');
    const db = new PrismaClient({ datasources: { db: { url: input.env.DATABASE_URL } }, log: [] });
    const statePath = path.resolve('.security-dev/railway-tools/first-admin-invitation-state.json');
    let started = false;
    async function markAttempt(value) {
      fs.writeFileSync(statePath, JSON.stringify({ at: new Date().toISOString(), ...value }, null, 2), { flag: started ? 'w' : 'wx' });
      started = true;
    }
    const headers = { apikey: input.env.SUPABASE_SECRET_KEY, Authorization: `Bearer ${input.env.SUPABASE_SECRET_KEY}`, 'Content-Type': 'application/json' };
    const provider = {
      async recipientExists(email) {
        for (let page = 1; page <= 10; page++) {
          const r = await fetch(`${input.env.SUPABASE_URL}/auth/v1/admin/users?page=${page}&per_page=100`, { headers, signal: AbortSignal.timeout(15000) });
          if (!r.ok) throw new Error('PROVIDER_READ_FAILED');
          const data = await r.json();
          if (!Array.isArray(data.users)) throw new Error('PROVIDER_READ_INVALID');
          if (data.users.some(user => user.email?.toLowerCase() === email)) return true;
          if (data.users.length < 100) return false;
        }
        throw new Error('PROVIDER_READ_INVALID');
      },
      async invite(email, redirectTo, requestId) {
        const r = await fetch(`${input.env.SUPABASE_URL}/auth/v1/invite?redirect_to=${encodeURIComponent(redirectTo)}`, { method: 'POST', headers, body: JSON.stringify({ email, data: { invitation_request_id: requestId } }), signal: AbortSignal.timeout(20000) });
        if (!r.ok) throw new Error('PROVIDER_INVITE_FAILED_NO_RETRY');
        return r.json();
      }
    };
    try { console.log(JSON.stringify(await bootstrap(input, db, provider, markAttempt))); }
    finally { await db.$disconnect(); }
  })().catch(error => {
    const known = /^(TARGET_MISMATCH|INVALID_EMAIL|INVALID_MODE|DATABASE_MISMATCH|FIRST_ACCOUNT_ALREADY_EXISTS_NO_RESEND|AUTH_RECIPIENT_EXISTS_INSPECT_BEFORE_BOOTSTRAP|PROVIDER_READ_FAILED|PROVIDER_READ_INVALID|PROVIDER_INVITE_FAILED_NO_RETRY|PROVIDER_IDENTITY_MISMATCH|INVITATION_STATE_CHANGED|POST_WRITE_VERIFICATION_FAILED)$/;
    const code = known.test(error.message) ? error.message : /^P[0-9]{4}$/.test(error.code) ? error.code : error.name === 'PrismaClientInitializationError' ? 'DATABASE_CONNECTION_FAILED' : 'BOOTSTRAP_UNCLASSIFIED_FAILURE';
    console.log(JSON.stringify({ result: 'STOPPED', code })); process.exitCode = 1;
  });
}
