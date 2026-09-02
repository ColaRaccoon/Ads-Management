import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PURPOSES = Object.freeze(["auth", "migration", "storage", "backup", "legacy"]);
const INPUT_ROOT = "/run/maintenance-input";
const MIGRATION_OUTPUT_ROOT = "/run/maintenance-output/migration";
const MIGRATION_JOURNAL_NAME = "migration-journal.jsonl";
const BACKUP_OUTPUT_ROOT = "/run/maintenance-output/backup";
const BACKUP_PG_DUMP_EXECUTABLE = "/usr/bin/pg_dump";
const LEGACY_SOURCE_ROOT = "/run/legacy-source";
const LEGACY_OUTPUT_ROOT = "/run/maintenance-output/legacy";
const LEGACY_APPROVAL_MAX_BYTES = 1024 * 1024;
const MOUNT_INFO_FILE = "/proc/self/mountinfo";

const CREDENTIAL_MAP = Object.freeze({
  auth: Object.freeze({
    AUTH_DATABASE_URL: "DATABASE_URL",
    AUTH_SUPABASE_URL: "SUPABASE_URL",
    AUTH_SUPABASE_SECRET_KEY: "SUPABASE_SECRET_KEY"
  }),
  migration: Object.freeze({ MIGRATION_DATABASE_URL: "DATABASE_URL" }),
  storage: Object.freeze({
    STORAGE_SUPABASE_URL: "SUPABASE_URL",
    STORAGE_SUPABASE_FINE_GRAINED_TOKEN: "SUPABASE_FINE_GRAINED_TOKEN"
  }),
  backup: Object.freeze({
    BACKUP_DATABASE_URL: "BACKUP_DATABASE_URL",
    BACKUP_SUPABASE_STORAGE_READ_TOKEN: "BACKUP_SUPABASE_STORAGE_READ_TOKEN",
    BACKUP_R2_ACCESS_KEY_ID: "BACKUP_R2_ACCESS_KEY_ID",
    BACKUP_R2_SECRET_ACCESS_KEY: "BACKUP_R2_SECRET_ACCESS_KEY"
  }),
  legacy: Object.freeze({
    LEGACY_DATABASE_URL: "DATABASE_URL",
    LEGACY_STORAGE_ACCESS_TOKEN: "STORAGE_ACCESS_TOKEN"
  })
});

