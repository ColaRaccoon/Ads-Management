import {
  asIsoTimestamp,
  asRecord,
  asStrictString,
  assertExactKeys,
  canonicalJson,
  canonicalSha256,
  sha256Hex
} from "../shared/strict-json";
import { CloudTargetBinding, targetBindingSha256 } from "../shared/target-binding";

export const STORAGE_POLICY_CONTRACT_VERSION = 1;
export const STORAGE_APP_ROLE = "storage_app";
export const STORAGE_POLICY_CREDENTIAL_APPROVAL_VERSION = "storage-policy-credential-approval/v1";
export const SUPABASE_MANAGEMENT_API_ORIGIN = "https://api.supabase.com";

const PROJECT_REF = /^[a-z0-9]{20}$/;
const BUCKET = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const SAFE_KEY = /^[a-z0-9][a-z0-9._/-]{0,1023}$/;

export type StoragePolicyTarget = {
  projectRef: string;
  bucket: string;
  readinessKey: string;
};

export type StoragePolicyDefinition = {
  name: string;
  command: "SELECT" | "INSERT" | "DELETE";
  role: typeof STORAGE_APP_ROLE;
  usingExpression?: string;
  checkExpression?: string;
};

export type StoragePolicyPlan = {
  contractVersion: typeof STORAGE_POLICY_CONTRACT_VERSION;
  mode: "PLAN";
  target: StoragePolicyTarget;
  activePrefixes: readonly ["uploads/", "reports/"];
  trashPrefixes: readonly ["trash/uploads/", "trash/reports/"];
  directBrowserPrincipals: readonly ["anon", "authenticated"];
  expectedDirectBrowserAccess: "DENY";
  definitions: StoragePolicyDefinition[];
  sql: string;
  planDigestSha256: string;
};

export type ExistingStoragePolicy = {
  name: string;
  command: string;
  roles: string[];
  usingExpression?: string;
  checkExpression?: string;
};

export type StoragePolicyAdapter = {
  readPolicies(target: StoragePolicyTarget): Promise<ExistingStoragePolicy[]>;
  applyExactPlan(plan: StoragePolicyPlan, expectedBeforeDigestSha256: string): Promise<{
    appliedPlanDigestSha256: string;
    after: ExistingStoragePolicy[];
  }>;
  restoreExactPolicies(target: StoragePolicyTarget, before: ExistingStoragePolicy[]): Promise<void>;
};

export type StoragePolicyCredentialApproval = {
  version: typeof STORAGE_POLICY_CREDENTIAL_APPROVAL_VERSION;
  credentialKind: "supabase-fine-grained-token/v1";
  targetSha256: string;
  planDigestSha256: string;
  projectRef: string;
  apiOrigin: typeof SUPABASE_MANAGEMENT_API_ORIGIN;
  endpointPath: string;
  permissions: ["database_write"];
  tokenSha256: string;
  expectedBeforeDigestSha256: string;
  issuedAt: string;
  expiresAt: string;
  revocation: {
    required: true;
    revokeBy: string;
  };
  permissionVerification: "APPROVAL_EVIDENCE_ONLY";
};

export function storagePolicyCredentialApprovalSha256(approval: StoragePolicyCredentialApproval) {
  return canonicalSha256(approval);
}

