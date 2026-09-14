export const SESSION_IDLE_MS = 2 * 60 * 60 * 1000;
let current: { key: string; at: number } | null = null;

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
  save();
}
export function userActivityAge(): number | undefined {
  if (!current) return undefined;
  const age = Math.max(0, Date.now() - latest());
  return age <= 60_000 ? age : undefined;
}

export function watchUserActivity(userId: string, onIdle: () => void, onActivity: () => void) {
  const key = "meta-ads.activity." + userId;
  current = { key, at: Math.max(current?.key === key ? current.at : 0, read(key)) || Date.now() };
  save();
  let ended = false;
  let sentAt = 0;
  let savedAt = 0;
  const check = () => {
    if (ended) return true;
    if (Date.now() - latest() < SESSION_IDLE_MS) return false;
    ended = true;
    onIdle();
    return true;
  };
  const input = () => {
    // An event after sleep must not revive a session whose deadline passed.
    if (check() || !current) return;
    current.at = Date.now();
    if (Date.now() - savedAt >= 1_000) { save(); savedAt = Date.now(); }
    if (Date.now() - sentAt >= 30_000) {
      sentAt = Date.now();
      onActivity();
    }
  };
  const events = ["pointerdown", "pointermove", "keydown", "scroll", "touchstart"] as const;
  for (const event of events) window.addEventListener(event, input, { passive: true });
  window.addEventListener("focus", check);
  window.addEventListener("pageshow", check);
  const timer = window.setInterval(check, 1_000);
  check();
  return () => {
    window.clearInterval(timer);
    for (const event of events) window.removeEventListener(event, input);
    window.removeEventListener("focus", check);
    window.removeEventListener("pageshow", check);
    current = null;
  };
}