const NON_SECRET_PASSTHROUGH = new Set(["LANG", "LC_ALL", "TZ", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS"]);
const NON_CREDENTIAL_INPUT_KEYS = new Set([
  "AUTH_MANIFEST_FILE", "AUTH_MODE", "AUTH_ACTION", "AUTH_CONFIRM_PLAN", "AUTH_CONFIRM_PROJECT_REF",
  "AUTH_CONFIRM_RELEASE", "AUTH_CONFIRM_TARGET", "AUTH_MANIFEST_BINDING_KEY_FILE",
  "AUTH_CONFIRM_MANIFEST_HMAC", "AUTH_CONFIRM_BINDING_KEY_ID", "MIGRATION_MANIFEST_FILE", "STORAGE_MANIFEST_FILE",
  "MIGRATION_TARGET_FILE", "MIGRATION_RELEASE_FILE", "MIGRATION_MODE", "MIGRATION_CONFIRM_PLAN",
  "MIGRATION_CONFIRM_RELEASE_ID", "MIGRATION_CONFIRM_PROJECT_REF", "MIGRATION_CONFIRM_RELEASE_SHA",
  "MIGRATION_CONFIRM_TARGET",
  "STORAGE_MODE", "STORAGE_TOKEN_FILE", "STORAGE_JWKS_FILE", "STORAGE_EXPECTED_FILE", "BACKUP_MANIFEST_FILE",
  "STORAGE_CREDENTIAL_APPROVAL_FILE", "STORAGE_CONFIRM_PLAN_SHA256", "STORAGE_CONFIRM_BEFORE_SHA256",
  "STORAGE_CONFIRM_APPROVAL_SHA256", "STORAGE_CONFIRM_BUNDLE_SHA256",
  "BACKUP_MODE", "BACKUP_PG_DUMP_EXECUTABLE", "BACKUP_OUTPUT_ROOT", "BACKUP_PROVIDER_BINDING_FILE",
  "BACKUP_ENCRYPTION_KEY_FILE", "BACKUP_WRITE_BLOCK_RECEIPT_FILE", "BACKUP_WRITE_BLOCK_PUBLIC_KEY_FILE",
  "BACKUP_CONFIRM_PLAN_SHA256", "BACKUP_CONFIRM_PROVIDER_BINDING_SHA256", "BACKUP_CONFIRM_ENCRYPTION_KEY_SHA256",
  "BACKUP_CONFIRM_WRITE_BLOCK_RECEIPT_SHA256", "BACKUP_CONFIRM_WRITE_BLOCK_PUBLIC_KEY_SHA256",
  "LEGACY_MANIFEST_FILE", "LEGACY_SOURCE_INVENTORY_FILE", "LEGACY_PROVIDER_BINDING_FILE", "LEGACY_MODE",
  "LEGACY_CONFIRM_PLAN_SHA256", "LEGACY_CONFIRM_PROVIDER_BINDING_SHA256", "LEGACY_CONFIRM_SOURCE_INVENTORY_SHA256"
]);
const SENSITIVE_NAME = /(?:SECRET|TOKEN|PASSWORD|PASSWD|DATABASE_URL|PRIVATE_KEY|SERVICE_ROLE|ACCESS_KEY|CREDENTIAL|(?:^|_)KEY(?:_|$)|(?:^|_)URL(?:_|$))/iu;

export async function buildMaintenanceInvocation({
  root = "/srv/maintenance",
  inputRoot = INPUT_ROOT,
  migrationOutputRoot = MIGRATION_OUTPUT_ROOT,
  backupOutputRoot = BACKUP_OUTPUT_ROOT,
  legacySourceRoot = LEGACY_SOURCE_ROOT,
  legacyOutputRoot = LEGACY_OUTPUT_ROOT,
  purpose,
  command,
  env = process.env,
  readFileImpl = readFile,
  readMountInfoImpl = readFile,
  lstatImpl = lstat,
  realpathImpl = realpath,
  openImpl = open
}) {
  assertPurpose(purpose);
  const marker = (await readFileImpl(path.join(root, "purpose"), "utf8")).trim();
  if (marker !== purpose) fail("MAINTENANCE_PURPOSE_MARKER_MISMATCH");
  rejectOutputOverrides(env);
  rejectCredentialBleed(env, purpose);

  const childEnv = Object.create(null);
  childEnv.NODE_ENV = "production";
  for (const key of NON_SECRET_PASSTHROUGH) {
    if (typeof env[key] === "string" && env[key].length > 0) childEnv[key] = env[key];
  }
  for (const [source, target] of Object.entries(CREDENTIAL_MAP[purpose])) {
    if (typeof env[source] === "string" && env[source].length > 0) childEnv[target] = env[source];
  }

  const invocation = await buildPurposeCommand({
    root,
    inputRoot,
    migrationOutputRoot,
    backupOutputRoot,
    legacySourceRoot,
    legacyOutputRoot,
    purpose,
    command,
    env,
    childEnv,
    readMountInfoImpl,
    lstatImpl,
    realpathImpl,
    openImpl
  });
  return Object.freeze({
    purpose,
    command,
    executable: process.execPath,
    script: path.join(root, ...invocation.script.split("/")),
    args: Object.freeze(invocation.args),
    env: Object.freeze(childEnv)
  });
}

export async function runMaintenanceEntrypoint({
  root = "/srv/maintenance",
  inputRoot = INPUT_ROOT,
  migrationOutputRoot = MIGRATION_OUTPUT_ROOT,
  backupOutputRoot = BACKUP_OUTPUT_ROOT,
  legacySourceRoot = LEGACY_SOURCE_ROOT,
  legacyOutputRoot = LEGACY_OUTPUT_ROOT,
  purpose = process.env.MAINTENANCE_PURPOSE,
  argv = process.argv.slice(2),
  env = process.env,
  readFileImpl = readFile,
  readMountInfoImpl = readFile,
  lstatImpl = lstat,
  realpathImpl = realpath,
  openImpl = open,
  spawnProcess = spawn
} = {}) {
  if (argv.length !== 1 || typeof argv[0] !== "string") fail("MAINTENANCE_COMMAND_INVALID");
  const invocation = await buildMaintenanceInvocation({
    root,
    inputRoot,
    migrationOutputRoot,
    backupOutputRoot,
    legacySourceRoot,
    legacyOutputRoot,
    purpose,
    command: argv[0],
    env,
    readFileImpl,
    readMountInfoImpl,
    lstatImpl,
    realpathImpl,
    openImpl
  });
  const child = spawnProcess(invocation.executable, [invocation.script, ...invocation.args], {
    cwd: root,
    env: invocation.env,
    stdio: "inherit",
    windowsHide: true
  });
  return await waitForExit(child);
}

async function buildPurposeCommand({
  root,
  inputRoot,
  migrationOutputRoot,
  backupOutputRoot,
  legacySourceRoot,
  legacyOutputRoot,
  purpose,
  command,
  env,
  childEnv,
  readMountInfoImpl,
  lstatImpl,
  realpathImpl,
  openImpl
}) {
  if (purpose === "auth" && command === "user-disposition") {
    const mode = parseMode(env.AUTH_MODE);
    const manifest = protectedPath(env.AUTH_MANIFEST_FILE, inputRoot, "auth-disposition.json");
    const manifestBindingKeyFile = requiredProtectedPath(
      env.AUTH_MANIFEST_BINDING_KEY_FILE,
      inputRoot,
      "AUTH_MANIFEST_BINDING_KEY_FILE_REQUIRED"
    );
    requireCredentials(childEnv, ["DATABASE_URL", "SUPABASE_URL", "SUPABASE_SECRET_KEY"]);
    const args = [
      "--manifest", manifest,
      "--manifest-binding-key-file", manifestBindingKeyFile
    ];
    if (mode === "APPLY") {
      args.push("--apply",
        "--action", assertEnum(env.AUTH_ACTION, ["KEEP", "BOOTSTRAP_SUPER_ADMIN", "LINK", "RE_INVITE", "DISABLE"], "AUTH_ACTION_REQUIRED"),
        "--confirm-plan", assertOpaque(env.AUTH_CONFIRM_PLAN, "AUTH_CONFIRM_PLAN_REQUIRED"),
        "--confirm-project-ref", assertProjectRef(env.AUTH_CONFIRM_PROJECT_REF),
        "--confirm-release", assertRelease(env.AUTH_CONFIRM_RELEASE),
        "--confirm-target", assertHex(env.AUTH_CONFIRM_TARGET, "AUTH_CONFIRM_TARGET_REQUIRED"),
        "--confirm-manifest-hmac", assertHex(env.AUTH_CONFIRM_MANIFEST_HMAC, "AUTH_CONFIRM_MANIFEST_HMAC_REQUIRED"),
        "--confirm-binding-key-id", assertOpaque(env.AUTH_CONFIRM_BINDING_KEY_ID, "AUTH_CONFIRM_BINDING_KEY_ID_REQUIRED"));
    }
    return { script: "dist/auth/user-disposition.cli.js", args };
  }
  if (purpose === "migration" && command === "migrate-deploy") {
    requireCredentials(childEnv, ["DATABASE_URL"]);
    const mode = env.MIGRATION_MODE || "INSPECT";
    if (mode !== "INSPECT" && mode !== "PLAN_CHILD" && mode !== "EXECUTE") fail("MAINTENANCE_MODE_INVALID");
    const args = [
      "--target", protectedPath(env.MIGRATION_TARGET_FILE, inputRoot, "migration-target.json"),
      "--release", protectedPath(env.MIGRATION_RELEASE_FILE, inputRoot, "migration-release.json")
    ];
    if (mode === "PLAN_CHILD" || mode === "EXECUTE") {
      args.push(mode === "EXECUTE" ? "--execute" : "--plan-child",
        "--confirm-plan", assertHex(env.MIGRATION_CONFIRM_PLAN, "MIGRATION_CONFIRM_PLAN_REQUIRED"),
        "--confirm-release-id", assertHex(env.MIGRATION_CONFIRM_RELEASE_ID, "MIGRATION_CONFIRM_RELEASE_ID_REQUIRED"),
        "--confirm-project-ref", assertProjectRefWithCode(env.MIGRATION_CONFIRM_PROJECT_REF, "MIGRATION_CONFIRM_PROJECT_REF_REQUIRED"),
        "--confirm-release-sha", assertReleaseWithCode(env.MIGRATION_CONFIRM_RELEASE_SHA, "MIGRATION_CONFIRM_RELEASE_SHA_REQUIRED"),
        "--confirm-target", assertHex(env.MIGRATION_CONFIRM_TARGET, "MIGRATION_CONFIRM_TARGET_REQUIRED"));
      if (mode === "EXECUTE") {
        childEnv.MIGRATION_JOURNAL_FILE = await protectedMigrationJournalPath({
          outputRoot: migrationOutputRoot,
          lstatImpl,
          realpathImpl
        });
      }
    }
    return {
      script: "dist/migration/migration.cli.js",
      args
    };
  }
  if (purpose === "storage" && command === "policy") {
    const mode = parseMode(env.STORAGE_MODE);
    const args = [`--manifest=${protectedPath(env.STORAGE_MANIFEST_FILE, inputRoot, "storage-policy.json")}`];
    if (mode === "APPLY") {
      requireCredentials(childEnv, ["SUPABASE_URL", "SUPABASE_FINE_GRAINED_TOKEN"]);
      args.push(
        `--credential-approval=${protectedPath(
          env.STORAGE_CREDENTIAL_APPROVAL_FILE,
          inputRoot,
          "storage-credential-approval.json"
        )}`,
        "--execute",
        `--confirm-plan-sha256=${assertHex(env.STORAGE_CONFIRM_PLAN_SHA256, "STORAGE_CONFIRM_PLAN_SHA256_REQUIRED")}`,
        `--confirm-before-sha256=${assertHex(env.STORAGE_CONFIRM_BEFORE_SHA256, "STORAGE_CONFIRM_BEFORE_SHA256_REQUIRED")}`,
        `--confirm-approval-sha256=${assertHex(
          env.STORAGE_CONFIRM_APPROVAL_SHA256,
          "STORAGE_CONFIRM_APPROVAL_SHA256_REQUIRED"
        )}`
      );
    }
    return { script: "dist/storage/policy.cli.js", args };
  }
  if (purpose === "storage" && command === "token-artifact") {
    const confirmBundleSha256 = assertHex(
      env.STORAGE_CONFIRM_BUNDLE_SHA256,
      "STORAGE_CONFIRM_BUNDLE_SHA256_REQUIRED"
    );
    return {
      script: "dist/storage/token-artifact.cli.js",
      args: [
        `--token-file=${protectedPath(env.STORAGE_TOKEN_FILE, inputRoot, "storage.token")}`,
        `--jwks-file=${protectedPath(env.STORAGE_JWKS_FILE, inputRoot, "storage.jwks.json")}`,
        `--expected-file=${protectedPath(env.STORAGE_EXPECTED_FILE, inputRoot, "storage-token-expected.json")}`,
        `--confirm-bundle-sha256=${confirmBundleSha256}`
      ]
    };
  }
  if (purpose === "backup" && command === "backup") {
    const mode = parseMode(env.BACKUP_MODE);
    const args = [`--manifest=${protectedPath(env.BACKUP_MANIFEST_FILE, inputRoot, "backup.json")}`];
    if (mode === "APPLY") {
      requireCredentials(childEnv, [
        "BACKUP_DATABASE_URL",
        "BACKUP_SUPABASE_STORAGE_READ_TOKEN",
        "BACKUP_R2_ACCESS_KEY_ID",
        "BACKUP_R2_SECRET_ACCESS_KEY"
      ]);
      if (env.BACKUP_PG_DUMP_EXECUTABLE !== BACKUP_PG_DUMP_EXECUTABLE) {
        fail("BACKUP_PG_DUMP_EXECUTABLE_INVALID");
      }
      if (path.resolve(env.BACKUP_OUTPUT_ROOT || "") !== path.resolve(backupOutputRoot) ||
          env.BACKUP_OUTPUT_ROOT !== backupOutputRoot) {
        fail("BACKUP_OUTPUT_ROOT_INVALID");
      }
      await assertDedicatedOutputRoot({ outputRoot: backupOutputRoot, purpose: "backup", lstatImpl, realpathImpl });
      childEnv.BACKUP_PG_DUMP_EXECUTABLE = BACKUP_PG_DUMP_EXECUTABLE;
      childEnv.BACKUP_OUTPUT_ROOT = backupOutputRoot;
      args.push(
        `--provider-binding=${protectedPath(env.BACKUP_PROVIDER_BINDING_FILE, inputRoot, "backup-provider-binding.json")}`,
        `--encryption-key=${protectedPath(env.BACKUP_ENCRYPTION_KEY_FILE, inputRoot, "backup-encryption-key.json")}`,
        `--write-block-receipt=${protectedPath(
          env.BACKUP_WRITE_BLOCK_RECEIPT_FILE,
          inputRoot,
          "backup-write-block-receipt.json"
        )}`,
        `--write-block-public-key=${protectedPath(
          env.BACKUP_WRITE_BLOCK_PUBLIC_KEY_FILE,
          inputRoot,
          "backup-write-block-public-key.json"
        )}`,
        "--execute",
        `--confirm-plan-sha256=${assertHex(env.BACKUP_CONFIRM_PLAN_SHA256, "BACKUP_CONFIRM_PLAN_SHA256_REQUIRED")}`,
        `--confirm-provider-binding-sha256=${assertHex(
          env.BACKUP_CONFIRM_PROVIDER_BINDING_SHA256,
          "BACKUP_CONFIRM_PROVIDER_BINDING_SHA256_REQUIRED"
        )}`,
        `--confirm-encryption-key-sha256=${assertHex(
          env.BACKUP_CONFIRM_ENCRYPTION_KEY_SHA256,
          "BACKUP_CONFIRM_ENCRYPTION_KEY_SHA256_REQUIRED"
        )}`,
        `--confirm-write-block-receipt-sha256=${assertHex(
          env.BACKUP_CONFIRM_WRITE_BLOCK_RECEIPT_SHA256,
          "BACKUP_CONFIRM_WRITE_BLOCK_RECEIPT_SHA256_REQUIRED"
        )}`,
        `--confirm-write-block-public-key-sha256=${assertHex(
          env.BACKUP_CONFIRM_WRITE_BLOCK_PUBLIC_KEY_SHA256,
          "BACKUP_CONFIRM_WRITE_BLOCK_PUBLIC_KEY_SHA256_REQUIRED"
        )}`
      );
    }
    return { script: "dist/backup/backup.cli.js", args };
  }
  if (purpose === "legacy" && command === "inventory") {
    const mode = parseMode(env.LEGACY_MODE);
    const args = [`--manifest=${protectedPath(env.LEGACY_MANIFEST_FILE, inputRoot, "legacy-inventory.json")}`];
    if (mode === "APPLY") {
      requireCredentials(childEnv, ["DATABASE_URL", "STORAGE_ACCESS_TOKEN"]);
      const sourceInventory = protectedPath(
        env.LEGACY_SOURCE_INVENTORY_FILE,
        inputRoot,
        "legacy-source-inventory-approval.json"
      );
      const providerBinding = protectedPath(
        env.LEGACY_PROVIDER_BINDING_FILE,
        inputRoot,
        "legacy-provider-binding.json"
      );
      const confirmPlanSha256 = assertHex(env.LEGACY_CONFIRM_PLAN_SHA256, "LEGACY_CONFIRM_PLAN_SHA256_REQUIRED");
      const confirmProviderBindingSha256 = assertHex(
        env.LEGACY_CONFIRM_PROVIDER_BINDING_SHA256,
        "LEGACY_CONFIRM_PROVIDER_BINDING_SHA256_REQUIRED"
      );
      const confirmSourceInventorySha256 = assertHex(
        env.LEGACY_CONFIRM_SOURCE_INVENTORY_SHA256,
        "LEGACY_CONFIRM_SOURCE_INVENTORY_SHA256_REQUIRED"
      );
      const verifiedSourceInventory = await createVerifiedLegacyApprovalSnapshot({
        approvalFile: sourceInventory,
        sourceRoot: legacySourceRoot,
        outputRoot: legacyOutputRoot,
        expectedApprovalSha256: confirmSourceInventorySha256,
        readMountInfoImpl,
        lstatImpl,
        realpathImpl,
        openImpl
      });
      args.push(
        `--source-inventory=${verifiedSourceInventory}`,
        `--provider-binding=${providerBinding}`,
        "--execute",
        `--confirm-plan-sha256=${confirmPlanSha256}`,
        `--confirm-provider-binding-sha256=${confirmProviderBindingSha256}`,
        `--confirm-source-inventory-sha256=${confirmSourceInventorySha256}`
      );
    }
    return { script: "dist/legacy/legacy.cli.js", args };
  }
  fail("MAINTENANCE_COMMAND_NOT_ALLOWED");
}

async function createVerifiedLegacyApprovalSnapshot({
  approvalFile,
  sourceRoot,
  outputRoot,
  expectedApprovalSha256,
  readMountInfoImpl,
  lstatImpl,
  realpathImpl,
  openImpl
}) {
  const root = await assertDedicatedOutputRoot({
    outputRoot,
    purpose: "legacy",
    lstatImpl,
    realpathImpl,
    requiredMode: 0o700
  });
  const { approval, bytes } = await readStableLegacyApproval({
    approvalFile,
    expectedApprovalSha256,
    lstatImpl,
    realpathImpl,
    openImpl
  });
  await assertLegacySourceMountContract({
    approval,
    sourceRoot,
    readMountInfoImpl,
    lstatImpl,
    realpathImpl
  });

  const snapshotPath = path.join(root, `source-inventory-${expectedApprovalSha256}.json`);
  if (path.dirname(snapshotPath) !== root || !path.basename(snapshotPath).startsWith("source-inventory-")) {
    fail("LEGACY_SOURCE_SNAPSHOT_PATH_INVALID");
  }
  try {
    await lstatImpl(snapshotPath);
    fail("LEGACY_SOURCE_SNAPSHOT_EXISTS");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  let handle;
  try {
    handle = await openImpl(
      snapshotPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      0o600
    );
    await handle.writeFile(bytes);
    await handle.sync();
    const snapshotMetadata = await handle.stat();
    assertSnapshotMetadata(snapshotMetadata, bytes.byteLength);
  } catch (error) {
    if (error?.code === "EEXIST" || error?.code === "ELOOP") fail("LEGACY_SOURCE_SNAPSHOT_EXISTS");
    if (error?.code && String(error.code).startsWith("LEGACY_SOURCE_SNAPSHOT_")) throw error;
    fail("LEGACY_SOURCE_SNAPSHOT_WRITE_FAILED");
  } finally {
    try {
      await handle?.close();
    } catch {
      fail("LEGACY_SOURCE_SNAPSHOT_WRITE_FAILED");
    }
  }

  let pathMetadata;
  let canonicalSnapshot;
  try {
    pathMetadata = await lstatImpl(snapshotPath);
    canonicalSnapshot = path.resolve(await realpathImpl(snapshotPath));
  } catch {
    fail("LEGACY_SOURCE_SNAPSHOT_UNSAFE");
  }
  assertSnapshotMetadata(pathMetadata, bytes.byteLength);
  if (pathMetadata.isSymbolicLink() || canonicalSnapshot !== snapshotPath) {
    fail("LEGACY_SOURCE_SNAPSHOT_UNSAFE");
  }
  return snapshotPath;
}

async function readStableLegacyApproval({
  approvalFile,
  expectedApprovalSha256,
  lstatImpl,
  realpathImpl,
  openImpl
}) {
  let pathMetadata;
  let canonicalApprovalFile;
  try {
    pathMetadata = await lstatImpl(approvalFile);
    canonicalApprovalFile = path.resolve(await realpathImpl(approvalFile));
  } catch {
    fail("LEGACY_SOURCE_APPROVAL_UNSAFE");
  }
  if (!pathMetadata.isFile() || pathMetadata.isSymbolicLink() ||
      canonicalApprovalFile !== path.resolve(approvalFile) ||
      pathMetadata.size < 2 || pathMetadata.size > LEGACY_APPROVAL_MAX_BYTES) {
    fail("LEGACY_SOURCE_APPROVAL_UNSAFE");
  }

  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  let handle;
  let bytes;
  try {
    handle = await openImpl(approvalFile, constants.O_RDONLY | noFollow);
    const before = await handle.stat();
    assertSameFile(pathMetadata, before, "LEGACY_SOURCE_APPROVAL_CHANGED");
    if (!before.isFile() || before.size < 2 || before.size > LEGACY_APPROVAL_MAX_BYTES) {
      fail("LEGACY_SOURCE_APPROVAL_UNSAFE");
    }
    bytes = await handle.readFile();
    const after = await handle.stat();
    assertSameFile(before, after, "LEGACY_SOURCE_APPROVAL_CHANGED");
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== before.size || bytes.byteLength !== after.size) {
      fail("LEGACY_SOURCE_APPROVAL_CHANGED");
    }
  } catch (error) {
    if (error?.code && String(error.code).startsWith("LEGACY_SOURCE_APPROVAL_")) throw error;
    fail("LEGACY_SOURCE_APPROVAL_UNSAFE");
  } finally {
    try {
      await handle?.close();
    } catch {
      fail("LEGACY_SOURCE_APPROVAL_UNSAFE");
    }
  }

  let approval;
  try {
    approval = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    fail("LEGACY_SOURCE_APPROVAL_UNREADABLE");
  }
  assertLegacyApprovalConfirmation(approval, expectedApprovalSha256);
  return { approval, bytes: Buffer.from(bytes) };
}

function assertLegacyApprovalConfirmation(approval, expectedApprovalSha256) {
  if (!approval || typeof approval !== "object" || Array.isArray(approval)) {
    fail("LEGACY_SOURCE_APPROVAL_UNREADABLE");
  }
  const expectedKeys = [
    "version", "projectRef", "releaseGitSha", "targetSha256", "referenceInventoryDigestSha256",
    "executionPlanDigestSha256", "driftDisposition", "issuedAt", "expiresAt", "roots", "approvalSha256"
  ].sort();
  const actualKeys = Object.keys(approval).sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    fail("LEGACY_SOURCE_APPROVAL_UNREADABLE");
  }
  if (typeof approval.approvalSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(approval.approvalSha256)) {
    fail("LEGACY_SOURCE_APPROVAL_CONFIRMATION_MISMATCH");
  }
  const { approvalSha256, ...unsigned } = approval;
  if (approvalSha256 !== expectedApprovalSha256 || canonicalSha256(unsigned) !== approvalSha256) {
    fail("LEGACY_SOURCE_APPROVAL_CONFIRMATION_MISMATCH");
  }
}

async function assertLegacySourceMountContract({
  approval,
  sourceRoot,
  readMountInfoImpl,
  lstatImpl,
  realpathImpl
}) {
  if (!approval || typeof approval !== "object" || !Array.isArray(approval.roots) ||
      approval.roots.length < 1 || approval.roots.length > 16) {
    fail("LEGACY_SOURCE_ROOTS_INVALID");
  }
  const root = path.resolve(sourceRoot);
  const approvedRoots = approval.roots.map((entry) => {
    if (!entry || typeof entry !== "object" || typeof entry.rootPath !== "string" || !path.isAbsolute(entry.rootPath)) {
      fail("LEGACY_SOURCE_ROOT_INVALID");
    }
    const candidate = path.resolve(entry.rootPath);
    if (candidate === root || !candidate.startsWith(`${root}${path.sep}`)) fail("LEGACY_SOURCE_ROOT_INVALID");
    return candidate;
  });
  if (new Set(approvedRoots).size !== approvedRoots.length) fail("LEGACY_SOURCE_ROOT_INVALID");

  let mountInfo;
  try {
    mountInfo = await readMountInfoImpl(MOUNT_INFO_FILE, "utf8");
  } catch {
    fail("LEGACY_SOURCE_MOUNTINFO_UNREADABLE");
  }
  const mounts = parseMountInfo(mountInfo);
  for (const approvedRoot of approvedRoots) {
    let metadata;
    let canonical;
    try {
      metadata = await lstatImpl(approvedRoot);
      canonical = path.resolve(await realpathImpl(approvedRoot));
    } catch {
      fail("LEGACY_SOURCE_ROOT_INVALID");
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || canonical !== approvedRoot) {
      fail("LEGACY_SOURCE_ROOT_INVALID");
    }
    const mount = mounts.find((candidate) => path.resolve(candidate.mountPoint) === approvedRoot);
    if (!mount || !mount.options.has("ro") || mount.propagating) fail("LEGACY_SOURCE_MOUNT_CONTRACT_INVALID");
  }
}

function parseMountInfo(value) {
  if (typeof value !== "string") fail("LEGACY_SOURCE_MOUNTINFO_INVALID");
  const output = [];
  for (const line of value.split(/\r?\n/u).filter(Boolean)) {
    const separator = line.indexOf(" - ");
    if (separator < 0) fail("LEGACY_SOURCE_MOUNTINFO_INVALID");
    const fields = line.slice(0, separator).split(" ");
    if (fields.length < 6) fail("LEGACY_SOURCE_MOUNTINFO_INVALID");
    const optional = fields.slice(6);
    output.push({
      mountPoint: decodeMountInfoPath(fields[4]),
      options: new Set(fields[5].split(",")),
      propagating: optional.some((field) => /^(?:shared|master|propagate_from):/u.test(field))
    });
  }
  return output;
}

function decodeMountInfoPath(value) {
  return value.replace(/\\(040|011|012|134)/gu, (_, code) => ({
    "040": " ",
    "011": "\t",
    "012": "\n",
    "134": "\\"
  })[code]);
}

async function assertDedicatedOutputRoot({ outputRoot, purpose, lstatImpl, realpathImpl, requiredMode }) {
  if (typeof outputRoot !== "string" || !path.isAbsolute(outputRoot)) fail("MAINTENANCE_OUTPUT_ROOT_INVALID");
  const root = path.resolve(outputRoot);
  if (path.basename(root) !== purpose) fail("MAINTENANCE_OUTPUT_ROOT_INVALID");
  let metadata;
  let canonical;
  try {
    metadata = await lstatImpl(root);
    canonical = path.resolve(await realpathImpl(root));
  } catch {
    fail("MAINTENANCE_OUTPUT_ROOT_INVALID");
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || canonical !== root) {
    fail("MAINTENANCE_OUTPUT_ROOT_INVALID");
  }
  if (Number.isInteger(requiredMode) && Number.isInteger(metadata.mode) && (metadata.mode & 0o777) !== requiredMode) {
    fail("MAINTENANCE_OUTPUT_ROOT_INVALID");
  }
  if (typeof process.getuid === "function" && Number.isInteger(metadata.uid) && metadata.uid !== process.getuid()) {
    fail("MAINTENANCE_OUTPUT_ROOT_INVALID");
  }
  return root;
}

function assertSnapshotMetadata(metadata, expectedSize) {
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== expectedSize ||
      (Number.isInteger(metadata.nlink) && metadata.nlink !== 1) ||
      (Number.isInteger(metadata.mode) && (metadata.mode & 0o777) !== 0o600)) {
    fail("LEGACY_SOURCE_SNAPSHOT_UNSAFE");
  }
}

