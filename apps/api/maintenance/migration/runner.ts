import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { spawn } from "node:child_process";
import { Prisma, type PrismaClient } from "@prisma/client";
import { canonicalJson, canonicalSha256 } from "../shared/strict-json";
import {
  assertTargetConfirmation,
  parseCloudTargetBinding,
  targetBindingSha256,
  type CloudTargetBinding,
  type TargetConfirmation
} from "../shared/target-binding";
import { validateMigrationRelease, type MigrationRelease } from "./release";

export type MigrationClassification =
  | "PRISTINE_EMPTY_SCHEMA_READY"
  | "MANAGED_EXACT_CHAIN_READY"
  | "LEGACY_COLLISION_BLOCKED"
  | "PARTIAL_OR_DRIFT_BLOCKED";

export interface MigrationHistoryEntry {
  name: string;
  checksum: string;
  state: "APPLIED" | "FAILED" | "ROLLED_BACK";
}

export interface MigrationCatalogSnapshot {
  targetSha256: string;
  schema: string;
  relationNames: string[];
  typeNames: string[];
  migrationHistoryExists: boolean;
  history: MigrationHistoryEntry[];
  connection: {
    currentUser: string;
    database: string;
    schema: string;
    hasRequiredRole: boolean;
    tlsAuthorized: boolean;
    tlsMode: "verify-full";
    serverName: string;
  };
}

export interface MigrationCatalogInspector {
  inspect(target: CloudTargetBinding): Promise<MigrationCatalogSnapshot>;
}

export interface MigrationTargetPlan {
  version: "migration-target-plan/v1";
  planId: string;
  releaseId: string;
  targetSha256: string;
  projectRef: string;
  releaseGitSha: string;
  mode: "INSPECT_ONLY";
  classification: MigrationClassification;
  applyRequired: boolean;
  counts: {
    relations: number;
    types: number;
    legacyOverlap: number;
    applied: number;
    pending: number;
    failedOrRolledBack: number;
    unknownHistory: number;
    unexpectedRelations: number;
  };
  digests: {
    catalogSha256: string;
    legacyOverlapSha256: string;
    connectionSha256: string;
  };
  codes: string[];
}

export function createPrismaMigrationCatalogInspector(input: {
  client: Pick<PrismaClient, "$queryRaw">;
  target: CloudTargetBinding;
  confirmation: TargetConfirmation;
  credentialPurpose: "MIGRATION_INSPECT_DB" | "MIGRATION_APPLY_DB";
  tls: { authorized: true; mode: "verify-full"; serverName: string };
  now?: Date;
}): MigrationCatalogInspector {
  const target = parseCloudTargetBinding(input.target, input.now ?? new Date());
  assertTargetConfirmation(target, input.confirmation);
  if (input.credentialPurpose !== "MIGRATION_INSPECT_DB" && input.credentialPurpose !== "MIGRATION_APPLY_DB") {
    throw new Error("MIGRATION_DB_CREDENTIAL_PURPOSE_INVALID");
  }
  if (input.tls.authorized !== true || input.tls.mode !== "verify-full" ||
    input.tls.serverName !== target.database.tlsServerName) {
    throw new Error("MIGRATION_DB_TLS_CONFIRMATION_INVALID");
  }
  if (target.database.schema !== "public") throw new Error("MIGRATION_INSPECT_SCHEMA_UNSUPPORTED");
  return {
    async inspect(requestedTarget) {
      if (targetBindingSha256(requestedTarget) !== targetBindingSha256(target)) {
        throw new Error("MIGRATION_INSPECT_TARGET_MISMATCH");
      }
      const identityRows = await input.client.$queryRaw<Array<{
        current_user: string;
        current_database: string;
        current_schema: string;
        has_required_role: boolean;
      }>>(Prisma.sql`
        SELECT current_user,
               current_database() AS current_database,
               current_schema() AS current_schema,
               pg_has_role(current_user, ${target.database.requiredRole}, 'USAGE') AS has_required_role
      `);
      const identity = identityRows[0];
      if (!identity || identity.current_user !== target.database.expectedCurrentUser ||
        identity.current_database !== target.database.name || identity.current_schema !== target.database.schema ||
        identity.has_required_role !== true) {
        throw new Error("MIGRATION_DB_CONNECTION_IDENTITY_MISMATCH");
      }
      const [relationRows, typeRows, historyTableRows] = await Promise.all([
        input.client.$queryRaw<Array<{ name: string }>>(Prisma.sql`
          SELECT c.relname AS name
            FROM pg_catalog.pg_class c
            JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public'
             AND c.relkind IN ('r', 'p')
             AND c.relname <> '_prisma_migrations'
           ORDER BY c.relname
        `),
        input.client.$queryRaw<Array<{ name: string }>>(Prisma.sql`
          SELECT t.typname AS name
            FROM pg_catalog.pg_type t
            JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
           WHERE n.nspname = 'public'
             AND t.typtype = 'e'
           ORDER BY t.typname
        `),
        input.client.$queryRaw<Array<{ present: boolean }>>(Prisma.sql`
          SELECT to_regclass('public._prisma_migrations') IS NOT NULL AS present
        `)
      ]);
      const migrationHistoryExists = historyTableRows[0]?.present === true;
      const historyRows = migrationHistoryExists
        ? await input.client.$queryRaw<Array<{
            migration_name: string;
            checksum: string;
            finished_at: Date | null;
            rolled_back_at: Date | null;
          }>>(Prisma.sql`
            SELECT migration_name, checksum, finished_at, rolled_back_at
              FROM public._prisma_migrations
             ORDER BY started_at, migration_name
          `)
        : [];
      return {
        targetSha256: targetBindingSha256(target),
        schema: target.database.schema,
        relationNames: relationRows.map((row) => row.name),
        typeNames: typeRows.map((row) => row.name),
        migrationHistoryExists,
        history: historyRows.map((row) => ({
          name: row.migration_name,
          checksum: row.checksum,
          state: row.rolled_back_at ? "ROLLED_BACK" : row.finished_at ? "APPLIED" : "FAILED"
        })),
        connection: {
          currentUser: identity.current_user,
          database: identity.current_database,
          schema: identity.current_schema,
          hasRequiredRole: identity.has_required_role,
          tlsAuthorized: true,
          tlsMode: "verify-full",
          serverName: input.tls.serverName
        }
      };
    }
  };
}