export function parseStoragePolicyCredentialApproval(input: {
  value: unknown;
  target: CloudTargetBinding;
  plan: StoragePolicyPlan;
  confirmTargetSha256: string;
  confirmPlanSha256: string;
  confirmBeforeSha256: string;
  confirmApprovalSha256: string;
  now?: Date;
}): StoragePolicyCredentialApproval {
  const value = asRecord(input.value, "STORAGE_POLICY_CREDENTIAL_APPROVAL_INVALID");
  assertExactKeys(value, [
    "version", "credentialKind", "targetSha256", "planDigestSha256", "projectRef", "apiOrigin",
    "endpointPath", "permissions", "tokenSha256", "expectedBeforeDigestSha256", "issuedAt", "expiresAt",
    "revocation", "permissionVerification"
  ], "STORAGE_POLICY_CREDENTIAL_APPROVAL_KEYS_INVALID");
  if (value.version !== STORAGE_POLICY_CREDENTIAL_APPROVAL_VERSION) {
    throw new Error("STORAGE_POLICY_CREDENTIAL_APPROVAL_VERSION_INVALID");
  }
  if (value.credentialKind !== "supabase-fine-grained-token/v1") {
    throw new Error("STORAGE_POLICY_CREDENTIAL_KIND_INVALID");
  }
  const targetSha256 = asStrictString(value.targetSha256, "STORAGE_POLICY_APPROVAL_TARGET_DIGEST_INVALID", /^[0-9a-f]{64}$/, 64);
  const planDigestSha256 = asStrictString(value.planDigestSha256, "STORAGE_POLICY_APPROVAL_PLAN_DIGEST_INVALID", /^[0-9a-f]{64}$/, 64);
  const projectRef = asStrictString(value.projectRef, "STORAGE_POLICY_APPROVAL_PROJECT_REF_INVALID", PROJECT_REF, 20);
  if (value.apiOrigin !== SUPABASE_MANAGEMENT_API_ORIGIN) throw new Error("STORAGE_POLICY_APPROVAL_API_ORIGIN_INVALID");
  const endpointPath = asStrictString(value.endpointPath, "STORAGE_POLICY_APPROVAL_ENDPOINT_INVALID", undefined, 128);
  const expectedEndpointPath = `/v1/projects/${input.target.projectRef}/database/query`;
  if (endpointPath !== expectedEndpointPath) throw new Error("STORAGE_POLICY_APPROVAL_ENDPOINT_INVALID");
  if (!Array.isArray(value.permissions) || value.permissions.length !== 1 || value.permissions[0] !== "database_write") {
    throw new Error("STORAGE_POLICY_APPROVAL_PERMISSIONS_INVALID");
  }
  const tokenSha256 = asStrictString(value.tokenSha256, "STORAGE_POLICY_FINE_GRAINED_TOKEN_DIGEST_INVALID", /^[0-9a-f]{64}$/, 64);
  const expectedBeforeDigestSha256 = asStrictString(
    value.expectedBeforeDigestSha256, "STORAGE_POLICY_BEFORE_DIGEST_INVALID", /^[0-9a-f]{64}$/, 64
  );
  const issuedAt = asIsoTimestamp(value.issuedAt, "STORAGE_POLICY_APPROVAL_ISSUED_AT_INVALID");
  const expiresAt = asIsoTimestamp(value.expiresAt, "STORAGE_POLICY_APPROVAL_EXPIRES_AT_INVALID");
  const revocation = asRecord(value.revocation, "STORAGE_POLICY_APPROVAL_REVOCATION_INVALID");
  assertExactKeys(revocation, ["required", "revokeBy"], "STORAGE_POLICY_APPROVAL_REVOCATION_KEYS_INVALID");
  if (revocation.required !== true) throw new Error("STORAGE_POLICY_APPROVAL_REVOCATION_REQUIRED");
  const revokeBy = asIsoTimestamp(revocation.revokeBy, "STORAGE_POLICY_APPROVAL_REVOKE_BY_INVALID");
  if (value.permissionVerification !== "APPROVAL_EVIDENCE_ONLY") {
    throw new Error("STORAGE_POLICY_PERMISSION_VERIFICATION_INVALID");
  }

  const now = (input.now ?? new Date()).getTime();
  const issued = Date.parse(issuedAt);
  const expires = Date.parse(expiresAt);
  const revoke = Date.parse(revokeBy);
  if (issued > now + 5 * 60_000 || expires <= now) throw new Error("STORAGE_POLICY_CREDENTIAL_APPROVAL_EXPIRED_OR_FUTURE");
  if (expires <= issued || expires - issued > 60 * 60_000) throw new Error("STORAGE_POLICY_CREDENTIAL_APPROVAL_LIFETIME_INVALID");
  if (revoke < expires || revoke - expires > 15 * 60_000) throw new Error("STORAGE_POLICY_CREDENTIAL_APPROVAL_REVOCATION_WINDOW_INVALID");
  if (targetSha256 !== targetBindingSha256(input.target) || targetSha256 !== input.confirmTargetSha256) {
    throw new Error("STORAGE_POLICY_APPROVAL_TARGET_MISMATCH");
  }
  if (planDigestSha256 !== input.plan.planDigestSha256 || planDigestSha256 !== input.confirmPlanSha256) {
    throw new Error("STORAGE_POLICY_PLAN_CONFIRMATION_MISMATCH");
  }
  if (projectRef !== input.target.projectRef || input.plan.target.projectRef !== input.target.projectRef) {
    throw new Error("STORAGE_POLICY_APPROVAL_PROJECT_MISMATCH");
  }
  if (expectedBeforeDigestSha256 !== input.confirmBeforeSha256) {
    throw new Error("STORAGE_POLICY_BEFORE_CONFIRMATION_MISMATCH");
  }
  const approval: StoragePolicyCredentialApproval = {
    version: STORAGE_POLICY_CREDENTIAL_APPROVAL_VERSION,
    credentialKind: "supabase-fine-grained-token/v1",
    targetSha256,
    planDigestSha256,
    projectRef,
    apiOrigin: SUPABASE_MANAGEMENT_API_ORIGIN,
    endpointPath,
    permissions: ["database_write"],
    tokenSha256,
    expectedBeforeDigestSha256,
    issuedAt,
    expiresAt,
    revocation: { required: true, revokeBy },
    permissionVerification: "APPROVAL_EVIDENCE_ONLY"
  };
  if (storagePolicyCredentialApprovalSha256(approval) !== input.confirmApprovalSha256) {
    throw new Error("STORAGE_POLICY_CREDENTIAL_APPROVAL_CONFIRMATION_MISMATCH");
  }
  return approval;
}