function assertSameFile(expected, actual, code) {
  if (expected.dev !== actual.dev || expected.ino !== actual.ino || expected.size !== actual.size ||
      expected.mtimeMs !== actual.mtimeMs) {
    fail(code);
  }
}

function canonicalSha256(value) {
  return createHash("sha256").update(JSON.stringify(sortCanonicalValue(value))).digest("hex");
}

function sortCanonicalValue(value) {
  if (Array.isArray(value)) return value.map(sortCanonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortCanonicalValue(item)])
  );
}

function rejectOutputOverrides(env) {
  for (const key of [
    "MIGRATION_JOURNAL_FILE", "MIGRATION_OUTPUT_ROOT", "JOURNAL_FILE",
    "LEGACY_OUTPUT_ROOT", "LEGACY_SOURCE_SNAPSHOT_FILE"
  ]) {
    if (typeof env[key] === "string" && env[key].length > 0) {
      fail("MAINTENANCE_OUTPUT_PATH_OVERRIDE_FORBIDDEN");
    }
  }
}

async function protectedMigrationJournalPath({ outputRoot, lstatImpl, realpathImpl }) {
  if (typeof outputRoot !== "string" || !path.isAbsolute(outputRoot)) {
    fail("MAINTENANCE_OUTPUT_ROOT_INVALID");
  }
  const root = path.resolve(outputRoot);
  if (path.basename(root) !== "migration") fail("MAINTENANCE_OUTPUT_ROOT_INVALID");
  let rootStat;
  try {
    rootStat = await lstatImpl(root);
  } catch {
    fail("MAINTENANCE_OUTPUT_ROOT_INVALID");
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail("MAINTENANCE_OUTPUT_ROOT_INVALID");
  let canonicalRoot;
  try {
    canonicalRoot = path.resolve(await realpathImpl(root));
  } catch {
    fail("MAINTENANCE_OUTPUT_ROOT_INVALID");
  }
  if (canonicalRoot !== root) fail("MAINTENANCE_OUTPUT_ROOT_INVALID");

  const journalPath = path.join(root, MIGRATION_JOURNAL_NAME);
  try {
    const targetStat = await lstatImpl(journalPath);
    if (targetStat.isSymbolicLink()) fail("MAINTENANCE_OUTPUT_SYMLINK_FORBIDDEN");
    fail("MAINTENANCE_OUTPUT_FILE_EXISTS");
  } catch (failure) {
    if (failure?.code !== "ENOENT") throw failure;
  }
  return journalPath;
}

function rejectCredentialBleed(env, purpose) {
  const allowed = new Set(Object.keys(CREDENTIAL_MAP[purpose]));
  const ownPrefix = `${purpose.toUpperCase()}_`;
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string" || value.length === 0 || !SENSITIVE_NAME.test(key)) continue;
    if (NON_CREDENTIAL_INPUT_KEYS.has(key)) continue;
    if (allowed.has(key)) continue;
    if (PURPOSES.some((candidate) => key.startsWith(`${candidate.toUpperCase()}_`)) && !key.startsWith(ownPrefix)) {
      fail("MAINTENANCE_FOREIGN_CREDENTIAL_PRESENT");
    }
    if (!key.startsWith(ownPrefix)) fail("MAINTENANCE_UNSCOPED_CREDENTIAL_PRESENT");
    fail("MAINTENANCE_CREDENTIAL_NOT_ALLOWED");
  }
}

