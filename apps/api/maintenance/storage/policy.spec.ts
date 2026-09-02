import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertStoragePolicyApplyPreconditions,
  buildStoragePolicyPlan,
  createSupabaseManagementStoragePolicyAdapter,
  executeStoragePolicyPlan,
  StoragePolicyCredentialApproval,
  storagePolicyCredentialApprovalSha256,
  storagePolicyInventoryDigest,
  storagePolicyPublicEvidence
} from "./policy";
import { canonicalSha256, sha256Hex } from "../shared/strict-json";
import { CloudTargetBinding, targetBindingSha256 } from "../shared/target-binding";
import { runStoragePolicyCli } from "./policy.cli";

const target = {
  projectRef: "abcdefghijklmnopqrst",
  bucket: "private-business-files",
  readinessKey: "health/readiness-sentinel"
};

describe("storage policy plan", () => {
  it("renders deterministic SELECT/INSERT/DELETE policies for only the app scope", () => {
    const first = buildStoragePolicyPlan(target);
    const second = buildStoragePolicyPlan({ ...target });
    expect(first).toEqual(second);
    expect(first.definitions.map((definition) => definition.command)).toEqual(["SELECT", "INSERT", "DELETE"]);
    expect(first.sql).toContain("TO \"storage_app\"");
    expect(first.sql).not.toMatch(/TO \"(?:anon|authenticated)\"/);
    expect(first.definitions[0].usingExpression).toContain("health/readiness-sentinel");
    expect(first.definitions[1].checkExpression).not.toContain("health/readiness-sentinel");
  });

  it("rejects ambiguous targets and a readiness key inside mutable prefixes", () => {
    expect(() => buildStoragePolicyPlan({ ...target, projectRef: "wrong" })).toThrow("STORAGE_POLICY_PROJECT_REF_INVALID");
    expect(() => buildStoragePolicyPlan({ ...target, readinessKey: "uploads/sentinel" }))
      .toThrow("STORAGE_POLICY_READINESS_KEY_OVERLAPS_MUTABLE_SCOPE");
    expect(() => buildStoragePolicyPlan({ ...target, extra: true } as never))
      .toThrow("STORAGE_POLICY_TARGET_FIELDS_INVALID");
  });

  it("fails closed on before-digest drift or an existing app/browser policy", () => {
    const plan = buildStoragePolicyPlan(target);
    const emptyDigest = storagePolicyInventoryDigest([]);
    expect(() => assertStoragePolicyApplyPreconditions(plan, [], emptyDigest)).not.toThrow();
    expect(() => assertStoragePolicyApplyPreconditions(plan, [], "0".repeat(64)))
      .toThrow("STORAGE_POLICY_BEFORE_DIGEST_MISMATCH");
    const existing = [{ name: "legacy", command: "SELECT", roles: ["authenticated"] }];
    expect(() => assertStoragePolicyApplyPreconditions(plan, existing, storagePolicyInventoryDigest(existing)))
      .toThrow("STORAGE_POLICY_UNEXPECTED_EXISTING_POLICY");
  });

  it("allows an exact idempotent managed reapply but rejects managed drift", () => {
    const plan = buildStoragePolicyPlan(target);
    const exact = plan.definitions.map((definition) => ({
      name: definition.name,
      command: definition.command,
      roles: [definition.role],
      usingExpression: definition.usingExpression,
      checkExpression: definition.checkExpression
    }));
    expect(() => assertStoragePolicyApplyPreconditions(plan, exact, storagePolicyInventoryDigest(exact))).not.toThrow();
    const drift = exact.map((policy, index) => index === 0 ? { ...policy, usingExpression: "true" } : policy);
    expect(() => assertStoragePolicyApplyPreconditions(plan, drift, storagePolicyInventoryDigest(drift)))
      .toThrow("STORAGE_POLICY_MANAGED_POLICY_DRIFT");
  });

  it("emits only a redacted NOT_RUN plan receipt", () => {
    const evidence = storagePolicyPublicEvidence(buildStoragePolicyPlan(target), []);
    expect(evidence).toMatchObject({ result: "NOT_RUN", directBrowserAccess: "DENY", existingPolicyCount: 0 });
    expect(JSON.stringify(evidence)).not.toContain("CREATE POLICY");
  });

  it("applies through an adapter and restores the exact before inventory on verification fault", async () => {
    const plan = buildStoragePolicyPlan(target);
    const after = plan.definitions.map((definition) => ({
      name: definition.name, command: definition.command, roles: [definition.role],
      usingExpression: definition.usingExpression, checkExpression: definition.checkExpression
    }));
    let restored = false;
    const adapter = {
      readPolicies: async () => [],
      applyExactPlan: async () => ({ appliedPlanDigestSha256: plan.planDigestSha256, after }),
      restoreExactPolicies: async () => { restored = true; }
    };
    await expect(executeStoragePolicyPlan({
      plan, expectedBeforeDigestSha256: storagePolicyInventoryDigest([]), mode: "APPLY", adapter
    })).resolves.toMatchObject({ result: "PASS", rolledBack: false });
    const broken = { ...adapter, applyExactPlan: async () => ({ appliedPlanDigestSha256: "0".repeat(64), after }) };
    await expect(executeStoragePolicyPlan({
      plan, expectedBeforeDigestSha256: storagePolicyInventoryDigest([]), mode: "APPLY", adapter: broken
    })).rejects.toThrow("STORAGE_POLICY_APPLY_FAILED_ROLLED_BACK");
    expect(restored).toBe(true);
  });

  it("composes the direct Supabase Management API adapter only for the pinned target, plan, and approval", async () => {
    const plan = buildStoragePolicyPlan(target);
    const rows = providerRows(plan);
    const responses: unknown[] = [[], [], [], rows];
    const requests: Array<{ url: string; body: unknown }> = [];
    const fineGrainedToken = "synthetic-fine-grained-token";
    const approval = credentialApproval(cloudTarget, plan, fineGrainedToken);
    const adapter = approvedAdapter({
      binding: cloudTarget, plan, fineGrainedToken, approval,
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify(responses.shift()), { status: 201, headers: { "content-type": "application/json" } });
      }
    });
    await expect(executeStoragePolicyPlan({
      plan, expectedBeforeDigestSha256: storagePolicyInventoryDigest([]), mode: "APPLY", adapter
    })).resolves.toMatchObject({ result: "PASS" });
    expect(requests).toHaveLength(4);
    expect(requests.every((request) => request.url === "https://api.supabase.com/v1/projects/abcdefghijklmnopqrst/database/query")).toBe(true);
    expect(requests.filter((request) => (request.body as { read_only: boolean }).read_only === false)).toHaveLength(1);
  });

  it("fails before fetch for extra permission, wrong project, token digest, expiry, or endpoint drift", () => {
    const plan = buildStoragePolicyPlan(target);
    const fineGrainedToken = "synthetic-fine-grained-token";
    const base = credentialApproval(cloudTarget, plan, fineGrainedToken);
    const expiredIssuedAt = new Date(Date.now() - 60 * 60_000).toISOString();
    const expiredExpiresAt = new Date(Date.now() - 30 * 60_000).toISOString();
    const cases: Array<{ approval: unknown; code: string }> = [
      { approval: { ...base, permissions: ["database_write", "database_read"] }, code: "STORAGE_POLICY_APPROVAL_PERMISSIONS_INVALID" },
      { approval: { ...base, projectRef: "zzzzzzzzzzzzzzzzzzzz" }, code: "STORAGE_POLICY_APPROVAL_PROJECT_MISMATCH" },
      { approval: { ...base, tokenSha256: sha256Hex("different-token") }, code: "STORAGE_POLICY_PROVIDER_CREDENTIAL_MISMATCH" },
      {
        approval: {
          ...base,
          issuedAt: expiredIssuedAt,
          expiresAt: expiredExpiresAt,
          revocation: { required: true, revokeBy: new Date(Date.parse(expiredExpiresAt) + 5 * 60_000).toISOString() }
        },
        code: "STORAGE_POLICY_CREDENTIAL_APPROVAL_EXPIRED_OR_FUTURE"
      },
      { approval: { ...base, apiOrigin: "https://example.invalid" }, code: "STORAGE_POLICY_APPROVAL_API_ORIGIN_INVALID" },
      { approval: { ...base, endpointPath: "/v1/projects/other/database/query" }, code: "STORAGE_POLICY_APPROVAL_ENDPOINT_INVALID" }
    ];
    for (const item of cases) {
      let fetchCalls = 0;
      let mutations = 0;
      expect(() => createSupabaseManagementStoragePolicyAdapter({
        target: cloudTarget,
        plan,
        confirmTargetSha256: targetBindingSha256(cloudTarget),
        confirmPlanSha256: plan.planDigestSha256,
        confirmBeforeSha256: base.expectedBeforeDigestSha256,
        confirmApprovalSha256: canonicalSha256(item.approval),
        credentialApproval: item.approval,
        fineGrainedToken,
        fetchImpl: async (_url, init) => {
          fetchCalls += 1;
          if ((JSON.parse(String(init?.body)) as { read_only: boolean }).read_only === false) mutations += 1;
          return new Response("[]", { status: 201 });
        }
      })).toThrow(item.code);
      expect(fetchCalls).toBe(0);
      expect(mutations).toBe(0);
    }

    let confirmationFetchCalls = 0;
    const noFetch = async () => {
      confirmationFetchCalls += 1;
      return new Response("[]", { status: 201 });
    };
    expect(() => createSupabaseManagementStoragePolicyAdapter({
      target: cloudTarget,
      plan,
      confirmTargetSha256: targetBindingSha256(cloudTarget),
      confirmPlanSha256: plan.planDigestSha256,
      confirmBeforeSha256: "0".repeat(64),
      confirmApprovalSha256: storagePolicyCredentialApprovalSha256(base),
      credentialApproval: base,
      fineGrainedToken,
      fetchImpl: noFetch
    })).toThrow("STORAGE_POLICY_BEFORE_CONFIRMATION_MISMATCH");
    expect(() => createSupabaseManagementStoragePolicyAdapter({
      target: cloudTarget,
      plan,
      confirmTargetSha256: targetBindingSha256(cloudTarget),
      confirmPlanSha256: plan.planDigestSha256,
      confirmBeforeSha256: base.expectedBeforeDigestSha256,
      confirmApprovalSha256: "0".repeat(64),
      credentialApproval: base,
      fineGrainedToken,
      fetchImpl: noFetch
    })).toThrow("STORAGE_POLICY_CREDENTIAL_APPROVAL_CONFIRMATION_MISMATCH");
    expect(confirmationFetchCalls).toBe(0);
  });

  it("accepts only the documented 201 response and maps 401/403/invalid responses", async () => {
    const plan = buildStoragePolicyPlan(target);
    const fineGrainedToken = "synthetic-fine-grained-token";
    const approval = credentialApproval(cloudTarget, plan, fineGrainedToken);
    const responseCases: Array<{ response: Response; code?: string }> = [
      { response: new Response("{}", { status: 401 }), code: "STORAGE_POLICY_PROVIDER_UNAUTHORIZED" },
      { response: new Response("{}", { status: 403 }), code: "STORAGE_POLICY_PROVIDER_FORBIDDEN" },
      { response: new Response("[]", { status: 200 }), code: "STORAGE_POLICY_PROVIDER_STATUS_INVALID" },
      { response: new Response("{", { status: 201 }), code: "STORAGE_POLICY_PROVIDER_RESPONSE_INVALID" },
      { response: new Response("{}", { status: 201 }), code: "STORAGE_POLICY_PROVIDER_RESPONSE_INVALID" },
      { response: new Response("[]", { status: 201 }) }
    ];
    for (const item of responseCases) {
      const adapter = approvedAdapter({ binding: cloudTarget, plan, fineGrainedToken, approval, fetchImpl: async () => item.response });
      if (item.code) await expect(adapter.readPolicies(plan.target)).rejects.toThrow(item.code);
      else await expect(adapter.readPolicies(plan.target)).resolves.toEqual([]);
    }
  });

  it("uses the approved adapter for rollback and verifies the restored inventory", async () => {
    const plan = buildStoragePolicyPlan(target);
    const fineGrainedToken = "synthetic-fine-grained-token";
    const approval = credentialApproval(cloudTarget, plan, fineGrainedToken);
    const responses: unknown[] = [[], [], [], [], [], []];
    let mutations = 0;
    const adapter = approvedAdapter({
      binding: cloudTarget,
      plan,
      fineGrainedToken,
      approval,
      fetchImpl: async (_url, init) => {
        if ((JSON.parse(String(init?.body)) as { read_only: boolean }).read_only === false) mutations += 1;
        return new Response(JSON.stringify(responses.shift()), { status: 201 });
      }
    });
    await expect(executeStoragePolicyPlan({
      plan,
      expectedBeforeDigestSha256: approval.expectedBeforeDigestSha256,
      mode: "APPLY",
      adapter
    })).rejects.toThrow("STORAGE_POLICY_APPLY_FAILED_ROLLED_BACK");
    expect(mutations).toBe(2);
  });

  it("requires separate protected approval and independent approval/plan/before confirmations in the direct CLI", async () => {
    const now = Date.now();
    const binding = {
      ...cloudTarget,
      issuedAt: new Date(now - 60_000).toISOString(),
      expiresAt: new Date(now + 60 * 60_000).toISOString()
    };
    const plan = buildStoragePolicyPlan(target);
    const fineGrainedToken = "synthetic-fine-grained-token";
    const directory = mkdtempSync(path.join(os.tmpdir(), "storage-policy-cli-"));
    const file = path.join(directory, "manifest.json");
    const approvalFile = path.join(directory, "credential-approval.json");
    writeFileSync(file, JSON.stringify({
      target: binding,
      confirmation: { projectRef: binding.projectRef, releaseGitSha: binding.releaseGitSha, targetSha256: targetBindingSha256(binding) },
      storage: { bucket: target.bucket, readinessKey: target.readinessKey }
    }));
    const approval = credentialApproval(binding, plan, fineGrainedToken);
    writeFileSync(approvalFile, JSON.stringify(approval));
    const rows = providerRows(plan);
    const responses: unknown[] = [[], [], [], rows];
    let calls = 0;
    let mutations = 0;
    const argv = [
      `--manifest=${file}`,
      `--credential-approval=${approvalFile}`,
      "--execute",
      `--confirm-plan-sha256=${plan.planDigestSha256}`,
      `--confirm-before-sha256=${storagePolicyInventoryDigest([])}`,
      `--confirm-approval-sha256=${storagePolicyCredentialApprovalSha256(approval)}`
    ];
    const output = await runStoragePolicyCli({
      argv,
      env: { SUPABASE_URL: binding.supabaseOrigin, SUPABASE_FINE_GRAINED_TOKEN: fineGrainedToken },
      fetchImpl: async (_url, init) => {
        calls += 1;
        if ((JSON.parse(String(init?.body)) as { read_only: boolean }).read_only === false) mutations += 1;
        return new Response(JSON.stringify(responses.shift()), { status: 201 });
      }
    });
    expect(output).toContain('"result":"PASS"');
    expect(output).toContain('"permissionVerification":"APPROVAL_EVIDENCE_ONLY"');
    expect(output).not.toContain(fineGrainedToken);
    expect(calls).toBe(4);
    expect(mutations).toBe(1);

    calls = 0;
    mutations = 0;
    await expect(runStoragePolicyCli({
      argv,
      env: {
        SUPABASE_URL: binding.supabaseOrigin,
        SUPABASE_FINE_GRAINED_TOKEN: fineGrainedToken,
        SUPABASE_ACCESS_TOKEN: "generic-token-must-be-rejected"
      },
      fetchImpl: async () => { calls += 1; mutations += 1; return new Response("[]", { status: 201 }); }
    })).rejects.toThrow("STORAGE_POLICY_GENERIC_TOKEN_ENV_REJECTED");
    expect(calls).toBe(0);
    expect(mutations).toBe(0);

    await expect(runStoragePolicyCli({
      argv: argv.map((arg) => arg.startsWith("--confirm-plan") ? `--confirm-plan-sha256=${"0".repeat(64)}` : arg),
      env: { SUPABASE_URL: binding.supabaseOrigin, SUPABASE_FINE_GRAINED_TOKEN: fineGrainedToken },
      fetchImpl: async () => { throw new Error("must not call"); }
    })).rejects.toThrow("STORAGE_POLICY_PLAN_CONFIRMATION_MISMATCH");
  });
});

