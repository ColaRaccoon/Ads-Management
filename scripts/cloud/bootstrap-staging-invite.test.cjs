const { test } = require('node:test');
const assert = require('node:assert/strict');
const { bootstrap } = require('./bootstrap-staging-invite.cjs');
function fixture() {
  let row = null, sends = 0;
  const input = { mode: 'execute', email: 'owner@example.test', env: { DATABASE_URL: 'postgresql://meta_ads_stg_runtime.ehnfrrmbkvlsbpvqcvkr:fixture@aws-0-ap-northeast-2.pooler.supabase.com:5432/meta_ads_staging?sslmode=verify-full', SUPABASE_URL: 'https://ehnfrrmbkvlsbpvqcvkr.supabase.co', AUTH_PROVIDER: 'supabase', AUTH_INVITE_REDIRECT_ORIGIN: 'https://grand-fascination-staging.up.railway.app' } };
  const db = { $queryRawUnsafe: async () => [{ db: 'meta_ads_staging', oid: 25404, role: 'meta_ads_stg_runtime' }], $executeRawUnsafe: async () => {}, securityAuditEvent: { create: async () => {} }, appUser: { count: async () => row ? 1 : 0, create: async ({data}) => row = { id: 'fixture', ...data }, findUnique: async () => row, update: async ({data}) => row = { ...row, ...data } } };
  db.$transaction = async fn => fn(db);
  const provider = { recipientExists: async () => false, invite: async (email, redirect, requestId) => { sends++; return { id: 'c00fabc0-1111-4444-8888-111122223333', email, user_metadata: { invitation_request_id: requestId } }; } };
  return { input, db, provider, mark: async () => {}, sends: () => sends, row: () => row };
}
test('dry run performs no mutation or email', async () => { const f = fixture(); f.input.mode='dry-run'; await bootstrap(f.input,f.db,f.provider, f.mark); assert.equal(f.sends(),0); assert.equal(f.row(),null); });
test('only one invitation, normal email/password onboarding remains required', async () => { const f=fixture(); const r=await bootstrap(f.input,f.db,f.provider,f.mark); assert.equal(r.result,'INVITED'); assert.equal(f.row().inviteStatus,'INVITED'); assert.equal(f.sends(),1); await assert.rejects(bootstrap(f.input,f.db,f.provider,f.mark),/ALREADY_EXISTS/); assert.equal(f.sends(),1); });
test('rejects wrong target before provider contact',async()=>{const f=fixture();f.input.env.SUPABASE_URL='https://wrong.supabase.co';await assert.rejects(bootstrap(f.input,f.db,f.provider,f.mark),/TARGET_MISMATCH/);assert.equal(f.sends(),0);});
test('rejects wrong database OID before writes',async()=>{const f=fixture();f.db.$queryRawUnsafe=async()=>[{db:'meta_ads_staging',oid:5,role:'meta_ads_stg_runtime'}];await assert.rejects(bootstrap(f.input,f.db,f.provider,f.mark),/DATABASE_MISMATCH/);assert.equal(f.row(),null);});
test('provider failure leaves pending state and never retries',async()=>{const f=fixture();let attempts=0;f.provider.invite=async()=>{attempts++;throw new Error('timeout');};await assert.rejects(bootstrap(f.input,f.db,f.provider,f.mark));await assert.rejects(bootstrap(f.input,f.db,f.provider,f.mark),/ALREADY_EXISTS/);assert.equal(attempts,1);assert.equal(f.row().inviteStatus,'PENDING_PROVIDER');});
test('provider identity mismatch never activates account',async()=>{const f=fixture();f.provider.invite=async()=>({id:'c00fabc0-1111-4444-8888-111122223333',email:'wrong@example.test'});await assert.rejects(bootstrap(f.input,f.db,f.provider,f.mark),/IDENTITY_MISMATCH/);assert.equal(f.row().inviteStatus,'PENDING_PROVIDER');});
test('durable attempt marker failure prevents writes',async()=>{const f=fixture();await assert.rejects(bootstrap(f.input,f.db,f.provider,async()=>{throw new Error('exists');}));assert.equal(f.row(),null);assert.equal(f.sends(),0);});

test('existing recipient blocks sending without changing any account',async()=>{const f=fixture();f.provider.recipientExists=async()=>true;await assert.rejects(bootstrap(f.input,f.db,f.provider,f.mark),/AUTH_RECIPIENT_EXISTS/);assert.equal(f.row(),null);assert.equal(f.sends(),0);});
test('concurrent first-account creation is rejected inside the transaction',async()=>{const f=fixture();let reads=0;f.db.appUser.count=async()=>++reads===1?0:1;await assert.rejects(bootstrap(f.input,f.db,f.provider,f.mark),/ALREADY_EXISTS/);assert.equal(f.row(),null);assert.equal(f.sends(),0);});