function protectedPath(value, inputRoot, fallback) {
  const root = path.resolve(inputRoot);
  const candidate = path.resolve(value || path.join(root, fallback));
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) fail("MAINTENANCE_INPUT_PATH_INVALID");
  return candidate;
}

function requiredProtectedPath(value, inputRoot, code) {
  if (typeof value !== "string" || value.length === 0) fail(code);
  return protectedPath(value, inputRoot, "required-protected-input");
}

function requireCredentials(env, names) {
  if (names.some((name) => typeof env[name] !== "string" || env[name].length === 0)) {
    fail("MAINTENANCE_PURPOSE_CREDENTIAL_REQUIRED");
  }
}

function parseMode(value) {
  const mode = value || "PLAN";
  if (mode !== "PLAN" && mode !== "APPLY") fail("MAINTENANCE_MODE_INVALID");
  return mode;
}

function assertPurpose(value) {
  if (!PURPOSES.includes(value)) fail("MAINTENANCE_PURPOSE_INVALID");
}

function assertEnum(value, allowed, code) {
  if (!allowed.includes(value)) fail(code);
  return value;
}

function assertOpaque(value, code) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(value)) fail(code);
  return value;
}

function assertProjectRef(value) {
  return assertProjectRefWithCode(value, "AUTH_CONFIRM_PROJECT_REF_REQUIRED");
}