export function buildStoragePolicyPlan(target: StoragePolicyTarget): StoragePolicyPlan {
  const normalized = validateStoragePolicyTarget(target);
  const prefixExpression = objectScopeExpression(normalized.bucket, false, normalized.readinessKey);
  const readExpression = objectScopeExpression(normalized.bucket, true, normalized.readinessKey);
  const definitions: StoragePolicyDefinition[] = [
    {
      name: "storage_app_read_exact_scope_v1",
      command: "SELECT",
      role: STORAGE_APP_ROLE,
      usingExpression: readExpression
    },
    {
      name: "storage_app_insert_exact_scope_v1",
      command: "INSERT",
      role: STORAGE_APP_ROLE,
      checkExpression: prefixExpression
    },
    {
      name: "storage_app_delete_exact_scope_v1",
      command: "DELETE",
      role: STORAGE_APP_ROLE,
      usingExpression: prefixExpression
    }
  ];
  const sql = renderStoragePolicySql(normalized, definitions);
  const digestInput = { contractVersion: STORAGE_POLICY_CONTRACT_VERSION, target: normalized, definitions, sql };
  return {
    contractVersion: STORAGE_POLICY_CONTRACT_VERSION,
    mode: "PLAN",
    target: normalized,
    activePrefixes: ["uploads/", "reports/"],
    trashPrefixes: ["trash/uploads/", "trash/reports/"],
    directBrowserPrincipals: ["anon", "authenticated"],
    expectedDirectBrowserAccess: "DENY",
    definitions,
    sql,
    planDigestSha256: sha256Hex(canonicalJson(digestInput))
  };
}

export function validateStoragePolicyTarget(target: StoragePolicyTarget): StoragePolicyTarget {
  const keys = Object.keys(target).sort().join(",");
  if (keys !== "bucket,projectRef,readinessKey") throw new Error("STORAGE_POLICY_TARGET_FIELDS_INVALID");
  if (!PROJECT_REF.test(target.projectRef)) throw new Error("STORAGE_POLICY_PROJECT_REF_INVALID");
  if (!BUCKET.test(target.bucket)) throw new Error("STORAGE_POLICY_BUCKET_INVALID");
  if (!SAFE_KEY.test(target.readinessKey) || target.readinessKey.includes("..") || target.readinessKey.includes("//")) {
    throw new Error("STORAGE_POLICY_READINESS_KEY_INVALID");
  }
  if (["uploads/", "reports/", "trash/uploads/", "trash/reports/"].some((prefix) =>
    target.readinessKey === prefix.slice(0, -1) || target.readinessKey.startsWith(prefix)
  )) throw new Error("STORAGE_POLICY_READINESS_KEY_OVERLAPS_MUTABLE_SCOPE");
  return { ...target };
}

