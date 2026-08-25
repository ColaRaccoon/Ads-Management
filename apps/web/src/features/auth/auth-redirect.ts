const APP_ORIGIN = "https://meta-ads-performance.invalid";
const NON_BUSINESS_NEXT_PATHS = new Set([
  "/login",
  "/account-setup",
  "/complete-invitation",
  "/invite/accept",
  "/forbidden"
]);

export function safeNextPath(value: string | null | undefined, fallback = "/dashboard") {
  if (
    !value ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return fallback;
  }
  try {
    const parsed = new URL(value, APP_ORIGIN);
    if (parsed.origin !== APP_ORIGIN || parsed.username || parsed.password) return fallback;
    if (NON_BUSINESS_NEXT_PATHS.has(parsed.pathname)) return fallback;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}

export function loginRedirect(pathname: string, search = "") {
  const next = safeNextPath(`${pathname}${search}`, "/dashboard");
  return `/login?next=${encodeURIComponent(next)}`;
}