function assertRelease(value) {
  return assertReleaseWithCode(value, "AUTH_CONFIRM_RELEASE_REQUIRED");
}

function assertProjectRefWithCode(value, code) {
  if (typeof value !== "string" || !/^[a-z]{20}$/u.test(value)) fail(code);
  return value;
}

function assertReleaseWithCode(value, code) {
  if (typeof value !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value)) fail(code);
  return value;
}

function assertHex(value, code) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) fail(code);
  return value;
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", () => reject(error("MAINTENANCE_CHILD_SPAWN_FAILED")));
    child.once("exit", (code, signal) => {
      if (signal) reject(error("MAINTENANCE_CHILD_SIGNALED"));
      else resolve(Number.isInteger(code) ? code : 1);
    });
  });
}

function error(code) {
  const failure = new Error(code);
  failure.code = code;
  return failure;
}

function fail(code) {
  throw error(code);
}

async function main() {
  const exitCode = await runMaintenanceEntrypoint();
  process.exitCode = exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((failure) => {
    const code = typeof failure?.code === "string" ? failure.code : "MAINTENANCE_ENTRYPOINT_FAILED";
    process.stderr.write(`${JSON.stringify({ event: "maintenance-entrypoint", result: "FAIL", code })}\n`);
    process.exitCode = 1;
  });
}
