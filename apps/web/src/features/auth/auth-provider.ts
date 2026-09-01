export const WEB_AUTH_PROVIDERS = ["supabase", "local"] as const;

export type WebAuthProvider = (typeof WEB_AUTH_PROVIDERS)[number];

export function parseWebAuthProvider(value: string | undefined): WebAuthProvider {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return "local";
  if (normalized === "supabase" || normalized === "local") return normalized;
  throw new Error("NEXT_PUBLIC_AUTH_PROVIDER must be either supabase or local.");
}

export const WEB_AUTH_PROVIDER = parseWebAuthProvider(process.env.NEXT_PUBLIC_AUTH_PROVIDER);

export function authLoginPayload(
  identifier: string,
  password: string,
  provider: WebAuthProvider = WEB_AUTH_PROVIDER
) {
  return provider === "supabase"
    ? { email: identifier, password }
    : { username: identifier, password };
}
