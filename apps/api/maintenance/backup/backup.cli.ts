import {
  asRecord, assertExactKeys, asStrictString, canonicalJson, canonicalSha256, readProtectedJsonFile
} from "../shared/strict-json";
import { assertNoSensitiveEvidence, createRedactedEvidence, serializeRedactedEvidence } from "../shared/redacted-evidence";
import { assertTargetConfirmation, CloudTargetBinding, parseCloudTargetBinding, targetBindingSha256 } from "../shared/target-binding";
import { BackupCutAdapter, BackupCutManifest, BackupDestination, runConsistentBackupCut } from "./cut-manifest";
import { createCloudflareR2BackupAdapter, DirectBackupDependencies } from "./direct-provider";

export type BackupDirectProviderFactory = (input: {
  target: CloudTargetBinding;
  cutId: string;
  bucket: string;
  destination: BackupDestination;
  planDigestSha256: string;
  providerBinding: unknown;
  confirmProviderBindingSha256: string;
  encryptionKeyArtifact: unknown;
  confirmEncryptionKeySha256: string;
  writeBlockReceipt: unknown;
  confirmWriteBlockReceiptSha256: string;
  writeBlockPublicKeyPem: string;
  confirmWriteBlockPublicKeySha256: string;
  env: NodeJS.ProcessEnv;
  dependencies?: DirectBackupDependencies;
}) => Promise<{ adapter: BackupCutAdapter; persistManifest(manifest: BackupCutManifest): void }>;

export async function runBackupCli(input: {
  argv: string[];
  env: NodeJS.ProcessEnv;
  providerFactory?: BackupDirectProviderFactory;
  directDependencies?: DirectBackupDependencies;
}): Promise<string> {
  const args = strictArgs(input.argv);
  rejectGenericCredentials(input.env);
  const value = asRecord(await readProtectedJsonFile(args.manifest), "BACKUP_PLAN_INVALID");
  assertExactKeys(value, args.execute
    ? ["target", "confirmation", "bucket", "destination", "cutId"]
    : ["target", "confirmation", "bucket"], "BACKUP_PLAN_KEYS_INVALID");
  const target = parseCloudTargetBinding(value.target);
  assertTargetConfirmation(target, value.confirmation as never);
  if (typeof value.bucket !== "string" || !/^[a-z0-9][a-z0-9._-]{0,62}$/.test(value.bucket)) {
    throw new Error("BACKUP_BUCKET_INVALID");
  }
  if (!args.execute) return serializeRedactedEvidence(createRedactedEvidence({
    kind: "backup.plan", target, result: "NOT_RUN", counts: {}, codes: ["ADAPTER_NOT_INVOKED"]
  }));

  const destination = value.destination as BackupDestination;
  const cutId = asStrictString(value.cutId, "BACKUP_CUT_ID_INVALID", /^[0-9a-f-]{36}$/i, 36);
  const planDigestSha256 = backupExecutionPlanSha256({ target, bucket: value.bucket, destination, cutId });
  if (args.confirmPlanSha256 !== planDigestSha256) throw new Error("BACKUP_PLAN_CONFIRMATION_MISMATCH");
  const [providerBinding, encryptionKeyArtifact, writeBlockReceipt, publicKeyArtifactValue] = await Promise.all([
    readProtectedJsonFile(args.providerBinding),
    readProtectedJsonFile(args.encryptionKey),
    readProtectedJsonFile(args.writeBlockReceipt),
    readProtectedJsonFile(args.writeBlockPublicKey)
  ]);
  const publicKeyArtifact = asRecord(publicKeyArtifactValue, "BACKUP_WRITE_BLOCK_PUBLIC_KEY_ARTIFACT_INVALID");
  assertExactKeys(publicKeyArtifact, ["version", "publicKeyPem", "publicKeySha256"], "BACKUP_WRITE_BLOCK_PUBLIC_KEY_ARTIFACT_FIELDS_INVALID");
  if (publicKeyArtifact.version !== "backup-write-block-public-key/v1" ||
      publicKeyArtifact.publicKeySha256 !== args.confirmWriteBlockPublicKeySha256) {
    throw new Error("BACKUP_WRITE_BLOCK_PUBLIC_KEY_CONFIRMATION_MISMATCH");
  }
  const factory = input.providerFactory ?? defaultProviderFactory;
  const composition = await factory({
    target,
    cutId,
    bucket: value.bucket,
    destination,
    planDigestSha256,
    providerBinding,
    confirmProviderBindingSha256: args.confirmProviderBindingSha256,
    encryptionKeyArtifact,
    confirmEncryptionKeySha256: args.confirmEncryptionKeySha256,
    writeBlockReceipt,
    confirmWriteBlockReceiptSha256: args.confirmWriteBlockReceiptSha256,
    writeBlockPublicKeyPem: asStrictString(publicKeyArtifact.publicKeyPem, "BACKUP_WRITE_BLOCK_PUBLIC_KEY_INVALID", undefined, 32 * 1024),
    confirmWriteBlockPublicKeySha256: args.confirmWriteBlockPublicKeySha256,
    env: input.env,
    dependencies: input.directDependencies
  });
  const result = await runConsistentBackupCut({ target, bucket: value.bucket, destination, cutId, adapter: composition.adapter });
  if (result.result !== "PASS") throw new Error(result.code);
  composition.persistManifest(result.manifest);
  const evidence = {
    ...createRedactedEvidence({
      kind: "backup.apply", target, result: "PASS", counts: result.evidence.counts,
      codes: [...result.evidence.codes, "RETENTION_30_DAYS_NOT_APPROVED", "WRITE_RELEASE_EXTERNAL_NOT_RUN"]
    }),
    manifestDigestSha256: result.manifest.manifestDigestSha256,
    retentionDays: 30,
    retentionApproval: "NOT_APPROVED",
    releaseResult: "NOT_RUN"
  };
  assertNoSensitiveEvidence(evidence);
  return `${canonicalJson(evidence)}\n`;
}