export function storagePolicyInventoryDigest(policies: ExistingStoragePolicy[]) {
  const normalized = policies.map((policy) => ({
    name: policy.name,
    command: policy.command.toUpperCase(),
    roles: [...policy.roles].sort(),
    usingExpression: policy.usingExpression ?? null,
    checkExpression: policy.checkExpression ?? null
  })).sort((left, right) => left.name.localeCompare(right.name));
  return sha256Hex(canonicalJson(normalized));
}

export function assertStoragePolicyApplyPreconditions(
  plan: StoragePolicyPlan,
  existing: ExistingStoragePolicy[],
  expectedBeforeDigestSha256: string
) {
  if (storagePolicyInventoryDigest(existing) !== expectedBeforeDigestSha256) {
    throw new Error("STORAGE_POLICY_BEFORE_DIGEST_MISMATCH");
  }
  const managed = new Map(plan.definitions.map((definition) => [definition.name, definition]));
  for (const policy of existing) {
    const expected = managed.get(policy.name);
    if (!expected) continue;
    if (
      policy.command.toUpperCase() !== expected.command ||
      policy.roles.length !== 1 || policy.roles[0] !== STORAGE_APP_ROLE ||
      (policy.usingExpression ?? null) !== (expected.usingExpression ?? null) ||
      (policy.checkExpression ?? null) !== (expected.checkExpression ?? null)
    ) throw new Error("STORAGE_POLICY_MANAGED_POLICY_DRIFT");
  }
  const conflicting = existing.filter((policy) =>
    !managed.has(policy.name) && policy.roles.some((role) =>
      role === STORAGE_APP_ROLE || role === "anon" || role === "authenticated"
    )
  );
  if (conflicting.length > 0) throw new Error("STORAGE_POLICY_UNEXPECTED_EXISTING_POLICY");
}

export function storagePolicyPublicEvidence(plan: StoragePolicyPlan, existing: ExistingStoragePolicy[]) {
  return {
    event: "storage-policy-plan",
    contractVersion: plan.contractVersion,
    target: plan.target,
    role: STORAGE_APP_ROLE,
    commands: plan.definitions.map((definition) => definition.command),
    managedPolicyCount: plan.definitions.length,
    existingPolicyCount: existing.length,
    beforeDigestSha256: storagePolicyInventoryDigest(existing),
    planDigestSha256: plan.planDigestSha256,
    directBrowserAccess: "DENY" as const,
    result: "NOT_RUN" as const
  };
}

export async function executeStoragePolicyPlan(input: {
  plan: StoragePolicyPlan;
  expectedBeforeDigestSha256: string;
  mode: "DRY_RUN" | "APPLY";
  adapter: StoragePolicyAdapter;
}) {
  const before = await input.adapter.readPolicies(input.plan.target);
  assertStoragePolicyApplyPreconditions(input.plan, before, input.expectedBeforeDigestSha256);
  if (input.mode === "DRY_RUN") {
    return { result: "NOT_RUN" as const, beforeDigestSha256: storagePolicyInventoryDigest(before), rolledBack: false as const };
  }
  try {
    const applied = await input.adapter.applyExactPlan(input.plan, input.expectedBeforeDigestSha256);
    if (applied.appliedPlanDigestSha256 !== input.plan.planDigestSha256) {
      throw new Error("STORAGE_POLICY_APPLIED_PLAN_DIGEST_MISMATCH");
    }
    assertExactManagedPolicies(input.plan, applied.after);
    return {
      result: "PASS" as const,
      beforeDigestSha256: input.expectedBeforeDigestSha256,
      afterDigestSha256: storagePolicyInventoryDigest(applied.after),
      rolledBack: false as const
    };
  } catch (error) {
    await input.adapter.restoreExactPolicies(input.plan.target, before);
    const wrapped = new Error("STORAGE_POLICY_APPLY_FAILED_ROLLED_BACK", { cause: error });
    throw wrapped;
  }
}

