-- REVIEW TEMPLATE ONLY. Do not execute this file directly.
-- The deterministic executable SQL is rendered by ../policy.ts only after strict
-- project-ref, bucket, readiness-key, and before-inventory binding.
-- Required separately approved prerequisite: a NOLOGIN `storage_app` role granted
-- to `authenticator`, with only provider-required base grants (Supabase documents
-- `anon` -> `storage_app`). This artifact never creates, rotates, or revokes an Auth key.

DO $$
BEGIN
  RAISE EXCEPTION 'UNRENDERED_STORAGE_POLICY_TEMPLATE';
END
$$;

-- Renderer contract:
--   storage.objects SELECT: exact bucket and uploads/, reports/, trash/uploads/,
--     trash/reports/, plus the exact readiness sentinel.
--   storage.objects INSERT: exact bucket and the four mutable prefixes only.
--   storage.objects DELETE: exact bucket and the four mutable prefixes only.
--   roles: storage_app only; no anon/authenticated policy is emitted.
