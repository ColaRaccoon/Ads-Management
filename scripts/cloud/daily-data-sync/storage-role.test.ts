import assert from "node:assert/strict";
import test from "node:test";
import { expectedStorageTokenRole } from "../../../apps/api/src/common/http-security.config";
const isolated = { SUPABASE_STORAGE_TOKEN_ROLE: "phase08_storage_app", SUPABASE_DATABASE_PROJECT_REF: "ehnfrrmbkvlsbpvqcvkr",
  SUPABASE_DATABASE_SCHEMA: "phase08_meta_ads", SUPABASE_DATABASE_RUNTIME_USER: "phase08_runtime",
  DEPLOYMENT_ENVIRONMENT_ID: "phase08-daily-data-sync-08", SUPABASE_URL: "https://ehnfrrmbkvlsbpvqcvkr.supabase.co" };
test("legacy default storage role stays unchanged", () => {
  assert.equal(expectedStorageTokenRole({}), "storage_app");
  assert.equal(expectedStorageTokenRole({ SUPABASE_STORAGE_TOKEN_ROLE: "storage_app" }), "storage_app");
});
test("phase08 storage role requires every isolated identity field", () => {
  assert.equal(expectedStorageTokenRole(isolated), "phase08_storage_app");
  for (const key of Object.keys(isolated)) assert.throws(() => expectedStorageTokenRole({ ...isolated, [key]: "wrong" }));
  assert.throws(() => expectedStorageTokenRole({ ...isolated, SUPABASE_STORAGE_TOKEN_ROLE: "service_role" }));
});
