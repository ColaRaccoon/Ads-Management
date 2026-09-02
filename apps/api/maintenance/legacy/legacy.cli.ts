import path from "node:path";
import { asRecord, assertExactKeys, asSafeInteger, asStrictString, canonicalJson, canonicalSha256, readProtectedJsonFile } from "../shared/strict-json";
import { assertNoSensitiveEvidence } from "../shared/redacted-evidence";
import { assertTargetConfirmation, CloudTargetBinding, parseCloudTargetBinding, targetBindingSha256 } from "../shared/target-binding";
import {
  applyLegacyMigrationManifest, createLegacyMigrationPlan, inventoryStorageReferences,
  LegacyMigrationAdapter, LegacyMigrationPlan, legacyInventoryPublicEvidence, pairLegacyTombstonePlans,
  ReferenceCandidate, type LegacyManifestApplyAdapter
} from "./reference-inventory";
import {
  createDirectLegacyContext,
  parseLegacyProviderBinding,
  parseLegacySourceInventoryApproval,
  type LegacyDirectFactories,
  type LegacyProviderBinding,
  type LegacySourceInventoryApproval
} from "./direct-provider";

export type LegacyDirectProviderFactory = (input: {
  target: CloudTargetBinding;
  providerBindingSha256: string;
  plan: LegacyMigrationPlan;
  env: NodeJS.ProcessEnv;
  sourceApproval: LegacySourceInventoryApproval;
  providerBinding: LegacyProviderBinding;
}) => LegacyFactoryAdapter | Promise<LegacyFactoryAdapter>;

type LegacyFactoryAdapter = LegacyMigrationAdapter & Partial<Pick<
  LegacyManifestApplyAdapter,
  "compareAndSwapManifest"
>>;