export interface MigrationApplyApproval extends TargetConfirmation {
  approved: true;
  planId: string;
  releaseId: string;
}

export interface PinnedMigrationChildPlan {
  version: "migration-child-plan/v1";
  planId: string;
  releaseId: string;
  targetSha256: string;
  executable: string;
  executableSha256: string;
  arguments: string[];
  prismaCliSha256: string;
  schemaSha256: string;
  environmentKeys: ["DATABASE_URL"];
  shell: false;
  timeoutMs: number;
  killGraceMs: number;
  operation: "PRISMA_MIGRATE_DEPLOY";
}

export interface MigrationPartialJournal {
  version: "migration-partial-journal/v1";
  planId: string;
  releaseId: string;
  targetSha256: string;
  state: "INTENT_RECORDED" | "CHILD_FAILED" | "APPLIED_PENDING_VERIFY" | "VERIFIED";
  attempt: number;
  code: string;
}

export interface MigrationArtifactReader {
  sha256(filePath: string): Promise<string>;
}

export interface MigrationChildAdapter {
  run(input: {
    executable: string;
    arguments: string[];
    environment: Record<string, string>;
    timeoutMs: number;
    killGraceMs: number;
  }): Promise<{ exitCode: number | null; signal: string | null; timedOut: boolean }>;
}

export interface MigrationJournalStore {
  write(journal: MigrationPartialJournal): Promise<void>;
  close?(): Promise<void>;
}

export function createHashingMigrationArtifactReader(maxBytes = 256 * 1024 * 1024): MigrationArtifactReader {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("MIGRATION_ARTIFACT_LIMIT_INVALID");
  return {
    async sha256(filePath) {
      const handle = await open(filePath, "r");
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size < 1 || stat.size > maxBytes) throw new Error("MIGRATION_ARTIFACT_FILE_INVALID");
        const bytes = await handle.readFile();
        if (bytes.byteLength !== stat.size) throw new Error("MIGRATION_ARTIFACT_FILE_CHANGED");
        return createHash("sha256").update(bytes).digest("hex");
      } finally {
        await handle.close();
      }
    }
  };
}

export function createNodeMigrationChildAdapter(): MigrationChildAdapter {
  return {
    run(input) {
      return new Promise((resolve, reject) => {
        const child = spawn(input.executable, input.arguments, {
          shell: false,
          env: input.environment,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true
        });
        child.stdout?.resume();
        child.stderr?.resume();
        let timedOut = false;
        let forceKill: NodeJS.Timeout | undefined;
        const timeout = setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          forceKill = setTimeout(() => child.kill("SIGKILL"), input.killGraceMs);
        }, input.timeoutMs);
        child.once("error", (error) => {
          clearTimeout(timeout);
          if (forceKill) clearTimeout(forceKill);
          reject(error);
        });
        child.once("exit", (exitCode, signal) => {
          clearTimeout(timeout);
          if (forceKill) clearTimeout(forceKill);
          resolve({ exitCode, signal, timedOut });
        });
      });
    }
  };
}