function providerRows(plan: ReturnType<typeof buildStoragePolicyPlan>) {
  return plan.definitions.map((definition) => ({
    name: definition.name,
    command: definition.command,
    roles: [definition.role],
    using_expression: definition.usingExpression ?? null,
    check_expression: definition.checkExpression ?? null
  }));
}

function credentialApproval(
  binding: CloudTargetBinding,
  plan: ReturnType<typeof buildStoragePolicyPlan>,
  fineGrainedToken: string
): StoragePolicyCredentialApproval {
  const now = Date.now();
  const expiresAt = new Date(now + 30 * 60_000).toISOString();
  return {
    version: "storage-policy-credential-approval/v1",
    credentialKind: "supabase-fine-grained-token/v1",
    targetSha256: targetBindingSha256(binding),
    planDigestSha256: plan.planDigestSha256,
    projectRef: binding.projectRef,
    apiOrigin: "https://api.supabase.com",
    endpointPath: `/v1/projects/${binding.projectRef}/database/query`,
    permissions: ["database_write"],
    tokenSha256: sha256Hex(fineGrainedToken),
    expectedBeforeDigestSha256: storagePolicyInventoryDigest([]),
    issuedAt: new Date(now - 60_000).toISOString(),
    expiresAt,
    revocation: { required: true, revokeBy: new Date(Date.parse(expiresAt) + 10 * 60_000).toISOString() },
    permissionVerification: "APPROVAL_EVIDENCE_ONLY"
  };
}

