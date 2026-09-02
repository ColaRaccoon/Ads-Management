import { PrismaClient } from "@prisma/client";
import { asRecord, asStrictString, assertExactKeys, readProtectedJsonFile } from "../shared/strict-json";
import {
  assertTargetConfirmation,
  parseCloudTargetBinding,
  targetBindingSha256,
  type CloudTargetBinding
} from "../shared/target-binding";
import { validateMigrationRelease, type MigrationRelease } from "./release";
import {
  createPinnedMigrationChildPlan,
  createFileMigrationJournalStore,
  createHashingMigrationArtifactReader,
  createNodeMigrationChildAdapter,
  createPrismaMigrationCatalogInspector,
  executePinnedMigrationPlan,
  inspectMigrationTarget,
  type MigrationArtifactReader,
  type MigrationCatalogInspector,
  type MigrationChildAdapter,
  type MigrationJournalStore
} from "./runner";

export interface MigrationCliDependencies {
  inspector: MigrationCatalogInspector;
  now?: () => Date;
  writeOutput?: (value: string) => void;
  execution?: {
    databaseUrl: string;
    artifactReader?: MigrationArtifactReader;
    child?: MigrationChildAdapter;
    journal: MigrationJournalStore;
  };
}

export interface DirectMigrationCliFactories {
  createPrismaClient(databaseUrl: string): PrismaClient;
  createArtifactReader(): MigrationArtifactReader;
  createChild(): MigrationChildAdapter;
  createJournal(filePath: string): MigrationJournalStore;
}

export async function runDirectMigrationCli(
  argv: string[],
  factories: DirectMigrationCliFactories = defaultMigrationCliFactories(),
  writeOutput?: (value: string) => void,
  now = new Date(),
  environment: NodeJS.ProcessEnv = process.env
): Promise<number> {
  const args = parseMigrationCliArgs(argv);
  if (args.mode !== "INSPECT") assertCompleteConfirmation(args);
  const [target, release, rawRuntime] = await Promise.all([
    readProtectedJsonFile(args.targetPath) as Promise<CloudTargetBinding>,
    readProtectedJsonFile(args.releasePath) as Promise<MigrationRelease>,
    args.runtimeConfigPath ? readProtectedJsonFile(args.runtimeConfigPath) : Promise.resolve(undefined)
  ]);
  const parsedTarget = parseCloudTargetBinding(target, now);
  const parsedRelease = validateMigrationRelease(release);
  const runtime = rawRuntime === undefined
    ? parseDirectMigrationEnvironment(environment, parsedTarget, parsedRelease, args)
    : parseDirectMigrationRuntime(rawRuntime);
  assertDirectMigrationRuntimeBinding(runtime, parsedTarget, parsedRelease);
  assertDirectMigrationDatabaseUrl(runtime.databaseUrl, parsedTarget);
  if (args.mode !== "INSPECT") {
    assertTargetConfirmation(parsedTarget, {
      projectRef: args.confirmProjectRef!,
      releaseGitSha: args.confirmReleaseGitSha!,
      targetSha256: args.confirmTargetSha256!
    });
    if (parsedRelease.releaseId !== args.confirmReleaseId) {
      throw new Error("MIGRATION_CLI_RELEASE_CONFIRMATION_MISMATCH");
    }
  }

  const prisma = factories.createPrismaClient(runtime.databaseUrl);
  let journal: MigrationJournalStore | undefined;
  try {
    const inspector = createPrismaMigrationCatalogInspector({
      client: prisma,
      target: parsedTarget,
      confirmation: runtime.confirmation,
      credentialPurpose: args.mode === "EXECUTE" ? "MIGRATION_APPLY_DB" : "MIGRATION_INSPECT_DB",
      tls: {
        authorized: true,
        mode: "verify-full",
        serverName: parsedTarget.database.tlsServerName
      },
      now
    });
    if (args.mode === "EXECUTE") journal = factories.createJournal(runtime.journalPath);
    return await runLoadedMigrationCli(args, parsedTarget, parsedRelease, {
      inspector,
      now: () => now,
      writeOutput,
      execution: args.mode === "EXECUTE"
        ? {
            databaseUrl: runtime.databaseUrl,
            artifactReader: factories.createArtifactReader(),
            child: factories.createChild(),
            journal: journal!
          }
        : undefined
    });
  } finally {
    await journal?.close?.();
    await prisma.$disconnect();
  }
}

export async function runMigrationCli(argv: string[], dependencies: MigrationCliDependencies): Promise<number> {
  const args = parseMigrationCliArgs(argv);
  const [target, release] = await Promise.all([
    readProtectedJsonFile(args.targetPath) as Promise<CloudTargetBinding>,
    readProtectedJsonFile(args.releasePath) as Promise<MigrationRelease>
  ]);
  return runLoadedMigrationCli(args, target, release, dependencies);
}