export function createFileMigrationJournalStore(filePath: string): MigrationJournalStore {
  if (typeof filePath !== "string" || filePath.length < 2 || filePath.length > 1024 || filePath.includes("\0")) {
    throw new Error("MIGRATION_JOURNAL_PATH_INVALID");
  }
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  return {
    async write(journal) {
      if (!handle) handle = await open(filePath, "wx", 0o600);
      await handle.write(`${canonicalJson(journal)}\n`);
      await handle.sync();
    },
    async close() {
      if (handle) await handle.close();
      handle = null;
    }
  };
}

export async function executePinnedMigrationPlan(input: {
  target: CloudTargetBinding;
  release: MigrationRelease;
  plan: MigrationTargetPlan;
  approval: MigrationApplyApproval;
  databaseUrl: string;
  artifactReader?: MigrationArtifactReader;
  child?: MigrationChildAdapter;
  journal: MigrationJournalStore;
  postVerifyInspector: MigrationCatalogInspector;
  timeoutMs?: number;
  now?: Date;
}): Promise<{ state: "VERIFIED"; planId: string; verificationPlanId: string }> {
  const now = input.now ?? new Date();
  const target = parseCloudTargetBinding(input.target, now);
  const childPlan = createPinnedMigrationChildPlan({
    target,
    release: input.release,
    plan: input.plan,
    approval: input.approval,
    timeoutMs: input.timeoutMs,
    now
  });
  assertMigrationDatabaseUrl(input.databaseUrl, target);
  const artifactReader = input.artifactReader ?? createHashingMigrationArtifactReader();
  const child = input.child ?? createNodeMigrationChildAdapter();
  const expectedArtifacts = [
    [childPlan.executable, childPlan.executableSha256],
    [input.release.runtime.prismaCliPath, childPlan.prismaCliSha256],
    [input.release.runtime.schemaPath, childPlan.schemaSha256]
  ] as const;
  for (const [filePath, expectedSha256] of expectedArtifacts) {
    if (await artifactReader.sha256(filePath) !== expectedSha256) throw new Error("MIGRATION_ARTIFACT_HASH_MISMATCH");
  }

  let journal = createMigrationIntentJournal(input.plan);
  await input.journal.write(journal);
  let childResult: Awaited<ReturnType<MigrationChildAdapter["run"]>>;
  try {
    childResult = await child.run({
      executable: childPlan.executable,
      arguments: childPlan.arguments,
      environment: { DATABASE_URL: input.databaseUrl, NODE_ENV: "production" },
      timeoutMs: childPlan.timeoutMs,
      killGraceMs: childPlan.killGraceMs
    });
  } catch {
    journal = transitionMigrationJournal(journal, "CHILD_FAILED");
    await input.journal.write(journal);
    throw new Error("MIGRATION_CHILD_START_FAILED");
  }
  if (childResult.exitCode !== 0 || childResult.timedOut) {
    journal = transitionMigrationJournal(journal, "CHILD_FAILED");
    await input.journal.write(journal);
    throw new Error(childResult.timedOut ? "MIGRATION_CHILD_TIMEOUT" : "MIGRATION_CHILD_FAILED");
  }
  journal = transitionMigrationJournal(journal, "APPLIED_PENDING_VERIFY");
  await input.journal.write(journal);
  let verification: MigrationTargetPlan;
  try {
    verification = await inspectMigrationTarget(target, input.release, input.postVerifyInspector, now);
  } catch {
    journal = transitionMigrationJournal(journal, "CHILD_FAILED");
    await input.journal.write(journal);
    throw new Error("MIGRATION_POST_VERIFY_FAILED");
  }
  if (verification.classification !== "MANAGED_EXACT_CHAIN_READY" || verification.applyRequired ||
    verification.counts.pending !== 0) {
    journal = transitionMigrationJournal(journal, "CHILD_FAILED");
    await input.journal.write(journal);
    throw new Error("MIGRATION_POST_VERIFY_FAILED");
  }
  journal = transitionMigrationJournal(journal, "VERIFIED");
  await input.journal.write(journal);
  return { state: "VERIFIED", planId: input.plan.planId, verificationPlanId: verification.planId };
}

