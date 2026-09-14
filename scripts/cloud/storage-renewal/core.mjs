// Shared by the Supabase Edge entry point and local tests. Never logs secrets.
export const TARGET = Object.freeze({
  projectId: '6fe72710-1fc8-445a-a77f-da2da8fee200',
  environmentId: '01ab3d5a-1036-45b0-aa9c-47179339c9be',
  serviceId: 'b0835b08-7799-4c1c-8bcd-90746b9d4248',
  origin: 'https://iygjmosbelbosfxidqxv.supabase.co',
  bucket: 'meta-ads-production',
  kid: '1a2b32ee-ad73-4a9c-ae59-3046f021eda9'
});
export async function renewStorage({ api, verify, issue, probe, readiness, checkOnly = false, force = false, now = Math.floor(Date.now()/1000) }) {
  const variables = await api('read');
  if (variables.SUPABASE_URL !== TARGET.origin || variables.SUPABASE_STORAGE_BUCKET !== TARGET.bucket ||
      variables.SUPABASE_DATABASE_RUNTIME_USER !== 'meta_ads_prod_runtime') throw Error('TARGET_MISMATCH');
  const token = variables.SUPABASE_STORAGE_ACCESS_TOKEN;
  const current = await verify(token, variables.SUPABASE_STORAGE_TOKEN_SUBJECT, true);
  if(current.role !== 'storage_app' || current.iss !== TARGET.origin+'/auth/v1' || current.sub !== variables.SUPABASE_STORAGE_TOKEN_SUBJECT ||
     current.aud !== 'authenticated' || !Number.isSafeInteger(current.exp) || !Number.isSafeInteger(current.iat) || current.iat>now+30 || current.exp<=current.iat || current.exp-current.iat>7*86400) throw Error('TOKEN_SCOPE_MISMATCH');
  if(checkOnly || (!force && current.exp-now > 3*86400)) {
    if(current.exp<=now) throw Error('CURRENT_TOKEN_EXPIRED');
    await probe(token, variables.SUPABASE_PUBLISHABLE_KEY);
    await readiness(variables, current.iat);
    return {state:'HEALTHY',expiresAt:current.exp,readinessVerified:true};
  }
  const next = await issue(current.sub, now, now+6*86400);
  const checked = await verify(next, current.sub);
  if(checked.sub!==current.sub || checked.role!=='storage_app' || checked.iss!==current.iss || checked.aud!==current.aud || checked.exp!==now+6*86400 || checked.iat!==now) throw Error('ISSUED_TOKEN_MISMATCH');
  await probe(next, variables.SUPABASE_PUBLISHABLE_KEY);
  // Re-read before the only mutation. Never overwrite an independently rotated token.
  const latest = await api('read');
  if(Object.keys(variables).some(key=>latest[key]!==variables[key]) || Object.keys(latest).length!==Object.keys(variables).length) return {state:'CONCURRENT_ROTATION_PRESERVED'};
  const acknowledged = await api('replace-token-and-deploy', next);
  if(acknowledged!==true) throw Error('UPDATE_OUTCOME_UNKNOWN_INSPECT_NO_RETRY');
  return {state:'DEPLOYMENT_REQUESTED',expiresAt:checked.exp,readinessVerified:false};
}