async function runLoadedMigrationCli(
  args: ReturnType<typeof parseMigrationCliArgs>,
  target: CloudTargetBinding,
  release: MigrationRelease,
  dependencies: MigrationCliDependencies
): Promise<number> {
  const now = dependencies.now?.() ?? new Date();
  if (args.mode !== "INSPECT") {
    assertCompleteConfirmation(args);
    const parsedTarget = parseCloudTargetBinding(target, now);
    const parsedRelease = validateMigrationRelease(release);
    assertTargetConfirmation(parsedTarget, {
      projectRef: args.confirmProjectRef!,
      releaseGitSha: args.confirmReleaseGitSha!,
      targetSha256: args.confirmTargetSha256!
    });
    if (parsedRelease.releaseId !== args.confirmReleaseId) throw new Error("MIGRATION_CLI_RELEASE_CONFIRMATION_MISMATCH");
  }
  const plan = await inspectMigrationTarget(target, release, dependencies.inspector, now);
  const write = dependencies.writeOutput ?? ((value: string) => process.stdout.write(value));
  if (args.mode === "INSPECT") {
    write(`${JSON.stringify(plan)}\n`);
    return plan.classification.endsWith("_BLOCKED") ? 2 : 0;
  }
  assertCompleteConfirmation(args);
  const approval = {
    approved: true as const,
    planId: args.confirmPlanId!,
    releaseId: args.confirmReleaseId!,
    projectRef: args.confirmProjectRef!,
    releaseGitSha: args.confirmReleaseGitSha!,
    targetSha256: args.confirmTargetSha256!
  };
  if (args.mode === "EXECUTE") {
    if (!dependencies.execution) throw new Error("MIGRATION_CLI_EXECUTOR_REQUIRED");
    const result = await executePinnedMigrationPlan({
      target,
      release,
      plan,
      approval,
      databaseUrl: dependencies.execution.databaseUrl,
      artifactReader: dependencies.execution.artifactReader,
      child: dependencies.execution.child,
      journal: dependencies.execution.journal,
      postVerifyInspector: dependencies.inspector,
      now
    });
    write(`${JSON.stringify(result)}\n`);
    return 0;
  }
  const childPlan = createPinnedMigrationChildPlan({
    target,
    release,
    plan,
    approval,
    now
  });
  write(`${JSON.stringify(childPlan)}\n`);
  return 0;
}

export function parseMigrationCliArgs(argv: string[]): {
  mode: "INSPECT" | "PLAN_CHILD" | "EXECUTE";
  targetPath: string;
  releasePath: string;
  runtimeConfigPath?: string;
  confirmPlanId?: string;
  confirmReleaseId?: string;
  confirmProjectRef?: string;
  confirmReleaseGitSha?: string;
  confirmTargetSha256?: string;
} {
  let mode: "INSPECT" | "PLAN_CHILD" | "EXECUTE" = "INSPECT";
  let targetPath: string | undefined;
  let releasePath: string | undefined;
  let runtimeConfigPath: string | undefined;
  let confirmPlanId: string | undefined;
  let confirmReleaseId: string | undefined;
  let confirmProjectRef: string | undefined;
  let confirmReleaseGitSha: string | undefined;
  let confirmTargetSha256: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--plan-child") {
      mode = "PLAN_CHILD";
      continue;
    }
    if (argument === "--execute") {
      mode = "EXECUTE";
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error("MIGRATION_CLI_ARGUMENT_VALUE_REQUIRED");
    if (argument === "--target") targetPath = value;
    else if (argument === "--release") releasePath = value;
    else if (argument === "--runtime-config") runtimeConfigPath = value;
    else if (argument === "--confirm-plan") confirmPlanId = value;
    else if (argument === "--confirm-release-id") confirmReleaseId = value;
    else if (argument === "--confirm-project-ref") confirmProjectRef = value;
    else if (argument === "--confirm-release-sha") confirmReleaseGitSha = value;
    else if (argument === "--confirm-target") confirmTargetSha256 = value;
    else throw new Error("MIGRATION_CLI_ARGUMENT_UNKNOWN");
    index += 1;
  }
  if (!targetPath || !releasePath) throw new Error("MIGRATION_CLI_INPUT_REQUIRED");
  return {
    mode,
    targetPath,
    releasePath,
    runtimeConfigPath,
    confirmPlanId,
    confirmReleaseId,
    confirmProjectRef,
    confirmReleaseGitSha,
    confirmTargetSha256
  };
}

type DirectMigrationRuntime = {
  confirmation: { projectRef: string; releaseGitSha: string; targetSha256: string };
  releaseId: string;
  databaseUrl: string;
  journalPath: string;
};

