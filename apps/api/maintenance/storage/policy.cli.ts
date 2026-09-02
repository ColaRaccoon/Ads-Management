import { asRecord, assertExactKeys, canonicalJson, readProtectedJsonFile } from "../shared/strict-json";
import { assertNoSensitiveEvidence } from "../shared/redacted-evidence";
import { assertTargetConfirmation, parseCloudTargetBinding, targetBindingSha256 } from "../shared/target-binding";
import {
  buildStoragePolicyPlan,
  createSupabaseManagementStoragePolicyAdapter,
  executeStoragePolicyPlan,
  storagePolicyPublicEvidence
} from "./policy";

export async function runStoragePolicyCli(inputOptions: {
  argv: string[];
  env: NodeJS.ProcessEnv;
  fetchImpl: typeof fetch;
}): Promise<string> {
  const args = strictArgs(inputOptions.argv);
  if (Object.prototype.hasOwnProperty.call(inputOptions.env, "SUPABASE_ACCESS_TOKEN")) {
    throw new Error("STORAGE_POLICY_GENERIC_TOKEN_ENV_REJECTED");
  }
  const input = asRecord(await readProtectedJsonFile(args.manifest), "STORAGE_POLICY_MANIFEST_INVALID");
  assertExactKeys(input, ["target", "confirmation", "storage"], "STORAGE_POLICY_MANIFEST_KEYS_INVALID");
  const target = parseCloudTargetBinding(input.target);
  assertTargetConfirmation(target, input.confirmation as never);
  const storage = asRecord(input.storage, "STORAGE_POLICY_TARGET_INVALID");
  assertExactKeys(storage, ["bucket", "readinessKey"], "STORAGE_POLICY_STORAGE_KEYS_INVALID");
  const plan = buildStoragePolicyPlan({
    projectRef: target.projectRef,
    bucket: storage.bucket as string,
    readinessKey: storage.readinessKey as string
  });
  if (args.execute) {
    if (args.confirmPlanSha256 !== plan.planDigestSha256) throw new Error("STORAGE_POLICY_PLAN_CONFIRMATION_MISMATCH");
    const credentialApproval = await readProtectedJsonFile(args.credentialApproval);
    const supabaseUrl = requiredEnvironment(inputOptions.env, "SUPABASE_URL", 256);
    if (supabaseUrl !== target.supabaseOrigin) throw new Error("STORAGE_POLICY_PROVIDER_TARGET_MISMATCH");
    const fineGrainedToken = requiredEnvironment(inputOptions.env, "SUPABASE_FINE_GRAINED_TOKEN", 16_384);
    const adapter = createSupabaseManagementStoragePolicyAdapter({
      target,
      plan,
      confirmTargetSha256: targetBindingSha256(target),
      confirmPlanSha256: args.confirmPlanSha256,
      confirmBeforeSha256: args.confirmBeforeSha256,
      confirmApprovalSha256: args.confirmApprovalSha256,
      credentialApproval,
      fineGrainedToken,
      fetchImpl: inputOptions.fetchImpl
    });
    const result = await executeStoragePolicyPlan({
      plan,
      expectedBeforeDigestSha256: args.confirmBeforeSha256,
      mode: "APPLY",
      adapter
    });
    if (result.result !== "PASS") throw new Error("STORAGE_POLICY_APPLY_NOT_EXECUTED");
    const evidence = {
      event: "storage-policy-apply", environmentId: target.environmentId, projectRef: target.projectRef,
      releaseGitSha: target.releaseGitSha, targetSha256: targetBindingSha256(target), planDigestSha256: plan.planDigestSha256,
      approvalArtifactSha256: args.confirmApprovalSha256,
      beforeDigestSha256: result.beforeDigestSha256,
      afterDigestSha256: result.afterDigestSha256,
      permissionVerification: "APPROVAL_EVIDENCE_ONLY",
      result: result.result
    };
    assertNoSensitiveEvidence(evidence);
    return `${canonicalJson(evidence)}\n`;
  }
  const evidence = {
    ...storagePolicyPublicEvidence(plan, []),
    environmentId: target.environmentId,
    releaseGitSha: target.releaseGitSha,
    targetSha256: targetBindingSha256(target)
  };
  assertNoSensitiveEvidence(evidence);
  return `${canonicalJson(evidence)}\n`;
}

function strictArgs(argv: string[]) {
  let manifest = "";
  let execute = false;
  let credentialApproval = "";
  let confirmPlanSha256 = "";
  let confirmBeforeSha256 = "";
  let confirmApprovalSha256 = "";
  for (const arg of argv) {
    if (arg.startsWith("--manifest=")) manifest = arg.slice("--manifest=".length);
    else if (arg.startsWith("--credential-approval=")) credentialApproval = arg.slice("--credential-approval=".length);
    else if (arg === "--execute") execute = true;
    else if (arg.startsWith("--confirm-plan-sha256=")) confirmPlanSha256 = arg.slice("--confirm-plan-sha256=".length);
    else if (arg.startsWith("--confirm-before-sha256=")) confirmBeforeSha256 = arg.slice("--confirm-before-sha256=".length);
    else if (arg.startsWith("--confirm-approval-sha256=")) confirmApprovalSha256 = arg.slice("--confirm-approval-sha256=".length);
    else throw new Error("STORAGE_POLICY_CLI_ARGUMENT_INVALID");
  }
  if (!manifest) throw new Error("STORAGE_POLICY_CLI_MANIFEST_REQUIRED");
  if (execute && (!credentialApproval || !/^[0-9a-f]{64}$/.test(confirmPlanSha256) ||
      !/^[0-9a-f]{64}$/.test(confirmBeforeSha256) || !/^[0-9a-f]{64}$/.test(confirmApprovalSha256))) {
    throw new Error("STORAGE_POLICY_CLI_CONFIRMATION_REQUIRED");
  }
  if (!execute && (credentialApproval || confirmPlanSha256 || confirmBeforeSha256 || confirmApprovalSha256)) {
    throw new Error("STORAGE_POLICY_CLI_CONFIRMATION_WITHOUT_EXECUTE");
  }
  return { manifest, execute, credentialApproval, confirmPlanSha256, confirmBeforeSha256, confirmApprovalSha256 };
}

function requiredEnvironment(env: NodeJS.ProcessEnv, name: string, maximum: number) {
  const value = env[name];
  if (typeof value !== "string" || !value || value.length > maximum || value !== value.trim()) throw new Error(`${name}_REQUIRED`);
  return value;
}

if (require.main === module) {
  void runStoragePolicyCli({ argv: process.argv.slice(2), env: process.env, fetchImpl: fetch })
    .then((output) => process.stdout.write(output))
    .catch((error: unknown) => {
      const code = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : "STORAGE_POLICY_CLI_FAILED";
      process.stderr.write(`${JSON.stringify({ event: "storage-policy-plan", result: "FAIL", code })}\n`);
      process.exitCode = 1;
    });
}
