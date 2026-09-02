import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { constants } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildMaintenanceInvocation, runMaintenanceEntrypoint } from "./maintenance-entrypoint.mjs";

const root = path.resolve("C:/srv/maintenance-test");
const inputRoot = path.resolve("C:/run/maintenance-input-test");
const marker = async () => "auth\n";

test("auth PLAN maps only purpose credentials into the child environment", async () => {
  const secret = "auth-secret-value";
  const bindingKeyPath = path.join(inputRoot, "auth-manifest-binding-key.json");
  const invocation = await buildMaintenanceInvocation({
    root,
    inputRoot,
    purpose: "auth",
    command: "user-disposition",
    env: {
      LANG: "C.UTF-8",
      PATH: "must-not-pass",
      AUTH_DATABASE_URL: "postgres://auth",
      AUTH_SUPABASE_URL: "https://example.supabase.co",
      AUTH_SUPABASE_SECRET_KEY: secret,
      AUTH_MANIFEST_FILE: path.join(inputRoot, "input.json"),
      AUTH_MANIFEST_BINDING_KEY_FILE: bindingKeyPath
    },
    readFileImpl: marker
  });
  assert.equal(invocation.script.endsWith(path.join("dist", "auth", "user-disposition.cli.js")), true);
  assert.deepEqual(invocation.args, [
    "--manifest", path.join(inputRoot, "input.json"),
    "--manifest-binding-key-file", bindingKeyPath
  ]);
  assert.equal(invocation.env.SUPABASE_SECRET_KEY, secret);
  assert.equal(invocation.env.AUTH_SUPABASE_SECRET_KEY, undefined);
  assert.equal(invocation.env.PATH, undefined);
  assert.equal(invocation.env.AUTH_MANIFEST_BINDING_KEY_FILE, undefined);
  assert.equal(JSON.stringify(invocation).includes("manifest-binding-key-material"), false);
  assert.deepEqual(Object.keys(invocation.env).sort(), ["DATABASE_URL", "LANG", "NODE_ENV", "SUPABASE_SECRET_KEY", "SUPABASE_URL"]);
});

test("auth PLAN fails closed when its protected key path or purpose credentials are missing", async () => {
  const base = {
    AUTH_DATABASE_URL: "postgres://auth",
    AUTH_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
    AUTH_SUPABASE_SECRET_KEY: "auth-admin-secret",
    AUTH_MANIFEST_BINDING_KEY_FILE: path.join(inputRoot, "auth-manifest-binding-key.json")
  };
  for (const [key, code] of [
    ["AUTH_MANIFEST_BINDING_KEY_FILE", "AUTH_MANIFEST_BINDING_KEY_FILE_REQUIRED"],
    ["AUTH_DATABASE_URL", "MAINTENANCE_PURPOSE_CREDENTIAL_REQUIRED"],
    ["AUTH_SUPABASE_URL", "MAINTENANCE_PURPOSE_CREDENTIAL_REQUIRED"],
    ["AUTH_SUPABASE_SECRET_KEY", "MAINTENANCE_PURPOSE_CREDENTIAL_REQUIRED"]
  ]) {
    await assert.rejects(() => buildMaintenanceInvocation({
      root,
      inputRoot,
      purpose: "auth",
      command: "user-disposition",
      env: { ...base, [key]: undefined },
      readFileImpl: marker
    }), withCode(code));
  }
  await assert.rejects(() => buildMaintenanceInvocation({
    root,
    inputRoot,
    purpose: "auth",
    command: "user-disposition",
    env: { ...base, AUTH_MANIFEST_BINDING_KEY: "manifest-binding-key-material" },
    readFileImpl: marker
  }), withCode("MAINTENANCE_CREDENTIAL_NOT_ALLOWED"));
});

test("rejects foreign, generic, and unknown own-purpose credentials without exposing values", async () => {
  const secret = "never-print-this-secret";
  for (const [env, code] of [
    [{ BACKUP_STORAGE_ACCESS_TOKEN: secret }, "MAINTENANCE_FOREIGN_CREDENTIAL_PRESENT"],
    [{ DATABASE_URL: secret }, "MAINTENANCE_UNSCOPED_CREDENTIAL_PRESENT"],
    [{ AUTH_UNKNOWN_TOKEN: secret }, "MAINTENANCE_CREDENTIAL_NOT_ALLOWED"]
  ]) {
    await assert.rejects(() => buildMaintenanceInvocation({
      root, inputRoot, purpose: "auth", command: "user-disposition", env, readFileImpl: marker
    }), (failure) => failure.code === code && !failure.message.includes(secret));
  }
});

test("purpose marker and command selection fail closed", async () => {
  await assert.rejects(() => buildMaintenanceInvocation({
    root, inputRoot, purpose: "auth", command: "backup", env: {}, readFileImpl: marker
  }), withCode("MAINTENANCE_COMMAND_NOT_ALLOWED"));
  await assert.rejects(() => buildMaintenanceInvocation({
    root, inputRoot, purpose: "auth", command: "user-disposition", env: {}, readFileImpl: async () => "storage\n"
  }), withCode("MAINTENANCE_PURPOSE_MARKER_MISMATCH"));
});

test("auth APPLY passes only a protected binding-key path and exact non-secret confirmations", async () => {
  const bindingKeyPath = path.join(inputRoot, "auth-manifest-binding-key.json");
  const env = authApplyEnvironment({ AUTH_MANIFEST_BINDING_KEY_FILE: bindingKeyPath });
  const invocation = await buildMaintenanceInvocation({
    root, inputRoot, purpose: "auth", command: "user-disposition", env, readFileImpl: marker
  });
  assert.deepEqual(invocation.args, [
    "--manifest", path.join(inputRoot, "auth-disposition.json"),
    "--manifest-binding-key-file", bindingKeyPath,
    "--apply",
    "--action", "BOOTSTRAP_SUPER_ADMIN",
    "--confirm-plan", env.AUTH_CONFIRM_PLAN,
    "--confirm-project-ref", env.AUTH_CONFIRM_PROJECT_REF,
    "--confirm-release", env.AUTH_CONFIRM_RELEASE,
    "--confirm-target", env.AUTH_CONFIRM_TARGET,
    "--confirm-manifest-hmac", env.AUTH_CONFIRM_MANIFEST_HMAC,
    "--confirm-binding-key-id", env.AUTH_CONFIRM_BINDING_KEY_ID
  ]);
  assert.equal(invocation.env.AUTH_MANIFEST_BINDING_KEY_FILE, undefined);
  assert.equal(Object.values(invocation.env).includes(bindingKeyPath), false);
  assert.equal(JSON.stringify(invocation).includes("manifest-binding-key-material"), false);
});