export async function runLegacyCli(input: {
  argv: string[];
  env: NodeJS.ProcessEnv;
  providerFactory?: LegacyDirectProviderFactory;
  directFactories?: Partial<LegacyDirectFactories>;
  now?: Date;
}): Promise<string> {
  const args = strictArgs(input.argv);
  const now = input.now ?? new Date();
  const [rawManifest, rawSourceApproval, rawProviderBinding] = await Promise.all([
    readProtectedJsonFile(args.manifest),
    args.execute ? readProtectedJsonFile(args.sourceInventory) : Promise.resolve(undefined),
    args.execute ? readProtectedJsonFile(args.providerBinding) : Promise.resolve(undefined)
  ]);
  const value = asRecord(rawManifest, "LEGACY_PLAN_INVALID");
  assertExactKeys(value, args.execute
    ? ["target", "confirmation", "references", "approvedLocalRoots", "migrationPlans", "executionApproval"]
    : ["target", "confirmation", "references", "approvedLocalRoots"], "LEGACY_PLAN_KEYS_INVALID");
  const target = parseCloudTargetBinding(value.target, now);
  assertTargetConfirmation(target, value.confirmation as never);
  if (!Array.isArray(value.references) || !Array.isArray(value.approvedLocalRoots) ||
      !value.approvedLocalRoots.every((root) => typeof root === "string")) {
    throw new Error("LEGACY_PLAN_INPUT_INVALID");
  }
  const inventory = inventoryStorageReferences(value.references as ReferenceCandidate[], value.approvedLocalRoots as string[]);
  if (args.execute) {
    if (!Array.isArray(value.migrationPlans) || value.migrationPlans.length < 1) throw new Error("LEGACY_MIGRATION_PLANS_REQUIRED");
    const plans = value.migrationPlans.map((raw) => exactMigrationPlan(raw, inventory.entries));
    if (new Set(plans.map((plan) => `${plan.model}|${plan.recordId}|${plan.field}`)).size !== plans.length) {
      throw new Error("LEGACY_MIGRATION_PLAN_DUPLICATE");
    }
    pairLegacyTombstonePlans(plans);
    const approval = asRecord(value.executionApproval, "LEGACY_EXECUTION_APPROVAL_INVALID");
    assertExactKeys(
      approval,
      ["planDigestSha256", "providerBindingSha256", "sourceInventoryApprovalSha256"],
      "LEGACY_EXECUTION_APPROVAL_KEYS_INVALID"
    );
    const approvedPlan = asStrictString(approval.planDigestSha256, "LEGACY_PLAN_DIGEST_INVALID", /^[0-9a-f]{64}$/, 64);
    const providerBindingSha256 = asStrictString(
      approval.providerBindingSha256, "LEGACY_PROVIDER_BINDING_INVALID", /^[0-9a-f]{64}$/, 64
    );
    const sourceInventoryApprovalSha256 = asStrictString(
      approval.sourceInventoryApprovalSha256,
      "LEGACY_SOURCE_APPROVAL_SHA_INVALID",
      /^[0-9a-f]{64}$/,
      64
    );
    const computedPlan = legacyExecutionPlanSha256({ target, inventoryDigestSha256: inventory.inventoryDigestSha256, plans });
    if (computedPlan !== approvedPlan || args.confirmPlanSha256 !== approvedPlan) throw new Error("LEGACY_PLAN_CONFIRMATION_MISMATCH");
    if (args.confirmProviderBindingSha256 !== providerBindingSha256) throw new Error("LEGACY_PROVIDER_CONFIRMATION_MISMATCH");
    if (args.confirmSourceInventorySha256 !== sourceInventoryApprovalSha256) {
      throw new Error("LEGACY_SOURCE_APPROVAL_CONFIRMATION_MISMATCH");
    }
    const sourceApproval = parseLegacySourceInventoryApproval({
      value: rawSourceApproval,
      target,
      referenceInventoryDigestSha256: inventory.inventoryDigestSha256,
      executionPlanDigestSha256: computedPlan,
      confirmApprovalSha256: sourceInventoryApprovalSha256,
      now
    });
    const providerBinding = parseLegacyProviderBinding({
      value: rawProviderBinding,
      target,
      sourceApproval,
      referenceInventoryDigestSha256: inventory.inventoryDigestSha256,
      executionPlanDigestSha256: computedPlan,
      confirmProviderBindingSha256: providerBindingSha256,
      now
    });
    const approvedRoots = sourceApproval.roots.map((root) => root.rootPath).sort();
    const manifestRoots = (value.approvedLocalRoots as string[]).map((root) => path.resolve(root)).sort();
    if (canonicalSha256(approvedRoots) !== canonicalSha256(manifestRoots)) {
      throw new Error("LEGACY_SOURCE_ROOT_BINDING_MISMATCH");
    }
    let directContext: Awaited<ReturnType<typeof createDirectLegacyContext>> | undefined;
    try {
      if (!input.providerFactory) {
        directContext = await createDirectLegacyContext({
          target,
          sourceApproval,
          providerBinding,
          env: input.env,
          factories: input.directFactories,
          now
        });
      }
      let adapter: LegacyManifestApplyAdapter;
      if (input.providerFactory) {
        const candidate = await input.providerFactory({
          target,
          providerBindingSha256,
          plan: plans[0],
          env: input.env,
          sourceApproval,
          providerBinding
        });
        if (typeof candidate.compareAndSwapManifest !== "function") {
          throw new Error("LEGACY_MANIFEST_ADAPTER_REQUIRED");
        }
        adapter = {
          inspectTarget: candidate.inspectTarget,
          copyNoOverwrite: candidate.copyNoOverwrite,
          compareAndSwapManifest: (approvedPlans) => candidate.compareAndSwapManifest!(approvedPlans)
        };
      } else {
        adapter = directContext!.manifestAdapter;
      }
      const result = await applyLegacyMigrationManifest(plans, adapter);
      if (result.result !== "PASS") throw new Error("LEGACY_MIGRATION_NOT_COMPLETE");
    } finally {
      await directContext?.close();
    }
    const evidence = {
      event: "legacy-migration-apply", environmentId: target.environmentId, projectRef: target.projectRef,
      releaseGitSha: target.releaseGitSha, targetSha256: targetBindingSha256(target),
      inventoryDigestSha256: inventory.inventoryDigestSha256, executionPlanDigestSha256: computedPlan,
      migratedCount: plans.length, sourcePreserved: true, result: "PASS" as const
    };
    assertNoSensitiveEvidence(evidence);
    return `${canonicalJson(evidence)}\n`;
  }
  const evidence = {
    ...legacyInventoryPublicEvidence(inventory),
    environmentId: target.environmentId,
    projectRef: target.projectRef,
    releaseGitSha: target.releaseGitSha,
    targetSha256: targetBindingSha256(target)
  };
  assertNoSensitiveEvidence(evidence);
  return `${canonicalJson(evidence)}\n`;
}