export async function inspectMigrationTarget(
  rawTarget: CloudTargetBinding,
  rawRelease: MigrationRelease,
  inspector: MigrationCatalogInspector,
  now = new Date()
): Promise<MigrationTargetPlan> {
  const target = parseCloudTargetBinding(rawTarget, now);
  const release = validateMigrationRelease(rawRelease);
  if (release.releaseGitSha !== target.releaseGitSha) throw new Error("MIGRATION_RELEASE_TARGET_SHA_MISMATCH");
  const snapshot = validateSnapshot(await inspector.inspect(target));
  const expectedTargetSha = targetBindingSha256(target);
  if (snapshot.targetSha256 !== expectedTargetSha) throw new Error("MIGRATION_INSPECT_TARGET_MISMATCH");
  if (snapshot.schema !== target.database.schema) throw new Error("MIGRATION_INSPECT_SCHEMA_MISMATCH");
  assertMigrationConnection(snapshot.connection, target);

  const analysis = classify(snapshot, release);
  const stableBody = {
    version: "migration-target-plan/v1",
    releaseId: release.releaseId,
    targetSha256: expectedTargetSha,
    projectRef: target.projectRef,
    releaseGitSha: target.releaseGitSha,
    mode: "INSPECT_ONLY",
    classification: analysis.classification,
    applyRequired: analysis.applyRequired,
    counts: analysis.counts,
    digests: analysis.digests,
    codes: analysis.codes
  } as const;
  return { ...stableBody, planId: canonicalSha256(stableBody) };
}

export function createPinnedMigrationChildPlan(input: {
  target: CloudTargetBinding;
  release: MigrationRelease;
  plan: MigrationTargetPlan;
  approval: MigrationApplyApproval;
  timeoutMs?: number;
  now?: Date;
}): PinnedMigrationChildPlan {
  if (input.approval.approved !== true) throw new Error("MIGRATION_APPLY_EXPLICIT_APPROVAL_REQUIRED");
  const target = parseCloudTargetBinding(input.target, input.now ?? new Date());
  const release = validateMigrationRelease(input.release);
  assertMigrationPlanIntegrity(input.plan);
  if (input.plan.planId !== input.approval.planId) throw new Error("MIGRATION_APPLY_PLAN_MISMATCH");
  if (release.releaseId !== input.approval.releaseId || release.releaseId !== input.plan.releaseId) {
    throw new Error("MIGRATION_APPLY_RELEASE_MISMATCH");
  }
  if (input.plan.targetSha256 !== targetBindingSha256(target) || input.plan.projectRef !== target.projectRef ||
    input.plan.releaseGitSha !== target.releaseGitSha) {
    throw new Error("MIGRATION_APPLY_TARGET_MISMATCH");
  }
  assertTargetConfirmation(target, input.approval);
  if (input.plan.classification !== "PRISTINE_EMPTY_SCHEMA_READY" &&
    input.plan.classification !== "MANAGED_EXACT_CHAIN_READY") {
    throw new Error("MIGRATION_APPLY_CLASSIFICATION_BLOCKED");
  }
  if (!input.plan.applyRequired) throw new Error("MIGRATION_APPLY_NOT_REQUIRED");
  const timeoutMs = input.timeoutMs ?? 15 * 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 60 * 60_000) {
    throw new Error("MIGRATION_APPLY_TIMEOUT_INVALID");
  }
  return {
    version: "migration-child-plan/v1",
    planId: input.plan.planId,
    releaseId: release.releaseId,
    targetSha256: input.plan.targetSha256,
    executable: release.runtime.nodePath,
    executableSha256: release.runtime.nodeSha256,
    arguments: [
      release.runtime.prismaCliPath,
      "migrate",
      "deploy",
      "--schema",
      release.runtime.schemaPath
    ],
    prismaCliSha256: release.runtime.prismaCliSha256,
    schemaSha256: release.runtime.schemaSha256,
    environmentKeys: ["DATABASE_URL"],
    shell: false,
    timeoutMs,
    killGraceMs: 10_000,
    operation: "PRISMA_MIGRATE_DEPLOY"
  };
}

function assertMigrationPlanIntegrity(plan: MigrationTargetPlan): void {
  const { planId, ...body } = plan;
  if (!/^[a-f0-9]{64}$/u.test(planId) || canonicalSha256(body) !== planId) {
    throw new Error("MIGRATION_APPLY_PLAN_INTEGRITY_INVALID");
  }
}