test("auth APPLY fails closed for missing, malformed, or escaped binding confirmations", async () => {
  for (const [override, code] of [
    [{ AUTH_MANIFEST_BINDING_KEY_FILE: undefined }, "AUTH_MANIFEST_BINDING_KEY_FILE_REQUIRED"],
    [{ AUTH_MANIFEST_BINDING_KEY_FILE: path.resolve(inputRoot, "..", "escape.key") }, "MAINTENANCE_INPUT_PATH_INVALID"],
    [{ AUTH_CONFIRM_MANIFEST_HMAC: undefined }, "AUTH_CONFIRM_MANIFEST_HMAC_REQUIRED"],
    [{ AUTH_CONFIRM_MANIFEST_HMAC: "a".repeat(63) }, "AUTH_CONFIRM_MANIFEST_HMAC_REQUIRED"],
    [{ AUTH_CONFIRM_BINDING_KEY_ID: undefined }, "AUTH_CONFIRM_BINDING_KEY_ID_REQUIRED"]
  ]) {
    await assert.rejects(() => buildMaintenanceInvocation({
      root,
      inputRoot,
      purpose: "auth",
      command: "user-disposition",
      env: authApplyEnvironment(override),
      readFileImpl: marker
    }), withCode(code));
  }
  await assert.rejects(() => buildMaintenanceInvocation({
    root,
    inputRoot,
    purpose: "auth",
    command: "user-disposition",
    env: authApplyEnvironment({ AUTH_MANIFEST_BINDING_KEY: "manifest-binding-key-material" }),
    readFileImpl: marker
  }), withCode("MAINTENANCE_CREDENTIAL_NOT_ALLOWED"));
});

test("migration requires its own database credential and has a fixed deploy command", async () => {
  const readMigrationMarker = async () => "migration\n";
  await assert.rejects(() => buildMaintenanceInvocation({
    root, inputRoot, purpose: "migration", command: "migrate-deploy", env: {}, readFileImpl: readMigrationMarker
  }), withCode("MAINTENANCE_PURPOSE_CREDENTIAL_REQUIRED"));
  const invocation = await buildMaintenanceInvocation({
    root,
    inputRoot,
    purpose: "migration",
    command: "migrate-deploy",
    env: { MIGRATION_DATABASE_URL: "postgres://migration" },
    readFileImpl: readMigrationMarker
  });
  assert.deepEqual(invocation.args, [
    "--target", path.join(inputRoot, "migration-target.json"),
    "--release", path.join(inputRoot, "migration-release.json")
  ]);
  assert.deepEqual(Object.keys(invocation.env).sort(), ["DATABASE_URL", "NODE_ENV"]);
});

test("migration child plan requires and forwards exact non-secret confirmations", async () => {
  const env = {
    MIGRATION_DATABASE_URL: "postgres://migration",
    MIGRATION_MODE: "PLAN_CHILD",
    MIGRATION_CONFIRM_PLAN: "c".repeat(64),
    MIGRATION_CONFIRM_RELEASE_ID: "d".repeat(64),
    MIGRATION_CONFIRM_PROJECT_REF: "abcdefghijklmnopqrst",
    MIGRATION_CONFIRM_RELEASE_SHA: "a".repeat(40),
    MIGRATION_CONFIRM_TARGET: "b".repeat(64)
  };
  const invocation = await buildMaintenanceInvocation({
    root, inputRoot, purpose: "migration", command: "migrate-deploy", env,
    readFileImpl: async () => "migration\n"
  });
  assert.equal(invocation.args.includes("--plan-child"), true);
  assert.equal(invocation.args.includes(env.MIGRATION_CONFIRM_RELEASE_SHA), true);
  assert.equal(Object.values(invocation.env).includes(env.MIGRATION_CONFIRM_TARGET), false);
});

test("migration EXECUTE uses a fixed command, exact confirmations, and a deterministic protected journal", async (t) => {
  const outputBase = await mkdtemp(path.join(os.tmpdir(), "maintenance-output-test-"));
  const migrationOutputRoot = path.join(outputBase, "migration");
  await mkdir(migrationOutputRoot, { mode: 0o700 });
  t.after(() => rm(outputBase, { recursive: true, force: true }));
  const env = migrationExecuteEnvironment();
  const invocation = await buildMaintenanceInvocation({
    root,
    inputRoot,
    migrationOutputRoot,
    purpose: "migration",
    command: "migrate-deploy",
    env,
    readFileImpl: async () => "migration\n"
  });
  const journalPath = path.join(migrationOutputRoot, "migration-journal.jsonl");
  assert.deepEqual(invocation.args, [
    "--target", path.join(inputRoot, "migration-target.json"),
    "--release", path.join(inputRoot, "migration-release.json"),
    "--execute",
    "--confirm-plan", env.MIGRATION_CONFIRM_PLAN,
    "--confirm-release-id", env.MIGRATION_CONFIRM_RELEASE_ID,
    "--confirm-project-ref", env.MIGRATION_CONFIRM_PROJECT_REF,
    "--confirm-release-sha", env.MIGRATION_CONFIRM_RELEASE_SHA,
    "--confirm-target", env.MIGRATION_CONFIRM_TARGET
  ]);
  assert.deepEqual({ ...invocation.env }, {
    NODE_ENV: "production",
    DATABASE_URL: "postgres://migration",
    MIGRATION_JOURNAL_FILE: journalPath
  });
  assert.equal(invocation.args.includes(journalPath), false);
  assert.equal(Object.values(invocation.env).includes(env.MIGRATION_CONFIRM_PLAN), false);
  assert.equal(Object.values(invocation.env).includes(env.MIGRATION_CONFIRM_TARGET), false);
});

test("migration EXECUTE rejects incomplete or malformed exact confirmation before journal access", async () => {
  for (const [override, code] of [
    [{ MIGRATION_CONFIRM_PLAN: undefined }, "MIGRATION_CONFIRM_PLAN_REQUIRED"],
    [{ MIGRATION_CONFIRM_PLAN: "a".repeat(63) }, "MIGRATION_CONFIRM_PLAN_REQUIRED"],
    [{ MIGRATION_CONFIRM_RELEASE_ID: undefined }, "MIGRATION_CONFIRM_RELEASE_ID_REQUIRED"],
    [{ MIGRATION_CONFIRM_RELEASE_ID: "A".repeat(64) }, "MIGRATION_CONFIRM_RELEASE_ID_REQUIRED"],
    [{ MIGRATION_CONFIRM_PROJECT_REF: undefined }, "MIGRATION_CONFIRM_PROJECT_REF_REQUIRED"],
    [{ MIGRATION_CONFIRM_RELEASE_SHA: "a".repeat(39) }, "MIGRATION_CONFIRM_RELEASE_SHA_REQUIRED"],
    [{ MIGRATION_CONFIRM_TARGET: "b".repeat(65) }, "MIGRATION_CONFIRM_TARGET_REQUIRED"]
  ]) {
    await assert.rejects(() => buildMaintenanceInvocation({
      root,
      inputRoot,
      purpose: "migration",
      command: "migrate-deploy",
      env: migrationExecuteEnvironment(override),
      readFileImpl: async () => "migration\n"
    }), withCode(code));
  }
});