export function backupExecutionPlanSha256(input: {
  target: CloudTargetBinding;
  bucket: unknown;
  destination: BackupDestination;
  cutId: string;
}) {
  return canonicalSha256({
    targetSha256: targetBindingSha256(input.target), bucket: input.bucket, destination: input.destination, cutId: input.cutId
  });
}

async function defaultProviderFactory(input: Parameters<BackupDirectProviderFactory>[0]) {
  return createCloudflareR2BackupAdapter({
    target: input.target,
    cutId: input.cutId,
    bucket: input.bucket,
    destination: input.destination,
    planDigestSha256: input.planDigestSha256,
    providerBinding: input.providerBinding,
    confirmProviderBindingSha256: input.confirmProviderBindingSha256,
    encryptionKeyArtifact: input.encryptionKeyArtifact,
    confirmEncryptionKeySha256: input.confirmEncryptionKeySha256,
    writeBlockReceipt: input.writeBlockReceipt,
    confirmWriteBlockReceiptSha256: input.confirmWriteBlockReceiptSha256,
    writeBlockPublicKeyPem: input.writeBlockPublicKeyPem,
    confirmWriteBlockPublicKeySha256: input.confirmWriteBlockPublicKeySha256,
    databaseUrl: requiredEnvironment(input.env, "BACKUP_DATABASE_URL", 4_096),
    pgDumpExecutable: requiredEnvironment(input.env, "BACKUP_PG_DUMP_EXECUTABLE", 1_024),
    outputRoot: requiredEnvironment(input.env, "BACKUP_OUTPUT_ROOT", 1_024),
    sourceToken: requiredEnvironment(input.env, "BACKUP_SUPABASE_STORAGE_READ_TOKEN", 16_384),
    r2AccessKeyId: requiredEnvironment(input.env, "BACKUP_R2_ACCESS_KEY_ID", 1_024),
    r2SecretAccessKey: requiredEnvironment(input.env, "BACKUP_R2_SECRET_ACCESS_KEY", 16_384),
    dependencies: input.dependencies
  });
}

function strictArgs(argv: string[]) {
  const values: Record<string, string> = {};
  let execute = false;
  for (const arg of argv) {
    if (arg === "--execute") execute = true;
    else {
      const match = arg.match(/^--([a-z0-9-]+)=(.+)$/);
      if (!match || Object.prototype.hasOwnProperty.call(values, match[1])) throw new Error("BACKUP_CLI_ARGUMENT_INVALID");
      values[match[1]] = match[2];
    }
  }
  const manifest = values.manifest ?? "";
  if (!manifest) throw new Error("BACKUP_CLI_MANIFEST_REQUIRED");
  const executeKeys = [
    "provider-binding", "encryption-key", "write-block-receipt", "write-block-public-key", "confirm-plan-sha256",
    "confirm-provider-binding-sha256", "confirm-encryption-key-sha256", "confirm-write-block-receipt-sha256",
    "confirm-write-block-public-key-sha256"
  ];
  const allowed = new Set(["manifest", ...(execute ? executeKeys : [])]);
  if (Object.keys(values).some((key) => !allowed.has(key))) throw new Error("BACKUP_CLI_ARGUMENT_INVALID");
  if (execute && executeKeys.some((key) => !values[key])) throw new Error("BACKUP_CLI_CONFIRMATION_REQUIRED");
  if (!execute && Object.keys(values).length !== 1) throw new Error("BACKUP_CLI_CONFIRMATION_WITHOUT_EXECUTE");
  for (const key of executeKeys.filter((key) => key.startsWith("confirm-"))) {
    if (execute && !/^[0-9a-f]{64}$/.test(values[key])) throw new Error("BACKUP_CLI_CONFIRMATION_REQUIRED");
  }
  return {
    manifest,
    execute,
    providerBinding: values["provider-binding"] ?? "",
    encryptionKey: values["encryption-key"] ?? "",
    writeBlockReceipt: values["write-block-receipt"] ?? "",
    writeBlockPublicKey: values["write-block-public-key"] ?? "",
    confirmPlanSha256: values["confirm-plan-sha256"] ?? "",
    confirmProviderBindingSha256: values["confirm-provider-binding-sha256"] ?? "",
    confirmEncryptionKeySha256: values["confirm-encryption-key-sha256"] ?? "",
    confirmWriteBlockReceiptSha256: values["confirm-write-block-receipt-sha256"] ?? "",
    confirmWriteBlockPublicKeySha256: values["confirm-write-block-public-key-sha256"] ?? ""
  };
}

function requiredEnvironment(env: NodeJS.ProcessEnv, name: string, maximum: number) {
  const value = env[name];
  if (typeof value !== "string" || !value || value.length > maximum || value !== value.trim()) throw new Error(`${name}_REQUIRED`);
  return value;
}

function rejectGenericCredentials(env: NodeJS.ProcessEnv) {
  for (const name of ["SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ACCESS_TOKEN", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]) {
    if (Object.prototype.hasOwnProperty.call(env, name)) throw new Error("BACKUP_GENERIC_CREDENTIAL_ENV_REJECTED");
  }
}

if (require.main === module) {
  void runBackupCli({ argv: process.argv.slice(2), env: process.env })
    .then((output) => process.stdout.write(output))
    .catch((error: unknown) => {
      const code = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : "BACKUP_CLI_FAILED";
      process.stderr.write(`${JSON.stringify({ event: "backup-plan", result: "FAIL", code })}\n`);
      process.exitCode = 1;
    });
}