export function createSupabaseManagementStoragePolicyAdapter(input: {
  target: CloudTargetBinding;
  plan: StoragePolicyPlan;
  confirmTargetSha256: string;
  confirmPlanSha256: string;
  confirmBeforeSha256: string;
  confirmApprovalSha256: string;
  credentialApproval: unknown;
  fineGrainedToken: string;
  now?: Date;
  fetchImpl: typeof fetch;
}): StoragePolicyAdapter {
  const approval = parseStoragePolicyCredentialApproval({
    value: input.credentialApproval,
    target: input.target,
    plan: input.plan,
    confirmTargetSha256: input.confirmTargetSha256,
    confirmPlanSha256: input.confirmPlanSha256,
    confirmBeforeSha256: input.confirmBeforeSha256,
    confirmApprovalSha256: input.confirmApprovalSha256,
    now: input.now
  });
  if (!input.fineGrainedToken || input.fineGrainedToken.length > 16_384 ||
      sha256Hex(input.fineGrainedToken) !== approval.tokenSha256 || typeof input.fetchImpl !== "function") {
    throw new Error("STORAGE_POLICY_PROVIDER_CREDENTIAL_MISMATCH");
  }
  assertBoundPolicyTarget(input.target, input.plan.target);
  const endpoint = `${approval.apiOrigin}${approval.endpointPath}`;
  const query = async (sql: string, readOnly: boolean) => {
    const response = await input.fetchImpl(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${input.fineGrainedToken}`, "content-type": "application/json" },
      body: JSON.stringify({ query: sql, read_only: readOnly })
    });
    if (response.status === 401) throw new Error("STORAGE_POLICY_PROVIDER_UNAUTHORIZED");
    if (response.status === 403) throw new Error("STORAGE_POLICY_PROVIDER_FORBIDDEN");
    if (response.status !== 201) throw new Error("STORAGE_POLICY_PROVIDER_STATUS_INVALID");
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new Error("STORAGE_POLICY_PROVIDER_RESPONSE_INVALID");
    }
    if (!Array.isArray(value)) throw new Error("STORAGE_POLICY_PROVIDER_RESPONSE_INVALID");
    return value;
  };
  const readPolicies = async (target: StoragePolicyTarget) => {
    assertBoundPolicyTarget(input.target, target);
    const rows = await query([
      "SELECT policyname AS name, cmd AS command, to_json(roles) AS roles,",
      "qual AS using_expression, with_check AS check_expression",
      "FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' ORDER BY policyname"
    ].join(" "), true);
    return rows.map(parseProviderPolicy);
  };
  return {
    readPolicies,
    applyExactPlan: async (plan, expectedBeforeDigestSha256) => {
      assertBoundPolicyTarget(input.target, plan.target);
      if (plan.planDigestSha256 !== approval.planDigestSha256 ||
          expectedBeforeDigestSha256 !== approval.expectedBeforeDigestSha256) {
        throw new Error("STORAGE_POLICY_PROVIDER_APPROVAL_BINDING_MISMATCH");
      }
      const before = await readPolicies(plan.target);
      assertStoragePolicyApplyPreconditions(plan, before, expectedBeforeDigestSha256);
      await query(plan.sql, false);
      return { appliedPlanDigestSha256: plan.planDigestSha256, after: await readPolicies(plan.target) };
    },
    restoreExactPolicies: async (target, before) => {
      assertBoundPolicyTarget(input.target, target);
      const plan = buildStoragePolicyPlan(target);
      assertStoragePolicyApplyPreconditions(plan, before, storagePolicyInventoryDigest(before));
      await query(renderManagedRollbackSql(plan, before), false);
      const restored = await readPolicies(target);
      if (storagePolicyInventoryDigest(restored) !== storagePolicyInventoryDigest(before)) {
        throw new Error("STORAGE_POLICY_ROLLBACK_VERIFY_FAILED");
      }
    }
  };
}

function assertExactManagedPolicies(plan: StoragePolicyPlan, policies: ExistingStoragePolicy[]) {
  const managedNames = new Set(plan.definitions.map((definition) => definition.name));
  const managed = policies.filter((policy) => managedNames.has(policy.name));
  if (managed.length !== plan.definitions.length) throw new Error("STORAGE_POLICY_MANAGED_POLICY_COUNT_INVALID");
  assertStoragePolicyApplyPreconditions(plan, policies, storagePolicyInventoryDigest(policies));
}

function assertBoundPolicyTarget(binding: CloudTargetBinding, target: StoragePolicyTarget) {
  if (target.projectRef !== binding.projectRef) throw new Error("STORAGE_POLICY_PROVIDER_TARGET_MISMATCH");
  validateStoragePolicyTarget(target);
}

function parseProviderPolicy(value: unknown): ExistingStoragePolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("STORAGE_POLICY_PROVIDER_RESPONSE_INVALID");
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row).sort().join(",");
  if (keys !== "check_expression,command,name,roles,using_expression" || typeof row.name !== "string" ||
      typeof row.command !== "string" || !Array.isArray(row.roles) || !row.roles.every((role) => typeof role === "string") ||
      (row.using_expression !== null && typeof row.using_expression !== "string") ||
      (row.check_expression !== null && typeof row.check_expression !== "string")) {
    throw new Error("STORAGE_POLICY_PROVIDER_RESPONSE_INVALID");
  }
  return {
    name: row.name,
    command: row.command,
    roles: [...row.roles] as string[],
    ...(row.using_expression === null ? {} : { usingExpression: row.using_expression as string }),
    ...(row.check_expression === null ? {} : { checkExpression: row.check_expression as string })
  };
}

function renderManagedRollbackSql(plan: StoragePolicyPlan, before: ExistingStoragePolicy[]) {
  const definitions = new Map(plan.definitions.map((definition) => [definition.name, definition]));
  const beforeNames = new Set(before.map((policy) => policy.name));
  const statements = ["BEGIN;"];
  for (const definition of plan.definitions) statements.push(`DROP POLICY IF EXISTS ${sqlIdentifier(definition.name)} ON storage.objects;`);
  for (const definition of plan.definitions) {
    if (!beforeNames.has(definition.name)) continue;
    const condition = definition.command === "INSERT"
      ? `WITH CHECK ${definition.checkExpression}`
      : `USING ${definition.usingExpression}`;
    if (!definitions.has(definition.name)) throw new Error("STORAGE_POLICY_ROLLBACK_DEFINITION_INVALID");
    statements.push(`CREATE POLICY ${sqlIdentifier(definition.name)} ON storage.objects FOR ${definition.command} TO ${sqlIdentifier(definition.role)} ${condition};`);
  }
  statements.push("COMMIT;");
  return statements.join("\n");
}

function objectScopeExpression(bucket: string, includeReadiness: boolean, readinessKey: string) {
  const prefixes = ["uploads/", "reports/", "trash/uploads/", "trash/reports/"];
  const names = prefixes.map((prefix) => `name LIKE ${sqlLiteral(`${prefix}%`)}`).join(" OR ");
  const readiness = includeReadiness ? ` OR name = ${sqlLiteral(readinessKey)}` : "";
  return `(bucket_id = ${sqlLiteral(bucket)} AND ((${names})${readiness}))`;
}

function renderStoragePolicySql(target: StoragePolicyTarget, definitions: StoragePolicyDefinition[]) {
  const drop = definitions.map((definition) =>
    `DROP POLICY IF EXISTS ${sqlIdentifier(definition.name)} ON storage.objects;`
  ).join("\n");
  const create = definitions.map((definition) => {
    const condition = definition.command === "INSERT"
      ? `WITH CHECK ${definition.checkExpression}`
      : `USING ${definition.usingExpression}`;
    return `CREATE POLICY ${sqlIdentifier(definition.name)} ON storage.objects FOR ${definition.command} TO ${sqlIdentifier(definition.role)} ${condition};`;
  }).join("\n");
  return [
    "BEGIN;",
    `-- target-project-ref: ${target.projectRef}`,
    `-- target-bucket: ${target.bucket}`,
    "-- Requires a separately approved, pre-existing NOLOGIN storage_app role granted to authenticator",
    "-- with only the provider-required base grants (Supabase documents anon -> storage_app).",
    "-- No anon/authenticated policy is created; Storage RLS default-deny remains authoritative.",
    drop,
    create,
    "COMMIT;"
  ].join("\n");
}

function sqlLiteral(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

function sqlIdentifier(value: string) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw new Error("STORAGE_POLICY_IDENTIFIER_INVALID");
  return `"${value}"`;
}