test("migration EXECUTE rejects output overrides, unsafe roots, symlinks, and existing journal files", async () => {
  for (const override of [
    { MIGRATION_JOURNAL_FILE: path.resolve(inputRoot, "..", "escaped-journal.jsonl") },
    { MIGRATION_OUTPUT_ROOT: path.resolve(inputRoot, "..", "escaped-output") },
    { JOURNAL_FILE: "raw-journal-content" }
  ]) {
    await assert.rejects(() => buildMaintenanceInvocation({
      root,
      inputRoot,
      purpose: "migration",
      command: "migrate-deploy",
      env: migrationExecuteEnvironment(override),
      readFileImpl: async () => "migration\n"
    }), withCode("MAINTENANCE_OUTPUT_PATH_OVERRIDE_FORBIDDEN"));
  }

  const outputRoot = path.resolve("C:/run/maintenance-output-test/migration");
  const directory = { isDirectory: () => true, isSymbolicLink: () => false };
  const symlink = { isDirectory: () => false, isSymbolicLink: () => true };
  await assert.rejects(() => buildMaintenanceInvocation({
    root,
    inputRoot,
    migrationOutputRoot: outputRoot,
    purpose: "migration",
    command: "migrate-deploy",
    env: migrationExecuteEnvironment(),
    readFileImpl: async () => "migration\n",
    lstatImpl: async (candidate) => candidate === outputRoot ? symlink : missing(),
    realpathImpl: async (candidate) => candidate
  }), withCode("MAINTENANCE_OUTPUT_ROOT_INVALID"));
  await assert.rejects(() => buildMaintenanceInvocation({
    root,
    inputRoot,
    migrationOutputRoot: outputRoot,
    purpose: "migration",
    command: "migrate-deploy",
    env: migrationExecuteEnvironment(),
    readFileImpl: async () => "migration\n",
    lstatImpl: async (candidate) => candidate === outputRoot ? directory : symlink,
    realpathImpl: async (candidate) => candidate
  }), withCode("MAINTENANCE_OUTPUT_SYMLINK_FORBIDDEN"));
  await assert.rejects(() => buildMaintenanceInvocation({
    root,
    inputRoot,
    migrationOutputRoot: outputRoot,
    purpose: "migration",
    command: "migrate-deploy",
    env: migrationExecuteEnvironment(),
    readFileImpl: async () => "migration\n",
    lstatImpl: async () => directory,
    realpathImpl: async (candidate) => candidate
  }), withCode("MAINTENANCE_OUTPUT_FILE_EXISTS"));
});

test("migration EXECUTE never spawns a child when validation fails", async () => {
  let spawnCount = 0;
  await assert.rejects(() => runMaintenanceEntrypoint({
    root,
    inputRoot,
    purpose: "migration",
    argv: ["migrate-deploy"],
    env: migrationExecuteEnvironment({ MIGRATION_CONFIRM_PLAN: undefined }),
    readFileImpl: async () => "migration\n",
    spawnProcess: () => {
      spawnCount += 1;
      return new EventEmitter();
    }
  }), withCode("MIGRATION_CONFIRM_PLAN_REQUIRED"));
  assert.equal(spawnCount, 0);
});

test("storage token artifact accepts only protected input paths and no arbitrary argv", async () => {
  const confirmBundleSha256 = "c".repeat(64);
  const invocation = await buildMaintenanceInvocation({
    root,
    inputRoot,
    purpose: "storage",
    command: "token-artifact",
    env: { STORAGE_CONFIRM_BUNDLE_SHA256: confirmBundleSha256 },
    readFileImpl: async () => "storage\n"
  });
  assert.equal(invocation.args.length, 4);
  assert.equal(invocation.args.slice(0, 3).every((arg) => arg.includes(inputRoot)), true);
  assert.equal(invocation.args[3], `--confirm-bundle-sha256=${confirmBundleSha256}`);
  await assert.rejects(() => buildMaintenanceInvocation({
    root, inputRoot, purpose: "storage", command: "token-artifact", env: {},
    readFileImpl: async () => "storage\n"
  }), withCode("STORAGE_CONFIRM_BUNDLE_SHA256_REQUIRED"));
  await assert.rejects(() => buildMaintenanceInvocation({
    root, inputRoot, purpose: "storage", command: "token-artifact",
    env: { STORAGE_CONFIRM_BUNDLE_SHA256: "c".repeat(63) },
    readFileImpl: async () => "storage\n"
  }), withCode("STORAGE_CONFIRM_BUNDLE_SHA256_REQUIRED"));
  await assert.rejects(() => buildMaintenanceInvocation({
    root,
    inputRoot,
    purpose: "storage",
    command: "token-artifact",
    env: {
      STORAGE_TOKEN_FILE: path.resolve(inputRoot, "..", "escape.token"),
      STORAGE_CONFIRM_BUNDLE_SHA256: confirmBundleSha256
    },
    readFileImpl: async () => "storage\n"
  }), withCode("MAINTENANCE_INPUT_PATH_INVALID"));
  await assert.rejects(() => buildMaintenanceInvocation({
    root,
    inputRoot,
    purpose: "storage",
    command: "token-artifact",
    env: {
      STORAGE_CONFIRM_BUNDLE_SHA256: confirmBundleSha256,
      STORAGE_SIGNING_KEY_FILE: path.join(inputRoot, "private-signer.key")
    },
    readFileImpl: async () => "storage\n"
  }), withCode("MAINTENANCE_CREDENTIAL_NOT_ALLOWED"));
});

