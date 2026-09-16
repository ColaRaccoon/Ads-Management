export const SESSION_IDLE_MS = 2 * 60 * 60 * 1000;
export const POLLING_IDLE_MS = 5 * 60 * 1000;
let current: { key: string; at: number } | null = null;
let needsValidation = false;
let revalidate: (() => Promise<void>) | null = null;
let validation: Promise<void> | null = null;

export function setActivityRevalidator(callback: () => Promise<void>) {
  revalidate = callback;
  return () => { if (revalidate === callback) revalidate = null; };
}

// This barrier runs before sending a new request, never by replaying a mutation.
export async function ensureActivityAuthorization() {
  const age = current ? Date.now() - latest() : 0;
  if (age >= SESSION_IDLE_MS) throw new Error("장시간 활동이 없어 로그인이 만료되었습니다.");
  if (age >= POLLING_IDLE_MS) needsValidation = true;
  if (!needsValidation) return;
  if (!revalidate) throw new Error("인증 상태를 다시 확인한 후 시도해 주세요.");
  if (!validation) {
    const activitySession = current;
    validation = revalidate().then(() => {
      if (current === activitySession) needsValidation = false;
    }).finally(() => {
      validation = null;
    });
  }
  await validation;
}

function read(key: string): number {
  try {
    const value = Number(window.localStorage.getItem(key));
    return Number.isFinite(value) && value > 0 && value <= Date.now() ? value : 0;
  } catch { return 0; }
}
function save() {
  if (!current) return;
  try { window.localStorage.setItem(current.key, String(current.at)); } catch { /* Memory fallback. */ }
}
function latest() {
  if (!current) return 0;
  current.at = Math.max(current.at, read(current.key));
  return current.at;
}
export function resetUserActivity(userId: string) {
  current = { key: "meta-ads.activity." + userId, at: Date.now() };
  needsValidation = false;
  save();
}
export function userActivityAge(): number | undefined {
  if (!current) return undefined;
  const age = Math.max(0, Date.now() - latest());
  return age <= 60_000 ? age : undefined;
}

export function watchUserActivity(
  userId: string,
  onIdle: () => void,
  onActivity: () => void,
  onPollingChange: (active: boolean) => void = () => undefined
) {
  const key = "meta-ads.activity." + userId;
  current = { key, at: Math.max(current?.key === key ? current.at : 0, read(key)) || Date.now() };
  save();
  let ended = false;
  let sentAt = 0;
  let savedAt = 0;
  let pollingActive = true;
  const check = () => {
    if (ended) return true;
    const age = Date.now() - latest();
    const active = age < POLLING_IDLE_MS;
    if (!active) needsValidation = true;
    if (active !== pollingActive) {
      pollingActive = active;
      onPollingChange(active);
      // Activity from another tab also requires this tab to refresh its grants.
      if (active) onActivity();
    }
    if (age < SESSION_IDLE_MS) return false;
    ended = true;
    onIdle();
    return true;
  };
  const input = () => {
    // An event after sleep must not revive a session whose deadline passed.
    if (check() || !current) return;
    current.at = Date.now();
    if (Date.now() - savedAt >= 1_000) { save(); savedAt = Date.now(); }
    if (!pollingActive) {
      pollingActive = true;
      onPollingChange(true);
      sentAt = Date.now();
      onActivity();
      return;
    }
    if (Date.now() - sentAt >= 30_000) {
      sentAt = Date.now();
      onActivity();
    }
  };
  const events = ["pointerdown", "pointermove", "keydown", "scroll", "touchstart"] as const;
  const focus = () => { if (!check() && !pollingActive) onActivity(); };
  for (const event of events) window.addEventListener(event, input, { passive: true, capture: true });
  window.addEventListener("focus", focus);
  window.addEventListener("pageshow", check);
  const timer = window.setInterval(check, 1_000);
  check();
  return () => {
    window.clearInterval(timer);
    for (const event of events) window.removeEventListener(event, input, true);
    window.removeEventListener("focus", focus);
    window.removeEventListener("pageshow", check);
    current = null;
    needsValidation = false;
  };
}