export function createMigrationIntentJournal(
  plan: MigrationTargetPlan,
  attempt = 1
): MigrationPartialJournal {
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error("MIGRATION_JOURNAL_ATTEMPT_INVALID");
  return {
    version: "migration-partial-journal/v1",
    planId: plan.planId,
    releaseId: plan.releaseId,
    targetSha256: plan.targetSha256,
    state: "INTENT_RECORDED",
    attempt,
    code: "MIGRATION_APPLY_INTENT_RECORDED"
  };
}

export function transitionMigrationJournal(
  journal: MigrationPartialJournal,
  next: "CHILD_FAILED" | "APPLIED_PENDING_VERIFY" | "VERIFIED"
): MigrationPartialJournal {
  const allowed = journal.state === "INTENT_RECORDED"
    ? ["CHILD_FAILED", "APPLIED_PENDING_VERIFY"]
    : journal.state === "APPLIED_PENDING_VERIFY"
      ? ["CHILD_FAILED", "VERIFIED"]
      : [];
  if (!allowed.includes(next)) throw new Error("MIGRATION_JOURNAL_TRANSITION_INVALID");
  return {
    ...journal,
    state: next,
    code: next === "CHILD_FAILED"
      ? "MIGRATION_CHILD_FAILED_MAINTENANCE_REQUIRED"
      : next === "APPLIED_PENDING_VERIFY"
        ? "MIGRATION_APPLIED_VERIFICATION_REQUIRED"
        : "MIGRATION_APPLY_VERIFIED"
  };
}

function classify(snapshot: MigrationCatalogSnapshot, release: MigrationRelease): {
  classification: MigrationClassification;
  applyRequired: boolean;
  counts: MigrationTargetPlan["counts"];
  digests: MigrationTargetPlan["digests"];
  codes: string[];
} {
  const relationNames = sortedUnique(snapshot.relationNames, "MIGRATION_INSPECT_RELATION_INVALID");
  const typeNames = sortedUnique(snapshot.typeNames, "MIGRATION_INSPECT_TYPE_INVALID");
  const overlap = relationNames.filter((name) => release.managedRelations.includes(name));
  const unexpectedRelations = relationNames.filter((name) => !release.managedRelations.includes(name));
  const releaseByName = new Map(release.migrations.map((migration) => [migration.name, migration]));
  const failed = snapshot.history.filter((entry) => entry.state !== "APPLIED");
  const applied = snapshot.history.filter((entry) => entry.state === "APPLIED");
  const unknown = applied.filter((entry) => !releaseByName.has(entry.name));
  const checksumMismatch = applied.filter((entry) => releaseByName.get(entry.name)?.sqlSha256 !== entry.checksum);
  const appliedNames = applied.map((entry) => entry.name);
  const prefixMismatch = appliedNames.some((name, index) => release.migrations[index]?.name !== name);
  let classification: MigrationClassification;
  let applyRequired = false;
  const codes: string[] = [];

  if (!snapshot.migrationHistoryExists) {
    if (relationNames.length === 0 && typeNames.length === 0) {
      classification = "PRISTINE_EMPTY_SCHEMA_READY";
      applyRequired = true;
      codes.push("MIGRATION_PRISTINE_SCHEMA_READY");
    } else {
      classification = "LEGACY_COLLISION_BLOCKED";
      codes.push("LEGACY_COLLISION_BLOCKED");
    }
  } else if (failed.length > 0 || unknown.length > 0 || checksumMismatch.length > 0 || prefixMismatch ||
    applied.length > release.migrations.length || unexpectedRelations.length > 0 ||
    (applied.length === 0 && relationNames.length > 0)) {
    classification = "PARTIAL_OR_DRIFT_BLOCKED";
    codes.push("MIGRATION_PARTIAL_OR_DRIFT_BLOCKED");
  } else {
    classification = "MANAGED_EXACT_CHAIN_READY";
    applyRequired = applied.length < release.migrations.length;
    codes.push(applyRequired ? "MIGRATION_MANAGED_PENDING_READY" : "MIGRATION_ALREADY_APPLIED");
  }

  return {
    classification,
    applyRequired,
    counts: {
      relations: relationNames.length,
      types: typeNames.length,
      legacyOverlap: overlap.length,
      applied: applied.length,
      pending: Math.max(0, release.migrations.length - applied.length),
      failedOrRolledBack: failed.length,
      unknownHistory: unknown.length,
      unexpectedRelations: unexpectedRelations.length
    },
    digests: {
      catalogSha256: canonicalSha256({ relationNames, typeNames, history: snapshot.history }),
      legacyOverlapSha256: canonicalSha256(overlap),
      connectionSha256: canonicalSha256(snapshot.connection)
    },
    codes
  };
}