test("storage policy APPLY requires a protected fine-grained credential approval and independent confirmations", async () => {
  const env = {
    STORAGE_MODE: "APPLY",
    STORAGE_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
    STORAGE_SUPABASE_FINE_GRAINED_TOKEN: "scoped-storage-fine-grained-token",
    STORAGE_CONFIRM_PLAN_SHA256: "d".repeat(64),
    STORAGE_CONFIRM_BEFORE_SHA256: "e".repeat(64),
    STORAGE_CONFIRM_APPROVAL_SHA256: "f".repeat(64)
  };
  const invocation = await buildMaintenanceInvocation({
    root, inputRoot, purpose: "storage", command: "policy", env,
    readFileImpl: async () => "storage\n"
  });
  assert.deepEqual(invocation.args, [
    `--manifest=${path.join(inputRoot, "storage-policy.json")}`,
    `--credential-approval=${path.join(inputRoot, "storage-credential-approval.json")}`,
    "--execute",
    `--confirm-plan-sha256=${env.STORAGE_CONFIRM_PLAN_SHA256}`,
    `--confirm-before-sha256=${env.STORAGE_CONFIRM_BEFORE_SHA256}`,
    `--confirm-approval-sha256=${env.STORAGE_CONFIRM_APPROVAL_SHA256}`
  ]);
  assert.equal(invocation.env.DATABASE_URL, undefined);
  assert.equal(invocation.env.SUPABASE_ACCESS_TOKEN, undefined);
  assert.deepEqual(Object.keys(invocation.env).sort(), ["NODE_ENV", "SUPABASE_FINE_GRAINED_TOKEN", "SUPABASE_URL"]);

  for (const [override, code] of [
    [{ STORAGE_CONFIRM_PLAN_SHA256: undefined }, "STORAGE_CONFIRM_PLAN_SHA256_REQUIRED"],
    [{ STORAGE_CONFIRM_PLAN_SHA256: "d".repeat(63) }, "STORAGE_CONFIRM_PLAN_SHA256_REQUIRED"],
    [{ STORAGE_CONFIRM_BEFORE_SHA256: undefined }, "STORAGE_CONFIRM_BEFORE_SHA256_REQUIRED"],
    [{ STORAGE_CONFIRM_BEFORE_SHA256: "e".repeat(65) }, "STORAGE_CONFIRM_BEFORE_SHA256_REQUIRED"],
    [{ STORAGE_CONFIRM_APPROVAL_SHA256: undefined }, "STORAGE_CONFIRM_APPROVAL_SHA256_REQUIRED"],
    [{ STORAGE_CONFIRM_APPROVAL_SHA256: "F".repeat(64) }, "STORAGE_CONFIRM_APPROVAL_SHA256_REQUIRED"],
    [{ STORAGE_CREDENTIAL_APPROVAL_FILE: path.resolve(inputRoot, "..", "approval.json") }, "MAINTENANCE_INPUT_PATH_INVALID"]
  ]) {
    await assert.rejects(() => buildMaintenanceInvocation({
      root,
      inputRoot,
      purpose: "storage",
      command: "policy",
      env: { ...env, ...override },
      readFileImpl: async () => "storage\n"
    }), withCode(code));
  }
  await assert.rejects(() => buildMaintenanceInvocation({
    root,
    inputRoot,
    purpose: "storage",
    command: "policy",
    env: { ...env, STORAGE_DATABASE_URL: "postgres://unneeded-secret" },
    readFileImpl: async () => "storage\n"
  }), withCode("MAINTENANCE_CREDENTIAL_NOT_ALLOWED"));
  await assert.rejects(() => buildMaintenanceInvocation({
    root,
    inputRoot,
    purpose: "storage",
    command: "policy",
    env: { ...env, STORAGE_SUPABASE_ACCESS_TOKEN: "generic-token-is-forbidden" },
    readFileImpl: async () => "storage\n"
  }), withCode("MAINTENANCE_CREDENTIAL_NOT_ALLOWED"));
});

test("storage policy rejects old parent and generic child tokens before spawn", async () => {
  const base = {
    STORAGE_MODE: "APPLY",
    STORAGE_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
    STORAGE_SUPABASE_FINE_GRAINED_TOKEN: "scoped-storage-fine-grained-token",
    STORAGE_CONFIRM_PLAN_SHA256: "d".repeat(64),
    STORAGE_CONFIRM_BEFORE_SHA256: "e".repeat(64),
    STORAGE_CONFIRM_APPROVAL_SHA256: "f".repeat(64)
  };
  for (const [override, code] of [
    [{ STORAGE_SUPABASE_ACCESS_TOKEN: "old-generic-token" }, "MAINTENANCE_CREDENTIAL_NOT_ALLOWED"],
    [{ SUPABASE_ACCESS_TOKEN: "unscoped-child-token" }, "MAINTENANCE_UNSCOPED_CREDENTIAL_PRESENT"]
  ]) {
    let spawnCount = 0;
    await assert.rejects(() => runMaintenanceEntrypoint({
      root,
      inputRoot,
      purpose: "storage",
      argv: ["policy"],
      env: { ...base, ...override },
      readFileImpl: async () => "storage\n",
      spawnProcess: () => {
        spawnCount += 1;
        return new EventEmitter();
      }
    }), withCode(code));
    assert.equal(spawnCount, 0);
  }
});

