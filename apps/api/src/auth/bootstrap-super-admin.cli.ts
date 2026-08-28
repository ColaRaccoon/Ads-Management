export function assertLegacySupabaseBootstrapDisabled(): never {
  throw new Error("LEGACY_SUPABASE_AUTH_BOOTSTRAP_DISABLED");
}

if (require.main === module) {
  try { assertLegacySupabaseBootstrapDisabled(); }
  catch { process.stderr.write("LEGACY_SUPABASE_AUTH_BOOTSTRAP_DISABLED\n"); process.exitCode = 1; }
}