function parseDirectMigrationRuntime(value: unknown): DirectMigrationRuntime {
  const input = asRecord(value, "MIGRATION_RUNTIME_CONFIG_OBJECT_REQUIRED");
  assertExactKeys(input, [
    "version", "projectRef", "releaseGitSha", "targetSha256", "releaseId", "databaseUrl", "journalPath"
  ], "MIGRATION_RUNTIME_CONFIG_KEYS_INVALID");
  if (input.version !== "migration-maintenance-runtime/v1") {
    throw new Error("MIGRATION_RUNTIME_CONFIG_VERSION_INVALID");
  }
  return {
    confirmation: {
      projectRef: asStrictString(input.projectRef, "MIGRATION_RUNTIME_PROJECT_REF_INVALID", /^[a-z]{20}$/u, 20),
      releaseGitSha: asStrictString(
        input.releaseGitSha,
        "MIGRATION_RUNTIME_RELEASE_SHA_INVALID",
        /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u,
        64
      ),
      targetSha256: asStrictString(
        input.targetSha256,
        "MIGRATION_RUNTIME_TARGET_SHA_INVALID",
        /^[a-f0-9]{64}$/u,
        64
      )
    },
    releaseId: asStrictString(input.releaseId, "MIGRATION_RUNTIME_RELEASE_ID_INVALID", /^[a-f0-9]{64}$/u, 64),
    databaseUrl: asStrictString(input.databaseUrl, "MIGRATION_RUNTIME_DATABASE_CREDENTIAL_INVALID", undefined, 8192),
    journalPath: asStrictString(input.journalPath, "MIGRATION_RUNTIME_JOURNAL_PATH_INVALID", undefined, 1024)
  };
}

function parseDirectMigrationEnvironment(
  environment: NodeJS.ProcessEnv,
  target: CloudTargetBinding,
  release: MigrationRelease,
  args: ReturnType<typeof parseMigrationCliArgs>
): DirectMigrationRuntime {
  const databaseUrl = asStrictString(
    environment.DATABASE_URL,
    "MIGRATION_RUNTIME_DATABASE_CREDENTIAL_INVALID",
    undefined,
    8192
  );
  const journalPath = args.mode === "EXECUTE"
    ? asStrictString(environment.MIGRATION_JOURNAL_FILE, "MIGRATION_RUNTIME_JOURNAL_PATH_INVALID", undefined, 1024)
    : "/dev/null";
  return {
    confirmation: args.mode === "INSPECT"
      ? {
          projectRef: target.projectRef,
          releaseGitSha: target.releaseGitSha,
          targetSha256: targetBindingSha256(target)
        }
      : {
          projectRef: args.confirmProjectRef!,
          releaseGitSha: args.confirmReleaseGitSha!,
          targetSha256: args.confirmTargetSha256!
        },
    releaseId: release.releaseId,
    databaseUrl,
    journalPath
  };
}

function assertDirectMigrationRuntimeBinding(
  runtime: DirectMigrationRuntime,
  target: CloudTargetBinding,
  release: MigrationRelease
): void {
  assertTargetConfirmation(target, runtime.confirmation);
  if (runtime.releaseId !== release.releaseId || runtime.confirmation.releaseGitSha !== release.releaseGitSha) {
    throw new Error("MIGRATION_RUNTIME_RELEASE_MISMATCH");
  }
}

function assertDirectMigrationDatabaseUrl(databaseUrl: string, target: CloudTargetBinding): void {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("MIGRATION_RUNTIME_DATABASE_CREDENTIAL_INVALID");
  }
  let username: string;
  try {
    username = decodeURIComponent(parsed.username);
  } catch {
    throw new Error("MIGRATION_RUNTIME_DATABASE_CREDENTIAL_INVALID");
  }
  if ((parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") ||
    parsed.hostname !== target.database.host || (parsed.port || "5432") !== "5432" ||
    parsed.pathname !== `/${target.database.name}` || username !== target.database.loginUser ||
    parsed.password.length < 1 || parsed.searchParams.getAll("schema").length !== 1 ||
    parsed.searchParams.get("schema") !== target.database.schema ||
    parsed.searchParams.getAll("sslmode").length !== 1 ||
    parsed.searchParams.get("sslmode") !== "verify-full" || parsed.hash) {
    throw new Error("MIGRATION_RUNTIME_DATABASE_TARGET_MISMATCH");
  }
}

function defaultMigrationCliFactories(): DirectMigrationCliFactories {
  return {
    createPrismaClient(databaseUrl) {
      return new PrismaClient({ datasourceUrl: databaseUrl });
    },
    createArtifactReader: createHashingMigrationArtifactReader,
    createChild: createNodeMigrationChildAdapter,
    createJournal: createFileMigrationJournalStore
  };
}

function assertCompleteConfirmation(args: ReturnType<typeof parseMigrationCliArgs>): void {
  if (!args.confirmPlanId || !args.confirmReleaseId || !args.confirmProjectRef ||
    !args.confirmReleaseGitSha || !args.confirmTargetSha256) {
    throw new Error("MIGRATION_CLI_APPLY_CONFIRMATION_INCOMPLETE");
  }
}

if (require.main === module) {
  void runDirectMigrationCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((failure) => {
    const code = failure instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/u.test(failure.message)
      ? failure.message
      : "MIGRATION_MAINTENANCE_RUNNER_FAILED";
    process.stderr.write(`${code}\n`);
    process.exitCode = 2;
  });
}