function validateSnapshot(snapshot: MigrationCatalogSnapshot): MigrationCatalogSnapshot {
  if (!snapshot || typeof snapshot !== "object") throw new Error("MIGRATION_INSPECT_RESPONSE_INVALID");
  if (!/^[a-f0-9]{64}$/u.test(snapshot.targetSha256)) throw new Error("MIGRATION_INSPECT_TARGET_SHA_INVALID");
  if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(snapshot.schema)) throw new Error("MIGRATION_INSPECT_SCHEMA_INVALID");
  if (typeof snapshot.migrationHistoryExists !== "boolean" || !Array.isArray(snapshot.history)) {
    throw new Error("MIGRATION_INSPECT_HISTORY_INVALID");
  }
  if (!snapshot.migrationHistoryExists && snapshot.history.length > 0) throw new Error("MIGRATION_INSPECT_HISTORY_INVALID");
  if (!snapshot.connection || typeof snapshot.connection !== "object") {
    throw new Error("MIGRATION_INSPECT_CONNECTION_INVALID");
  }
  const history = snapshot.history.map((entry) => {
    if (!/^\d{14}_[a-z0-9][a-z0-9_]{0,100}$/u.test(entry.name) || !/^[a-f0-9]{64}$/u.test(entry.checksum) ||
      !["APPLIED", "FAILED", "ROLLED_BACK"].includes(entry.state)) {
      throw new Error("MIGRATION_INSPECT_HISTORY_INVALID");
    }
    return { ...entry };
  });
  if (new Set(history.filter((entry) => entry.state === "APPLIED").map((entry) => entry.name)).size !==
    history.filter((entry) => entry.state === "APPLIED").length) {
    throw new Error("MIGRATION_INSPECT_HISTORY_DUPLICATE");
  }
  return {
    targetSha256: snapshot.targetSha256,
    schema: snapshot.schema,
    relationNames: sortedUnique(snapshot.relationNames, "MIGRATION_INSPECT_RELATION_INVALID"),
    typeNames: sortedUnique(snapshot.typeNames, "MIGRATION_INSPECT_TYPE_INVALID"),
    migrationHistoryExists: snapshot.migrationHistoryExists,
    history,
    connection: { ...snapshot.connection }
  };
}

function assertMigrationConnection(
  connection: MigrationCatalogSnapshot["connection"],
  target: CloudTargetBinding
): void {
  if (connection.currentUser !== target.database.expectedCurrentUser ||
    connection.database !== target.database.name || connection.schema !== target.database.schema ||
    connection.hasRequiredRole !== true || connection.tlsAuthorized !== true ||
    connection.tlsMode !== "verify-full" || connection.serverName !== target.database.tlsServerName) {
    throw new Error("MIGRATION_DB_CONNECTION_IDENTITY_MISMATCH");
  }
}

function sortedUnique(values: string[], code: string): string[] {
  if (!Array.isArray(values) || values.length > 100_000) throw new Error(code);
  const normalized = values.map((value) => {
    if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/u.test(value)) throw new Error(code);
    return value;
  }).sort((left, right) => left.localeCompare(right));
  if (new Set(normalized).size !== normalized.length) throw new Error(code);
  return normalized;
}

function assertMigrationDatabaseUrl(databaseUrl: string, target: CloudTargetBinding): void {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("MIGRATION_DATABASE_URL_INVALID");
  }
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new Error("MIGRATION_DATABASE_URL_INVALID");
  }
  let username: string;
  try {
    username = decodeURIComponent(parsed.username);
  } catch {
    throw new Error("MIGRATION_DATABASE_URL_INVALID");
  }
  if (parsed.hostname !== target.database.host || (parsed.port || "5432") !== "5432" ||
    parsed.pathname !== `/${target.database.name}` || username !== target.database.loginUser ||
    parsed.password.length < 1 || parsed.searchParams.getAll("schema").length !== 1 ||
    parsed.searchParams.get("schema") !== target.database.schema ||
    parsed.searchParams.getAll("sslmode").length !== 1 ||
    parsed.searchParams.get("sslmode") !== "verify-full" || parsed.hash) {
    throw new Error("MIGRATION_DATABASE_URL_TARGET_MISMATCH");
  }
}