export function legacyExecutionPlanSha256(input: {
  target: CloudTargetBinding;
  inventoryDigestSha256: string;
  plans: LegacyMigrationPlan[];
}) {
  return canonicalSha256({
    targetSha256: targetBindingSha256(input.target), inventoryDigestSha256: input.inventoryDigestSha256,
    migrationPlanDigests: input.plans.map((plan) => plan.planDigestSha256).sort()
  });
}

function strictArgs(argv: string[]) {
  let manifest = "";
  let execute = false;
  let confirmPlanSha256 = "";
  let confirmProviderBindingSha256 = "";
  let sourceInventory = "";
  let providerBinding = "";
  let confirmSourceInventorySha256 = "";
  for (const arg of argv) {
    if (arg.startsWith("--manifest=")) manifest = arg.slice("--manifest=".length);
    else if (arg === "--execute") execute = true;
    else if (arg.startsWith("--confirm-plan-sha256=")) confirmPlanSha256 = arg.slice("--confirm-plan-sha256=".length);
    else if (arg.startsWith("--confirm-provider-binding-sha256=")) {
      confirmProviderBindingSha256 = arg.slice("--confirm-provider-binding-sha256=".length);
    }
    else if (arg.startsWith("--source-inventory=")) sourceInventory = arg.slice("--source-inventory=".length);
    else if (arg.startsWith("--provider-binding=")) providerBinding = arg.slice("--provider-binding=".length);
    else if (arg.startsWith("--confirm-source-inventory-sha256=")) {
      confirmSourceInventorySha256 = arg.slice("--confirm-source-inventory-sha256=".length);
    }
    else throw new Error("LEGACY_CLI_ARGUMENT_INVALID");
  }
  if (!manifest) throw new Error("LEGACY_CLI_MANIFEST_REQUIRED");
  if (execute && (!sourceInventory || !providerBinding || !/^[0-9a-f]{64}$/.test(confirmPlanSha256) ||
    !/^[0-9a-f]{64}$/.test(confirmProviderBindingSha256) ||
    !/^[0-9a-f]{64}$/.test(confirmSourceInventorySha256))) {
    throw new Error("LEGACY_CLI_CONFIRMATION_REQUIRED");
  }
  if (!execute && (sourceInventory || providerBinding || confirmPlanSha256 ||
    confirmProviderBindingSha256 || confirmSourceInventorySha256)) {
    throw new Error("LEGACY_CLI_CONFIRMATION_WITHOUT_EXECUTE");
  }
  return {
    manifest,
    execute,
    sourceInventory,
    providerBinding,
    confirmPlanSha256,
    confirmProviderBindingSha256,
    confirmSourceInventorySha256
  };
}

function exactMigrationPlan(value: unknown, entries: ReturnType<typeof inventoryStorageReferences>["entries"]): LegacyMigrationPlan {
  const raw = asRecord(value, "LEGACY_MIGRATION_PLAN_INVALID");
  const keys = [
    "contractVersion", "model", "recordId", "field", "expectedOldValue", "expectedOldStatus", "sourceRoot", "sourceKey",
    "sourceHashSha256", "sourceByteSize", "targetProvider", "targetKey", "targetReference", "planDigestSha256"
  ];
  if ("expectedOldProvider" in raw) keys.push("expectedOldProvider");
  assertExactKeys(raw, keys, "LEGACY_MIGRATION_PLAN_KEYS_INVALID");
  const entry = entries.find((candidate) => candidate.model === raw.model && candidate.recordId === raw.recordId && candidate.field === raw.field);
  if (!entry) throw new Error("LEGACY_MIGRATION_PLAN_NOT_IN_INVENTORY");
  const expected = createLegacyMigrationPlan(entry, {
    hashSha256: asStrictString(raw.sourceHashSha256, "LEGACY_MIGRATION_SOURCE_HASH_INVALID", /^[0-9a-f]{64}$/, 64),
    byteSize: asSafeInteger(raw.sourceByteSize, "LEGACY_MIGRATION_SOURCE_SIZE_INVALID")
  });
  if (canonicalJson(expected) !== canonicalJson(raw)) throw new Error("LEGACY_MIGRATION_PLAN_MISMATCH");
  return expected;
}

if (require.main === module) {
  void runLegacyCli({ argv: process.argv.slice(2), env: process.env })
    .then((output) => process.stdout.write(output))
    .catch((error: unknown) => {
      const code = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : "LEGACY_CLI_FAILED";
      process.stderr.write(`${JSON.stringify({ event: "legacy-reference-inventory", result: "FAIL", code })}\n`);
      process.exitCode = 1;
    });
}
