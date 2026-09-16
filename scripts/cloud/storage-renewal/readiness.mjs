// Only this read-only request may retry. Never wrap token rotation in this helper.
export const INVOCATION_BUDGET_MS = 80_000; // Cron's HTTP deadline is 90 seconds.
export const READINESS_BUDGET_MS = 35_000;

export function assertAppliedDeployment(activeDeployments, tokenIssuedAt) {
  // SLEEPING is an applied deployment that the protected GET must wake.
  // Neither a newer failed build nor an older sleeping deployment proves
  // that the current token has reached the running application.
  if (!Number.isSafeInteger(tokenIssuedAt) || !Array.isArray(activeDeployments) ||
      !activeDeployments.some(deployment =>
        ['SUCCESS', 'SLEEPING'].includes(deployment?.status) &&
        Date.parse(deployment?.createdAt) >= tokenIssuedAt * 1000)) {
    throw Error('DEPLOYMENT_NOT_APPLIED');
  }
}

export function requestTimeout(deadlineMs, maximumMs, now = Date.now()) {
  const remaining = Math.min(maximumMs, deadlineMs - now);
  if (remaining <= 0) throw Error('INVOCATION_DEADLINE_EXCEEDED');
  return AbortSignal.timeout(remaining);
}

export async function checkApplicationReadiness({
  token,
  deadlineMs,
  fetchImpl = fetch,
  now = Date.now,
  sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
}) {
  if (!token) throw Error('PROBE_CONFIG_MISSING');
  const deadline = Math.min(deadlineMs, now() + READINESS_BUDGET_MS);
  for (let attempt = 0; attempt < 3; attempt++) {
    const signal = requestTimeout(deadline, 20_000, now());
    let response;
    try {
      response = await fetchImpl('https://patimagroup-work.com/backend-api/health/ready', {
        headers: { 'x-internal-probe-token': token },
        signal,
        // Inspect redirects as terminal failures; never forward the probe secret.
        redirect: 'manual'
      });
    } catch (error) {
      if (!(error instanceof TypeError) && error?.name !== 'TimeoutError') throw error;
    }
    if (response) {
      // Application 503 (DB/provider/expired credential) is terminal. Only
      // unstructured gateway 502/503 can represent the sleeping container.
      const body = await response.text();
      let payload;
      try { payload = JSON.parse(body); } catch { /* Gateway HTML/text is expected. */ }
      if (response.ok) {
        if (payload?.status !== 'ready') throw Error('APPLICATION_READINESS_INVALID');
        return;
      }
      if (![502, 503].includes(response.status) || typeof payload?.code === 'string' || payload?.requestId) {
        throw Error('APPLICATION_NOT_READY');
      }
    }
    if (attempt === 2 || deadline - now() <= 2_000) throw Error('APPLICATION_WAKE_TIMEOUT');
    await sleep(2_000);
  }
}
