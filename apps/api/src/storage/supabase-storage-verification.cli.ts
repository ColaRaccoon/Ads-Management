/**
 * Historical step-8 entry point retained only to fail closed for old runbooks.
 * The local-native deployment uses the existing Supabase PostgreSQL database
 * only; object payloads belong to the configured local filesystem.
 */
process.stderr.write(`${JSON.stringify({
  result: "RETIRED",
  code: "SUPABASE_STORAGE_OUT_OF_SCOPE",
  databaseProvider: "supabase_postgres",
  storageProvider: "local"
})}\n`);
process.exitCode = 1;
