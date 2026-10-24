import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, chmod, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { configuredMetaAuthPolicy, resolveMetaCredential, MetaCredentialRequest } from '../../../apps/api/src/daily-sync/meta-credential-resolver';
import { ProtectedFileMetaCredentialResolver, sealMetaVaultRecord } from '../../../apps/api/src/daily-sync/meta-protected-credential-resolver';
const binding = { credentialRef: 'vault://meta/f20cfd88-51b7-45c0-a23b-32b41c464be8',
  connectionId: '673b3599-a3c1-4f49-8182-a3dcbad3d3d1', accountId: '2138525300002203', transport: 'MCP' as const };
const subject = '123456789';
const userBinding = { ...binding, authClass: 'USER' as const, expectedUserId: subject };
const tokens = { token: 'SYNTHETIC_ONLY_USER_TOKEN_'.repeat(3), inspectorToken: 'SYNTHETIC_ONLY_INSPECTOR_'.repeat(3) };
function userMode() { process.env.DAILY_SYNC_META_AUTH_CLASS = 'USER'; process.env.DAILY_SYNC_META_USER_ID = subject; }

test('USER requires explicit MCP mode and app-scoped person; SYSTEM_USER remains the default', () => {
  assert.deepEqual(configuredMetaAuthPolicy('MCP', {}), { authClass: 'SYSTEM_USER' });
  assert.deepEqual(configuredMetaAuthPolicy('GRAPH', {}), { authClass: 'SYSTEM_USER' });
  assert.deepEqual(configuredMetaAuthPolicy('MCP', { DAILY_SYNC_META_AUTH_CLASS: 'USER', DAILY_SYNC_META_USER_ID: subject }),
    { authClass: 'USER', expectedUserId: subject });
  for (const transport of ['GRAPH', undefined]) assert.throws(() => configuredMetaAuthPolicy(transport as any,
    { DAILY_SYNC_META_AUTH_CLASS: 'USER', DAILY_SYNC_META_USER_ID: subject }));
  for (const id of ['', 'not-a-person', '1'.repeat(31)]) assert.throws(() => configuredMetaAuthPolicy('MCP',
    { DAILY_SYNC_META_AUTH_CLASS: 'USER', DAILY_SYNC_META_USER_ID: id }));
  assert.throws(() => configuredMetaAuthPolicy('MCP', { DAILY_SYNC_META_AUTH_CLASS: 'UNKNOWN' }));
});

async function fixture(run: (f: { resolver: ProtectedFileMetaCredentialResolver; file: string; calls: string[];
  debug: Record<string, any>; me: { id: string }; account: Record<string, string>; key: Buffer }) => Promise<void>,
  sealedBinding: MetaCredentialRequest = userBinding) {
  // Windows TEMP may use an 8.3 alias; the store intentionally accepts canonical paths only.
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'meta-user-synthetic-')));
  await chmod(directory, 0o700);
  const file = join(directory, 'f20cfd88-51b7-45c0-a23b-32b41c464be8.json'), key = randomBytes(32), calls: string[] = [];
  const now = Math.floor(Date.now() / 1000);
  const debug = { app_id: '4474691502806219', type: sealedBinding.authClass ?? 'SYSTEM_USER', is_valid: true,
    scopes: ['ads_read', 'ads_mcp_management'], user_id: subject, expires_at: now + 60 * 86400,
    data_access_expires_at: now + 30 * 86400 };
  const me = { id: subject }, account = { id: 'act_2138525300002203', currency: 'USD', timezone_name: 'Asia/Seoul' };
  await writeFile(file, sealMetaVaultRecord({ ...sealedBinding, ...tokens }, key), { mode: 0o600, flag: 'wx' });
  const request = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)); assert.equal(url.origin, 'https://graph.facebook.com'); assert.equal(init?.redirect, 'error');
    const route = url.pathname.replace('/v26.0/', ''); calls.push(route);
    if (route === 'debug_token') return Response.json({ data: debug });
    if (route === 'me') return Response.json(me);
    if (route === 'act_2138525300002203') return Response.json(account);
    throw Error('Unexpected synthetic route');
  };
  try { await run({ resolver: new ProtectedFileMetaCredentialResolver(directory, key.toString('base64'), request as any),
    file, calls, debug, me, account, key }); }
  finally { key.fill(0); await unlink(file); await rmdir(directory); }
}