function approvedAdapter(input: {
  binding: CloudTargetBinding;
  plan: ReturnType<typeof buildStoragePolicyPlan>;
  fineGrainedToken: string;
  approval: StoragePolicyCredentialApproval;
  fetchImpl: typeof fetch;
}) {
  return createSupabaseManagementStoragePolicyAdapter({
    target: input.binding,
    plan: input.plan,
    confirmTargetSha256: targetBindingSha256(input.binding),
    confirmPlanSha256: input.plan.planDigestSha256,
    confirmBeforeSha256: input.approval.expectedBeforeDigestSha256,
    confirmApprovalSha256: storagePolicyCredentialApprovalSha256(input.approval),
    credentialApproval: input.approval,
    fineGrainedToken: input.fineGrainedToken,
    fetchImpl: input.fetchImpl
  });
}

const cloudTarget = {
  version: "cloud-target-binding/v1", environmentId: "staging-one", environmentClass: "staging",
  projectRef: "abcdefghijklmnopqrst", supabaseOrigin: "https://abcdefghijklmnopqrst.supabase.co",
  database: {
    connectionMode: "direct", host: "db.abcdefghijklmnopqrst.supabase.co", port: 5432, name: "postgres", schema: "app_runtime",
    loginUser: "postgres", expectedCurrentUser: "postgres", requiredRole: "app_maintenance", sslMode: "verify-full",
    tlsServerName: "db.abcdefghijklmnopqrst.supabase.co"
  },
  releaseGitSha: "b".repeat(40), issuedAt: "2026-09-01T00:00:00.000Z", expiresAt: "2026-09-01T01:00:00.000Z"
} satisfies CloudTargetBinding;