test("backup APPLY uses only exact protected inputs, confirmations, tools, output, and scoped credentials", async (t) => {
  const outputBase = await mkdtemp(path.join(os.tmpdir(), "backup-output-test-"));
  const backupOutputRoot = path.join(outputBase, "backup");
  await mkdir(backupOutputRoot, { mode: 0o700 });
  t.after(() => rm(outputBase, { recursive: true, force: true }));
  const backupEnv = backupApplyEnvironment({ BACKUP_OUTPUT_ROOT: backupOutputRoot });
  const backup = await buildMaintenanceInvocation({
    root, inputRoot, backupOutputRoot, purpose: "backup", command: "backup", env: backupEnv,
    readFileImpl: async () => "backup\n"
  });
  assert.deepEqual(backup.args, [
    `--manifest=${path.join(inputRoot, "backup.json")}`,
    `--provider-binding=${path.join(inputRoot, "backup-provider-binding.json")}`,
    `--encryption-key=${path.join(inputRoot, "backup-encryption-key.json")}`,
    `--write-block-receipt=${path.join(inputRoot, "backup-write-block-receipt.json")}`,
    `--write-block-public-key=${path.join(inputRoot, "backup-write-block-public-key.json")}`,
    "--execute",
    `--confirm-plan-sha256=${backupEnv.BACKUP_CONFIRM_PLAN_SHA256}`,
    `--confirm-provider-binding-sha256=${backupEnv.BACKUP_CONFIRM_PROVIDER_BINDING_SHA256}`,
    `--confirm-encryption-key-sha256=${backupEnv.BACKUP_CONFIRM_ENCRYPTION_KEY_SHA256}`,
    `--confirm-write-block-receipt-sha256=${backupEnv.BACKUP_CONFIRM_WRITE_BLOCK_RECEIPT_SHA256}`,
    `--confirm-write-block-public-key-sha256=${backupEnv.BACKUP_CONFIRM_WRITE_BLOCK_PUBLIC_KEY_SHA256}`
  ]);
  assert.deepEqual({ ...backup.env }, {
    NODE_ENV: "production",
    BACKUP_DATABASE_URL: backupEnv.BACKUP_DATABASE_URL,
    BACKUP_SUPABASE_STORAGE_READ_TOKEN: backupEnv.BACKUP_SUPABASE_STORAGE_READ_TOKEN,
    BACKUP_R2_ACCESS_KEY_ID: backupEnv.BACKUP_R2_ACCESS_KEY_ID,
    BACKUP_R2_SECRET_ACCESS_KEY: backupEnv.BACKUP_R2_SECRET_ACCESS_KEY,
    BACKUP_PG_DUMP_EXECUTABLE: "/usr/bin/pg_dump",
    BACKUP_OUTPUT_ROOT: backupOutputRoot
  });
  assert.equal(backup.args.some((argument) => Object.values(backup.env).includes(argument)), false);

  for (const [override, code] of [
    [{ BACKUP_CONFIRM_PLAN_SHA256: undefined }, "BACKUP_CONFIRM_PLAN_SHA256_REQUIRED"],
    [{ BACKUP_CONFIRM_PROVIDER_BINDING_SHA256: "2".repeat(63) }, "BACKUP_CONFIRM_PROVIDER_BINDING_SHA256_REQUIRED"],
    [{ BACKUP_CONFIRM_ENCRYPTION_KEY_SHA256: "A".repeat(64) }, "BACKUP_CONFIRM_ENCRYPTION_KEY_SHA256_REQUIRED"],
    [{ BACKUP_CONFIRM_WRITE_BLOCK_RECEIPT_SHA256: undefined }, "BACKUP_CONFIRM_WRITE_BLOCK_RECEIPT_SHA256_REQUIRED"],
    [{ BACKUP_CONFIRM_WRITE_BLOCK_PUBLIC_KEY_SHA256: "5".repeat(65) }, "BACKUP_CONFIRM_WRITE_BLOCK_PUBLIC_KEY_SHA256_REQUIRED"],
    [{ BACKUP_PROVIDER_BINDING_FILE: path.resolve(inputRoot, "..", "escape.json") }, "MAINTENANCE_INPUT_PATH_INVALID"],
    [{ BACKUP_ENCRYPTION_KEY_FILE: path.resolve(inputRoot, "..", "escape.json") }, "MAINTENANCE_INPUT_PATH_INVALID"],
    [{ BACKUP_WRITE_BLOCK_RECEIPT_FILE: path.resolve(inputRoot, "..", "escape.json") }, "MAINTENANCE_INPUT_PATH_INVALID"],
    [{ BACKUP_WRITE_BLOCK_PUBLIC_KEY_FILE: path.resolve(inputRoot, "..", "escape.json") }, "MAINTENANCE_INPUT_PATH_INVALID"]
  ]) {
    await assert.rejects(() => buildMaintenanceInvocation({
      root,
      inputRoot,
      backupOutputRoot,
      purpose: "backup",
      command: "backup",
      env: backupApplyEnvironment({ BACKUP_OUTPUT_ROOT: backupOutputRoot, ...override }),
      readFileImpl: async () => "backup\n"
    }), withCode(code));
  }
  for (const override of [
    { BACKUP_PG_DUMP_EXECUTABLE: "/tmp/pg_dump" },
    { BACKUP_OUTPUT_ROOT: path.resolve(backupOutputRoot, "..", "escape") }
  ]) {
    await assert.rejects(() => buildMaintenanceInvocation({
      root,
      inputRoot,
      backupOutputRoot,
      purpose: "backup",
      command: "backup",
      env: backupApplyEnvironment({ BACKUP_OUTPUT_ROOT: backupOutputRoot, ...override }),
      readFileImpl: async () => "backup\n"
    }), (failure) => ["BACKUP_PG_DUMP_EXECUTABLE_INVALID", "BACKUP_OUTPUT_ROOT_INVALID"].includes(failure?.code));
  }
  const fakeOutputRoot = path.resolve("C:/run/maintenance-output-test/backup");
  await assert.rejects(() => buildMaintenanceInvocation({
    root,
    inputRoot,
    backupOutputRoot: fakeOutputRoot,
    purpose: "backup",
    command: "backup",
    env: backupApplyEnvironment({ BACKUP_OUTPUT_ROOT: fakeOutputRoot }),
    readFileImpl: async () => "backup\n",
    lstatImpl: async () => ({ isDirectory: () => false, isSymbolicLink: () => true }),
    realpathImpl: async (candidate) => candidate
  }), withCode("MAINTENANCE_OUTPUT_ROOT_INVALID"));
});