test('genuine USER GCM v2 resolves only the exact person/app/account and the earlier expiry', async () => {
  const before = { ...process.env }; userMode();
  try { await fixture(async f => {
    const result = await resolveMetaCredential(f.resolver, binding);
    assert.equal(result.authClass, 'USER'); assert.equal(result.subjectId, subject);
    assert.equal(result.expiresAt.getTime(), f.debug.data_access_expires_at * 1000);
    assert.deepEqual(f.calls, ['debug_token', 'me', 'act_2138525300002203']);
  }); } finally { process.env = before; }
});

test('v2 authenticates person and auth class before provider I/O; v1 SYSTEM_USER stays compatible', async () => {
  await fixture(async f => {
    for (const patch of [{ expectedUserId: '999' }, { authClass: 'SYSTEM_USER', expectedUserId: undefined },
      { accountId: '1' }, { connectionId: 'c267e46f-6295-49e0-bd28-873ca20c00b8' }, { transport: 'GRAPH' }])
      await assert.rejects(f.resolver.resolve({ ...userBinding, ...patch } as any, new AbortController().signal));
    assert.equal(f.calls.length, 0);
    const v1 = sealMetaVaultRecord({ ...binding, ...tokens }, f.key);
    await writeFile(f.file, v1);
    await assert.rejects(f.resolver.resolve(userBinding, new AbortController().signal));
    assert.equal(f.calls.length, 0);
    f.debug.type = 'SYSTEM_USER';
    assert.equal((await f.resolver.resolve(binding, new AbortController().signal)).authClass, 'SYSTEM_USER');
    assert.equal(JSON.parse(v1).version, 1);
  });
});

test('wrong app, person, write scope, revocation and short TTL stop before identity/account reads', async () => {
  const now = Math.floor(Date.now() / 1000);
  for (const patch of [{ app_id: '1' }, { user_id: '999' }, { type: 'SYSTEM_USER' }, { is_valid: false },
    { scopes: ['ads_read'] }, { scopes: ['ads_read', 'ads_mcp_management', 'ads_management'] },
    { expires_at: now + 7 * 86400 }, { data_access_expires_at: now + 7 * 86400 }]) {
    await fixture(async f => {
      Object.assign(f.debug, patch);
      await assert.rejects(f.resolver.resolve(userBinding, new AbortController().signal));
      assert.deepEqual(f.calls, ['debug_token']);
    });
  }
});

test('me/account mismatch and outer subject attestation fail closed', async () => {
  const before = { ...process.env }; userMode();
  try {
    for (const mode of ['me', 'account', 'currency', 'timezone']) await fixture(async f => {
      if (mode === 'me') f.me.id = '999';
      if (mode === 'account') f.account.id = '1';
      if (mode === 'currency') f.account.currency = 'KRW';
      if (mode === 'timezone') f.account.timezone_name = 'UTC';
      await assert.rejects(resolveMetaCredential(f.resolver, binding));
    });
    await fixture(async f => {
      const good = await f.resolver.resolve(userBinding, new AbortController().signal);
      for (const patch of [{ subjectId: '999' }, { subjectId: undefined }, { authClass: 'SYSTEM_USER' }])
        await assert.rejects(resolveMetaCredential({ resolve: async () => ({ ...good, ...patch } as any) }, binding));
      await assert.rejects(resolveMetaCredential({ resolve: async () => {
        process.env.DAILY_SYNC_META_USER_ID = '999'; return good;
      } }, binding));
    });
  } finally { process.env = before; }
});
