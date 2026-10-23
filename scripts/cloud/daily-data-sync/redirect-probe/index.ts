// Temporary, secret-free actual-extension diagnostic. Never reads env or calls the app.
// Delete the exact new-project function before installing any relay project secrets.
const canonical = 'https://ehnfrrmbkvlsbpvqcvkr.supabase.co/functions/v1/daily-data-sync-08-redirect-probe';
const alternate = 'https://ehnfrrmbkvlsbpvqcvkr.functions.supabase.co/daily-data-sync-08-redirect-probe';
const expected = 'Basic ' + btoa('phase08:PHASE08_SYNTHETIC_REDIRECT_ONLY');
const headers = {'content-type': 'application/json', 'cache-control': 'no-store'};
Deno.serve((request: Request) => {
  if (Date.now() >= Date.parse('2026-10-15T00:25:00.000Z')) return new Response('{"code":"EXPIRED"}', {status: 410, headers});
  const url = new URL(request.url);
  const mode = url.searchParams.get('mode');
  if (url.searchParams.size !== 1 || !['same', 'cross', 'received'].includes(mode ?? '') || !['GET', 'POST'].includes(request.method)) {
    return new Response('{"code":"REJECTED"}', {status: 400, headers});
  }
  const auth = request.headers.get('authorization');
  if (auth !== null && auth !== expected) return new Response('{"code":"REJECTED"}', {status: 403, headers});
  if (mode === 'same' || mode === 'cross') {
    return new Response(null, {status: 307, headers: {...headers, location: (mode === 'same' ? canonical : alternate) + '?mode=received'}});
  }
  return new Response(JSON.stringify({classification: 'SYNTHETIC_AUTH_ONLY', method: request.method,
    authorizationPresent: auth !== null, syntheticAuthorizationMatched: auth === expected,
    machineHeaderPresent: request.headers.has('x-daily-sync-token')}), {status: 200, headers});
});