test("backup rejects generic, obsolete, and unscoped credentials before child spawn", async () => {
  for (const [override, code] of [
    [{ DATABASE_URL: "postgres://generic" }, "MAINTENANCE_UNSCOPED_CREDENTIAL_PRESENT"],
    [{ AWS_ACCESS_KEY_ID: "generic-aws-key" }, "MAINTENANCE_UNSCOPED_CREDENTIAL_PRESENT"],
    [{ BACKUP_STORAGE_ACCESS_TOKEN: "obsolete-token" }, "MAINTENANCE_CREDENTIAL_NOT_ALLOWED"],
    [{ BACKUP_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co" }, "MAINTENANCE_CREDENTIAL_NOT_ALLOWED"],
    [{ BACKUP_SINK_URL: "https://sink.invalid" }, "MAINTENANCE_CREDENTIAL_NOT_ALLOWED"]
  ]) {
    let spawnCount = 0;
    await assert.rejects(() => runMaintenanceEntrypoint({
      root,
      inputRoot,
      purpose: "backup",
      argv: ["backup"],
      env: backupApplyEnvironment(override),
      readFileImpl: async () => "backup\n",
      spawnProcess: () => {
        spawnCount += 1;
        return new EventEmitter();
      }
    }), withCode(code));
    assert.equal(spawnCount, 0);
  }
});

test("legacy APPLY binds protected source/provider artifacts and all three independent confirmations", async () => {
  const mountContract = legacyMountContract();
  const legacyEnv = legacyApplyEnvironment({
    LEGACY_CONFIRM_SOURCE_INVENTORY_SHA256: mountContract.approvalSha256
  });
  const legacy = await buildMaintenanceInvocation({
    root, inputRoot, purpose: "legacy", command: "inventory", env: legacyEnv, ...mountContract,
    readFileImpl: async () => "legacy\n"
  });
  assert.deepEqual(legacy.args, [
    `--manifest=${path.join(inputRoot, "legacy-inventory.json")}`,
    `--source-inventory=${mountContract.snapshotPath}`,
    `--provider-binding=${path.join(inputRoot, "legacy-provider-binding.json")}`,
    "--execute",
    `--confirm-plan-sha256=${legacyEnv.LEGACY_CONFIRM_PLAN_SHA256}`,
    `--confirm-provider-binding-sha256=${legacyEnv.LEGACY_CONFIRM_PROVIDER_BINDING_SHA256}`,
    `--confirm-source-inventory-sha256=${legacyEnv.LEGACY_CONFIRM_SOURCE_INVENTORY_SHA256}`
  ]);
  assert.deepEqual({ ...legacy.env }, {
    NODE_ENV: "production",
    DATABASE_URL: legacyEnv.LEGACY_DATABASE_URL,
    STORAGE_ACCESS_TOKEN: legacyEnv.LEGACY_STORAGE_ACCESS_TOKEN
  });
  assert.equal(legacy.args.some((arg) => arg.includes(path.join(inputRoot, "legacy-source-inventory-approval.json"))), false);
  assert.deepEqual(mountContract.snapshotBytes(), mountContract.approvalBytes);

  for (const [override, code] of [
    [{ LEGACY_CONFIRM_PLAN_SHA256: undefined }, "LEGACY_CONFIRM_PLAN_SHA256_REQUIRED"],
    [{ LEGACY_CONFIRM_PROVIDER_BINDING_SHA256: "G".repeat(64) }, "LEGACY_CONFIRM_PROVIDER_BINDING_SHA256_REQUIRED"],
    [{ LEGACY_CONFIRM_SOURCE_INVENTORY_SHA256: "5".repeat(63) }, "LEGACY_CONFIRM_SOURCE_INVENTORY_SHA256_REQUIRED"],
    [{ LEGACY_SOURCE_INVENTORY_FILE: path.resolve(inputRoot, "..", "escape.json") }, "MAINTENANCE_INPUT_PATH_INVALID"],
    [{ LEGACY_PROVIDER_BINDING_FILE: path.resolve(inputRoot, "..", "escape.json") }, "MAINTENANCE_INPUT_PATH_INVALID"]
  ]) {
    await assert.rejects(() => buildMaintenanceInvocation({
      root,
      inputRoot,
      purpose: "legacy",
      command: "inventory",
      env: legacyApplyEnvironment(override),
      ...mountContract,
      readFileImpl: async () => "legacy\n"
    }), withCode(code));
  }

  const mismatched = legacyMountContract();
  await assert.rejects(() => buildMaintenanceInvocation({
    root,
    inputRoot,
    purpose: "legacy",
    command: "inventory",
    env: legacyApplyEnvironment({ LEGACY_CONFIRM_SOURCE_INVENTORY_SHA256: "6".repeat(64) }),
    ...mismatched,
    readFileImpl: async () => "legacy\n"
  }), withCode("LEGACY_SOURCE_APPROVAL_CONFIRMATION_MISMATCH"));
  assert.equal(mismatched.snapshotBytes(), undefined);
});

test("legacy source roots must be exact, canonical, read-only, private mounts before spawn", async () => {
  const cases = [
    {
      configure: (base) => ({ readMountInfoImpl: async () => `101 1 0:1 / ${base.approvedRoot} rw - bind source rw\n` }),
      code: "LEGACY_SOURCE_MOUNT_CONTRACT_INVALID"
    },
    {
      configure: (base) => ({
        readMountInfoImpl: async () => `101 1 0:1 / ${base.approvedRoot} ro shared:7 - bind source ro\n`
      }),
      code: "LEGACY_SOURCE_MOUNT_CONTRACT_INVALID"
    },
    {
      configure: () => ({ readMountInfoImpl: async () => "101 1 0:1 / /different ro - bind source ro\n" }),
      code: "LEGACY_SOURCE_MOUNT_CONTRACT_INVALID"
    },
    {
      configure: (base) => ({
        lstatImpl: async (candidate) => candidate === base.approvedRoot ? symbolicLinkStat() : base.lstatImpl(candidate)
      }),
      code: "LEGACY_SOURCE_ROOT_INVALID"
    },
    {
      options: { approvedRoot: path.resolve(DEFAULT_LEGACY_SOURCE_ROOT, "..", "escape") },
      code: "LEGACY_SOURCE_ROOT_INVALID"
    },
    {
      configure: (base) => ({
        realpathImpl: async (candidate) => candidate === base.approvedRoot
          ? path.join(base.legacySourceRoot, "different")
          : base.realpathImpl(candidate)
      }),
      code: "LEGACY_SOURCE_ROOT_INVALID"
    }
  ];
  for (const { options, configure, code } of cases) {
    const base = legacyMountContract(options);
    const override = configure?.(base) ?? {};
    let spawnCount = 0;
    await assert.rejects(() => runMaintenanceEntrypoint({
      root,
      inputRoot,
      purpose: "legacy",
      argv: ["inventory"],
      env: legacyApplyEnvironment({ LEGACY_CONFIRM_SOURCE_INVENTORY_SHA256: base.approvalSha256 }),
      ...base,
      ...override,
      readFileImpl: async () => "legacy\n",
      spawnProcess: () => {
        spawnCount += 1;
        return new EventEmitter();
      }
    }), withCode(code));
    assert.equal(spawnCount, 0);
    assert.equal(base.snapshotBytes(), undefined);
  }
});

test("legacy snapshots the exact one-handle approval bytes and resists original A/B path swaps", async () => {
  const base = legacyMountContract({ swapOriginalAfterOpen: true });
  const invocation = await buildMaintenanceInvocation({
    root,
    inputRoot,
    purpose: "legacy",
    command: "inventory",
    env: legacyApplyEnvironment({ LEGACY_CONFIRM_SOURCE_INVENTORY_SHA256: base.approvalSha256 }),
    ...base,
    readFileImpl: async () => "legacy\n"
  });
  assert.equal(base.originalWasSwapped(), true);
  assert.deepEqual(base.snapshotBytes(), base.approvalBytes);
  assert.notDeepEqual(base.snapshotBytes(), base.currentOriginalBytes());
  assert.equal(invocation.args.includes(`--source-inventory=${base.snapshotPath}`), true);
  assert.equal(invocation.args.some((arg) => arg.includes(base.approvalFile)), false);

  const changed = legacyMountContract({ changeApprovalDuringRead: true });
  let spawnCount = 0;
  await assert.rejects(() => runMaintenanceEntrypoint({
    root,
    inputRoot,
    purpose: "legacy",
    argv: ["inventory"],
    env: legacyApplyEnvironment({ LEGACY_CONFIRM_SOURCE_INVENTORY_SHA256: changed.approvalSha256 }),
    ...changed,
    readFileImpl: async () => "legacy\n",
    spawnProcess: () => {
      spawnCount += 1;
      return new EventEmitter();
    }
  }), withCode("LEGACY_SOURCE_APPROVAL_CHANGED"));
  assert.equal(spawnCount, 0);
  assert.equal(changed.snapshotBytes(), undefined);
});

test("legacy rejects unsafe output roots and preexisting or symlink snapshots before spawn", async () => {
  for (const options of [
    { outputRootMode: 0o755 },
    { outputRootSymlink: true },
    { outputRootRealpathEscape: true },
    { snapshotPreexists: true },
    { snapshotSymlink: true }
  ]) {
    const base = legacyMountContract(options);
    let spawnCount = 0;
    await assert.rejects(() => runMaintenanceEntrypoint({
      root,
      inputRoot,
      purpose: "legacy",
      argv: ["inventory"],
      env: legacyApplyEnvironment({ LEGACY_CONFIRM_SOURCE_INVENTORY_SHA256: base.approvalSha256 }),
      ...base,
      readFileImpl: async () => "legacy\n",
      spawnProcess: () => {
        spawnCount += 1;
        return new EventEmitter();
      }
    }), (failure) => ["MAINTENANCE_OUTPUT_ROOT_INVALID", "LEGACY_SOURCE_SNAPSHOT_EXISTS"].includes(failure?.code));
    assert.equal(spawnCount, 0);
  }

  const base = legacyMountContract();
  for (const key of ["LEGACY_OUTPUT_ROOT", "LEGACY_SOURCE_SNAPSHOT_FILE"]) {
    await assert.rejects(() => buildMaintenanceInvocation({
      root,
      inputRoot,
      purpose: "legacy",
      command: "inventory",
      env: legacyApplyEnvironment({
        LEGACY_CONFIRM_SOURCE_INVENTORY_SHA256: base.approvalSha256,
        [key]: path.resolve("C:/unsafe", key)
      }),
      ...base,
      readFileImpl: async () => "legacy\n"
    }), withCode("MAINTENANCE_OUTPUT_PATH_OVERRIDE_FORBIDDEN"));
  }
});

test("backup and legacy standalone children compose bounded direct providers and legacy source readers", async () => {
  const [backupCli, backupProvider, legacyCli, legacyProvider] = await Promise.all([
    readFile(new URL("../../apps/api/maintenance/backup/backup.cli.ts", import.meta.url), "utf8"),
    readFile(new URL("../../apps/api/maintenance/backup/direct-provider.ts", import.meta.url), "utf8"),
    readFile(new URL("../../apps/api/maintenance/legacy/legacy.cli.ts", import.meta.url), "utf8"),
    readFile(new URL("../../apps/api/maintenance/legacy/direct-provider.ts", import.meta.url), "utf8")
  ]);
  assert.match(backupCli, /const factory = input\.providerFactory \?\? defaultProviderFactory/u);
  assert.match(backupCli, /createCloudflareR2BackupAdapter/u);
  assert.match(backupProvider, /env: buildPgDumpEnvironment\(input\.password\)/u);
  assert.match(backupProvider, /"PATH", "LANG", "LC_ALL", "TZ", "SSL_CERT_FILE", "SSL_CERT_DIR"/u);
  assert.doesNotMatch(backupProvider, /env:\s*\{\s*\.\.\.process\.env/u);
  assert.match(backupProvider, /BACKUP_PG_DUMP_LINUX_LIMIT_EXECUTABLE = "\/usr\/bin\/prlimit"/u);
  assert.match(backupProvider, /`--fsize=\$\{maximumDumpBytes\}:\$\{maximumDumpBytes\}`, "--", input\.executable/u);
  assert.match(legacyCli, /directContext = await createDirectLegacyContext/u);
  assert.match(legacyProvider, /if \(!metadata\.isDirectory\(\) \|\| metadata\.isSymbolicLink\(\)\)/u);
  assert.match(legacyProvider, /if \(canonical !== resolved\) throw new Error\("LEGACY_SOURCE_ROOT_INVALID"\)/u);
  assert.match(legacyProvider, /const noFollow = typeof constants\.O_NOFOLLOW === "number" \? constants\.O_NOFOLLOW : 0/u);
  assert.match(legacyProvider, /fs\.open\(candidate, constants\.O_RDONLY \| noFollow\)/u);
});

test("runner preserves the fixed executable, argv, cwd, and sanitized environment", async () => {
  let captured;
  const spawnProcess = (executable, args, options) => {
    captured = { executable, args, options };
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("exit", 0, null));
    return child;
  };
  const exitCode = await runMaintenanceEntrypoint({
    root,
    inputRoot,
    purpose: "auth",
    argv: ["user-disposition"],
    env: {
      AUTH_DATABASE_URL: "postgres://auth",
      AUTH_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
      AUTH_SUPABASE_SECRET_KEY: "auth-admin-secret",
      AUTH_MANIFEST_BINDING_KEY_FILE: path.join(inputRoot, "auth-manifest-binding-key.json")
    },
    readFileImpl: marker,
    spawnProcess
  });
  assert.equal(exitCode, 0);
  assert.equal(captured.executable, process.execPath);
  assert.equal(captured.args[0].endsWith(path.join("dist", "auth", "user-disposition.cli.js")), true);
  assert.equal(captured.options.cwd, root);
  assert.deepEqual({ ...captured.options.env }, {
    NODE_ENV: "production",
    DATABASE_URL: "postgres://auth",
    SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
    SUPABASE_SECRET_KEY: "auth-admin-secret"
  });
  assert.equal(captured.options.stdio, "inherit");
});

function withCode(code) {
  return (failure) => failure?.code === code;
}

function authApplyEnvironment(overrides = {}) {
  return {
    AUTH_MODE: "APPLY",
    AUTH_DATABASE_URL: "postgres://auth",
    AUTH_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
    AUTH_SUPABASE_SECRET_KEY: "auth-admin-secret",
    AUTH_MANIFEST_BINDING_KEY_FILE: path.join(inputRoot, "auth-manifest-binding-key.json"),
    AUTH_ACTION: "BOOTSTRAP_SUPER_ADMIN",
    AUTH_CONFIRM_PLAN: "plan-identifier-01",
    AUTH_CONFIRM_PROJECT_REF: "abcdefghijklmnopqrst",
    AUTH_CONFIRM_RELEASE: "a".repeat(40),
    AUTH_CONFIRM_TARGET: "b".repeat(64),
    AUTH_CONFIRM_MANIFEST_HMAC: "c".repeat(64),
    AUTH_CONFIRM_BINDING_KEY_ID: "binding-key-id-01",
    ...overrides
  };
}

function migrationExecuteEnvironment(overrides = {}) {
  return {
    MIGRATION_MODE: "EXECUTE",
    MIGRATION_DATABASE_URL: "postgres://migration",
    MIGRATION_CONFIRM_PLAN: "c".repeat(64),
    MIGRATION_CONFIRM_RELEASE_ID: "d".repeat(64),
    MIGRATION_CONFIRM_PROJECT_REF: "abcdefghijklmnopqrst",
    MIGRATION_CONFIRM_RELEASE_SHA: "a".repeat(40),
    MIGRATION_CONFIRM_TARGET: "b".repeat(64),
    ...overrides
  };
}

function backupApplyEnvironment(overrides = {}) {
  return {
    BACKUP_MODE: "APPLY",
    BACKUP_DATABASE_URL: "postgres://backup",
    BACKUP_PG_DUMP_EXECUTABLE: "/usr/bin/pg_dump",
    BACKUP_OUTPUT_ROOT: "/run/maintenance-output/backup",
    BACKUP_SUPABASE_STORAGE_READ_TOKEN: "backup-source-read-token",
    BACKUP_R2_ACCESS_KEY_ID: "backup-r2-access-key-id",
    BACKUP_R2_SECRET_ACCESS_KEY: "backup-r2-secret-access-key",
    BACKUP_CONFIRM_PLAN_SHA256: "1".repeat(64),
    BACKUP_CONFIRM_PROVIDER_BINDING_SHA256: "2".repeat(64),
    BACKUP_CONFIRM_ENCRYPTION_KEY_SHA256: "3".repeat(64),
    BACKUP_CONFIRM_WRITE_BLOCK_RECEIPT_SHA256: "4".repeat(64),
    BACKUP_CONFIRM_WRITE_BLOCK_PUBLIC_KEY_SHA256: "5".repeat(64),
    ...overrides
  };
}

function legacyApplyEnvironment(overrides = {}) {
  return {
    LEGACY_MODE: "APPLY",
    LEGACY_DATABASE_URL: "postgres://legacy",
    LEGACY_STORAGE_ACCESS_TOKEN: "legacy-storage-token",
    LEGACY_CONFIRM_PLAN_SHA256: "3".repeat(64),
    LEGACY_CONFIRM_PROVIDER_BINDING_SHA256: "4".repeat(64),
    LEGACY_CONFIRM_SOURCE_INVENTORY_SHA256: legacyApproval(
      path.join(DEFAULT_LEGACY_SOURCE_ROOT, "source-a")
    ).approvalSha256,
    ...overrides
  };
}

const DEFAULT_LEGACY_SOURCE_ROOT = path.resolve("C:/run/legacy-source-test");

function legacyMountContract(options = {}) {
  const legacySourceRoot = DEFAULT_LEGACY_SOURCE_ROOT;
  const approvedRoot = options.approvedRoot ?? path.join(legacySourceRoot, "source-a");
  const approvalFile = path.join(inputRoot, "legacy-source-inventory-approval.json");
  const legacyOutputRoot = path.resolve("C:/run/maintenance-output-test/legacy");
  const approval = legacyApproval(approvedRoot);
  const approvalBytes = Buffer.from(JSON.stringify(approval));
  const snapshotPath = path.join(legacyOutputRoot, `source-inventory-${approval.approvalSha256}.json`);
  const originalMetadata = fileStat({ dev: 10, ino: 20, size: approvalBytes.byteLength, mtimeMs: 30, mode: 0o600 });
  const replacementBytes = Buffer.from(JSON.stringify(legacyApproval(path.join(legacySourceRoot, "source-b"))));
  const replacementMetadata = fileStat({
    dev: originalMetadata.dev,
    ino: originalMetadata.ino + 1,
    size: replacementBytes.byteLength,
    mtimeMs: originalMetadata.mtimeMs + 1,
    mode: 0o600
  });
  let currentOriginalBytes = approvalBytes;
  let currentOriginalMetadata = originalMetadata;
  let snapshot;
  let originalWasSwapped = false;
  let approvalStatCount = 0;

  const lstatImpl = async (candidate) => {
    if (candidate === approvalFile) return currentOriginalMetadata;
    if (candidate === legacyOutputRoot) {
      return options.outputRootSymlink
        ? symbolicLinkStat()
        : directoryStat({ mode: options.outputRootMode ?? 0o700 });
    }
    if (candidate === snapshotPath) {
      if (options.snapshotSymlink) return symbolicLinkStat();
      if (options.snapshotPreexists) return fileStat({ dev: 40, ino: 50, size: 2, mtimeMs: 60, mode: 0o600 });
      if (snapshot) return fileStat({ dev: 40, ino: 50, size: snapshot.byteLength, mtimeMs: 60, mode: 0o600 });
      return missing();
    }
    if (candidate === approvedRoot) return directoryStat({ mode: 0o500 });
    return missing();
  };

  const realpathImpl = async (candidate) => {
    if (candidate === legacyOutputRoot && options.outputRootRealpathEscape) {
      return path.resolve(legacyOutputRoot, "..", "escape");
    }
    return candidate;
  };

  const openImpl = async (candidate, flags, mode) => {
    if (candidate === approvalFile) {
      const openedBytes = currentOriginalBytes;
      const openedMetadata = currentOriginalMetadata;
      if (options.swapOriginalAfterOpen) {
        currentOriginalBytes = replacementBytes;
        currentOriginalMetadata = replacementMetadata;
        originalWasSwapped = true;
      }
      return {
        stat: async () => {
          approvalStatCount += 1;
          if (options.changeApprovalDuringRead && approvalStatCount > 1) {
            return fileStat({
              dev: originalMetadata.dev,
              ino: originalMetadata.ino + 1,
              size: originalMetadata.size,
              mtimeMs: originalMetadata.mtimeMs + 1,
              mode: 0o600
            });
          }
          return openedMetadata;
        },
        readFile: async () => Buffer.from(openedBytes),
        close: async () => undefined
      };
    }
    if (candidate === snapshotPath) {
      if (snapshot || options.snapshotPreexists || options.snapshotSymlink) {
        const failure = new Error("exists");
        failure.code = "EEXIST";
        throw failure;
      }
      assert.equal((flags & constants.O_EXCL) !== 0, true);
      assert.equal(mode, 0o600);
      return {
        writeFile: async (value) => { snapshot = Buffer.from(value); },
        sync: async () => undefined,
        stat: async () => fileStat({ dev: 40, ino: 50, size: snapshot?.byteLength ?? 0, mtimeMs: 60, mode: 0o600 }),
        close: async () => undefined
      };
    }
    return missing();
  };

  return {
    legacySourceRoot,
    legacyOutputRoot,
    approvedRoot,
    approvalFile,
    approvalBytes,
    approvalSha256: approval.approvalSha256,
    snapshotPath,
    snapshotBytes: () => snapshot,
    originalWasSwapped: () => originalWasSwapped,
    currentOriginalBytes: () => currentOriginalBytes,
    readMountInfoImpl: async () => `101 1 0:1 / ${approvedRoot} ro - bind source ro\n`,
    lstatImpl,
    realpathImpl,
    openImpl
  };
}

function legacyApproval(approvedRoot) {
  const unsigned = {
    version: "legacy-source-inventory-approval/v1",
    projectRef: "abcdefghijklmnopqrst",
    releaseGitSha: "a".repeat(40),
    targetSha256: "1".repeat(64),
    referenceInventoryDigestSha256: "2".repeat(64),
    executionPlanDigestSha256: "3".repeat(64),
    driftDisposition: "APPROVED_CURRENT_INVENTORY",
    issuedAt: "2026-09-01T00:00:00.000Z",
    expiresAt: "2026-09-03T00:00:00.000Z",
    roots: [{
      rootId: "legacy-source-root-001",
      rootPath: approvedRoot,
      fileCount: 1,
      totalBytes: 7,
      manifestSha256: "4".repeat(64)
    }]
  };
  return { ...unsigned, approvalSha256: canonicalSha256(unsigned) };
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

function fileStat({ dev, ino, size, mtimeMs, mode }) {
  return {
    dev,
    ino,
    size,
    mtimeMs,
    mode: 0o100000 | mode,
    nlink: 1,
    uid: typeof process.getuid === "function" ? process.getuid() : 0,
    isDirectory: () => false,
    isFile: () => true,
    isSymbolicLink: () => false
  };
}

function directoryStat({ mode }) {
  return {
    mode: 0o040000 | mode,
    uid: typeof process.getuid === "function" ? process.getuid() : 0,
    isDirectory: () => true,
    isFile: () => false,
    isSymbolicLink: () => false
  };
}

function symbolicLinkStat() {
  return {
    mode: 0o120777,
    isDirectory: () => false,
    isFile: () => false,
    isSymbolicLink: () => true
  };
}

function missing() {
  const failure = new Error("missing");
  failure.code = "ENOENT";
  throw failure;
}
