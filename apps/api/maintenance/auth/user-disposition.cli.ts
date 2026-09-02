import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { PrismaClient } from "@prisma/client";
import { createClient } from "@supabase/supabase-js";
import {
  asRecord,
  asStrictString,
  assertExactKeys,
  readProtectedJsonFile
} from "../shared/strict-json";
import { assertTargetConfirmation, parseCloudTargetBinding, targetBindingSha256 } from "../shared/target-binding";
import {
  applyAuthDisposition,
  authDispositionManifestBinding,
  createBootstrapSuperAdminMaintenanceAdapter,
  createPrismaAuthDispositionStore,
  planAuthDisposition,
  type AuthDispositionAction,
  type AuthDispositionInput,
  type AuthDispositionStore,
  type BootstrapSuperAdminMaintenanceAdapter,
  type ProtectedManifestBindingKey
} from "./user-disposition";
import {
  BoundAuthMaintenanceProvider,
  createSupabaseAdminTransport,
  type AuthMaintenanceProvider,
  type SupabaseMaintenanceAdminClient
} from "./provider";

export interface UserDispositionCliDependencies {
  provider: AuthMaintenanceProvider;
  store: AuthDispositionStore;
  manifestBindingKey: ProtectedManifestBindingKey;
  bootstrapSuperAdmin?: BootstrapSuperAdminMaintenanceAdapter;
  now?: () => Date;
  writeOutput?: (value: string) => void;
}

export interface DirectAuthCliFactories {
  createSupabaseClient(origin: string, secret: string): SupabaseMaintenanceAdminClient;
  createPrismaClient(databaseUrl: string): PrismaClient;
  loadBootstrapSuperAdminModule(): unknown;
}

export async function runDirectUserDispositionCli(
  argv: string[],
  factories: DirectAuthCliFactories = defaultAuthCliFactories(),
  writeOutput?: (value: string) => void,
  now = new Date(),
  environment: NodeJS.ProcessEnv = process.env
): Promise<number> {
  const args = parseUserDispositionCliArgs(argv);
  if (!args.manifestBindingKeyFilePath) throw new Error("AUTH_CLI_MANIFEST_BINDING_KEY_FILE_REQUIRED");
  if (args.mode === "APPLY") assertCompleteApplyArgs(args);
  const [input, manifestBindingKey] = await Promise.all([
    readProtectedJsonFile(args.manifestPath) as Promise<AuthDispositionInput>,
    readProtectedManifestBindingKeyFile(args.manifestBindingKeyFilePath)
  ]);
  const runtime = parseDirectAuthEnvironment(environment);
  const binding = authDispositionManifestBinding(input, manifestBindingKey, now);
  const runtimeConfirmation = args.mode === "APPLY"
    ? {
        projectRef: args.confirmProjectRef!,
        releaseGitSha: args.confirmReleaseGitSha!,
        targetSha256: args.confirmTargetSha256!
      }
    : {
        projectRef: binding.target.projectRef,
        releaseGitSha: binding.target.releaseGitSha,
        targetSha256: targetBindingSha256(binding.target)
      };
  if (runtime.supabaseOrigin !== binding.target.supabaseOrigin) throw new Error("AUTH_RUNTIME_ORIGIN_MISMATCH");
  if (args.mode === "APPLY") {
    assertTargetConfirmation(binding.target, runtimeConfirmation);
    if (binding.manifestBinding.keyId !== args.confirmManifestBindingKeyId ||
      binding.manifestBinding.value !== args.confirmManifestHmacSha256) {
      throw new Error("AUTH_CLI_MANIFEST_CONFIRMATION_MISMATCH");
    }
  }
  assertDirectDatabaseUrl(runtime.databaseUrl, binding.target, now);
  const bootstrapServiceFactory = loadBootstrapSuperAdminServiceFactory(factories);
  const supabaseClient = factories.createSupabaseClient(runtime.supabaseOrigin, runtime.supabaseSecretKey);
  const transport = createSupabaseAdminTransport({
    target: binding.target,
    confirmation: runtimeConfirmation,
    credentialPurpose: "SUPABASE_AUTH_ADMIN",
    tls: {
      authorized: true,
      mode: "verify-full",
      serverName: new URL(binding.target.supabaseOrigin).hostname
    },
    client: supabaseClient,
    now
  });
  const provider = new BoundAuthMaintenanceProvider({
    projectRef: binding.target.projectRef,
    providerOrigin: binding.target.supabaseOrigin,
    transport
  });
  const prisma = factories.createPrismaClient(runtime.databaseUrl);
  try {
    const store = await createPrismaAuthDispositionStore({
      client: prisma,
      target: binding.target,
      confirmation: runtimeConfirmation,
      credentialPurpose: "AUTH_DISPOSITION_DB",
      tls: {
        authorized: true,
        mode: "verify-full",
        serverName: binding.target.database.tlsServerName
      },
      now
    });
    const bootstrapSuperAdmin = createBootstrapSuperAdminMaintenanceAdapter({
      store,
      provider,
      createService: bootstrapServiceFactory
    });
    return await runLoadedUserDispositionCli(args, input, {
      provider,
      store,
      bootstrapSuperAdmin,
      manifestBindingKey,
      now: () => now,
      writeOutput
    });
  } finally {
    await prisma.$disconnect();
  }
}

export async function runUserDispositionCli(
  argv: string[],
  dependencies: UserDispositionCliDependencies
): Promise<number> {
  const args = parseUserDispositionCliArgs(argv);
  if (args.mode === "APPLY") assertCompleteApplyArgs(args);
  const input = await readProtectedJsonFile(args.manifestPath) as AuthDispositionInput;
  return runLoadedUserDispositionCli(args, input, dependencies);
}

async function runLoadedUserDispositionCli(
  args: ReturnType<typeof parseUserDispositionCliArgs>,
  input: AuthDispositionInput,
  dependencies: UserDispositionCliDependencies
): Promise<number> {
  const now = dependencies.now?.() ?? new Date();
  if (args.mode === "APPLY") {
    const binding = authDispositionManifestBinding(input, dependencies.manifestBindingKey, now);
    assertTargetConfirmation(binding.target, {
      projectRef: args.confirmProjectRef!,
      releaseGitSha: args.confirmReleaseGitSha!,
      targetSha256: args.confirmTargetSha256!
    });
    if (binding.manifestBinding.keyId !== args.confirmManifestBindingKeyId ||
      binding.manifestBinding.value !== args.confirmManifestHmacSha256) {
      throw new Error("AUTH_CLI_MANIFEST_CONFIRMATION_MISMATCH");
    }
  }
  const plan = await planAuthDisposition(input, dependencies, now);
  const write = dependencies.writeOutput ?? ((value: string) => process.stdout.write(value));
  if (args.mode === "PLAN") {
    write(`${JSON.stringify(plan)}\n`);
    return plan.counts.blocked === 0 ? 0 : 2;
  }
  assertCompleteApplyArgs(args);
  const result = await applyAuthDisposition(input, dependencies, {
    approved: true,
    action: args.action!,
    planId: args.confirmPlanId!,
    projectRef: args.confirmProjectRef!,
    releaseGitSha: args.confirmReleaseGitSha!,
    targetSha256: args.confirmTargetSha256!,
    manifestHmacSha256: args.confirmManifestHmacSha256!,
    manifestBindingKeyId: args.confirmManifestBindingKeyId!
  }, plan, now);
  if (targetBindingSha256(input.target) !== result.targetSha256) throw new Error("AUTH_CLI_TARGET_MISMATCH");
  write(`${JSON.stringify(result)}\n`);
  return result.counts.partial === 0 ? 0 : 3;
}

function assertCompleteApplyArgs(args: ReturnType<typeof parseUserDispositionCliArgs>): void {
  if (!args.action || !args.confirmPlanId || !args.confirmProjectRef || !args.confirmReleaseGitSha ||
    !args.confirmTargetSha256 || !args.confirmManifestHmacSha256 || !args.confirmManifestBindingKeyId) {
    throw new Error("AUTH_CLI_APPLY_CONFIRMATION_INCOMPLETE");
  }
}

export function parseUserDispositionCliArgs(argv: string[]): {
  mode: "PLAN" | "APPLY";
  manifestPath: string;
  manifestBindingKeyFilePath?: string;
  action?: AuthDispositionAction;
  confirmPlanId?: string;
  confirmProjectRef?: string;
  confirmReleaseGitSha?: string;
  confirmTargetSha256?: string;
  confirmManifestHmacSha256?: string;
  confirmManifestBindingKeyId?: string;
} {
  let mode: "PLAN" | "APPLY" = "PLAN";
  let manifestPath: string | undefined;
  let manifestBindingKeyFilePath: string | undefined;
  let action: AuthDispositionAction | undefined;
  let confirmPlanId: string | undefined;
  let confirmProjectRef: string | undefined;
  let confirmReleaseGitSha: string | undefined;
  let confirmTargetSha256: string | undefined;
  let confirmManifestHmacSha256: string | undefined;
  let confirmManifestBindingKeyId: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") {
      mode = "APPLY";
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error("AUTH_CLI_ARGUMENT_VALUE_REQUIRED");
    if (argument === "--manifest") manifestPath = value;
    else if (argument === "--manifest-binding-key-file") manifestBindingKeyFilePath = value;
    else if (argument === "--action") action = parseAction(value);
    else if (argument === "--confirm-plan") confirmPlanId = value;
    else if (argument === "--confirm-project-ref") confirmProjectRef = value;
    else if (argument === "--confirm-release") confirmReleaseGitSha = value;
    else if (argument === "--confirm-target") confirmTargetSha256 = value;
    else if (argument === "--confirm-manifest-hmac") confirmManifestHmacSha256 = value;
    else if (argument === "--confirm-binding-key-id") confirmManifestBindingKeyId = value;
    else throw new Error("AUTH_CLI_ARGUMENT_UNKNOWN");
    index += 1;
  }
  if (!manifestPath) throw new Error("AUTH_CLI_MANIFEST_REQUIRED");
  return {
    mode,
    manifestPath,
    manifestBindingKeyFilePath,
    action,
    confirmPlanId,
    confirmProjectRef,
    confirmReleaseGitSha,
    confirmTargetSha256,
    confirmManifestHmacSha256,
    confirmManifestBindingKeyId
  };
}

function parseAction(value: string): AuthDispositionAction {
  if (!["KEEP", "BOOTSTRAP_SUPER_ADMIN", "LINK", "RE_INVITE", "DISABLE"].includes(value)) {
    throw new Error("AUTH_CLI_ACTION_INVALID");
  }
  return value as AuthDispositionAction;
}

type DirectAuthRuntime = {
  supabaseOrigin: string;
  supabaseSecretKey: string;
  databaseUrl: string;
};

function parseDirectAuthEnvironment(environment: NodeJS.ProcessEnv): DirectAuthRuntime {
  return {
    supabaseOrigin: asStrictString(environment.SUPABASE_URL, "AUTH_RUNTIME_ORIGIN_INVALID", undefined, 128),
    supabaseSecretKey: asStrictString(
      environment.SUPABASE_SECRET_KEY,
      "AUTH_RUNTIME_PROVIDER_CREDENTIAL_INVALID",
      undefined,
      8192
    ),
    databaseUrl: asStrictString(environment.DATABASE_URL, "AUTH_RUNTIME_DATABASE_CREDENTIAL_INVALID", undefined, 8192)
  };
}

async function readProtectedManifestBindingKeyFile(filePath: string): Promise<ProtectedManifestBindingKey> {
  if (!filePath || filePath.includes("\0")) throw new Error("AUTH_BINDING_KEY_PATH_INVALID");
  const pathMetadata = await lstat(filePath);
  if (pathMetadata.isSymbolicLink() || !pathMetadata.isFile() || pathMetadata.size < 2 || pathMetadata.size > 4096) {
    throw new Error("AUTH_BINDING_KEY_FILE_INVALID");
  }
  assertBindingKeyFilePermissions(pathMetadata.mode);
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | noFollow);
    const before = await handle.stat();
    assertSameBindingKeyFile(pathMetadata, before);
    assertBindingKeyFilePermissions(before.mode);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    assertSameBindingKeyFile(before, after);
    assertBindingKeyFilePermissions(after.mode);
    if (bytes.byteLength !== before.size || bytes.byteLength !== after.size) {
      throw new Error("AUTH_BINDING_KEY_FILE_CHANGED");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error("AUTH_BINDING_KEY_FILE_PARSE_FAILED");
    }
    return parseProtectedManifestBindingKey(parsed);
  } catch (failure) {
    if (failure instanceof Error && failure.message.startsWith("AUTH_BINDING_KEY_")) throw failure;
    throw new Error("AUTH_BINDING_KEY_FILE_INVALID");
  } finally {
    await handle?.close();
  }
}

function parseProtectedManifestBindingKey(value: unknown): ProtectedManifestBindingKey {
  const input = asRecord(value, "AUTH_BINDING_KEY_OBJECT_REQUIRED");
  assertExactKeys(input, ["version", "keyId", "keyBase64"], "AUTH_BINDING_KEY_KEYS_INVALID");
  if (input.version !== "auth-manifest-binding-key/v1") throw new Error("AUTH_BINDING_KEY_VERSION_INVALID");
  const keyId = asStrictString(
    input.keyId,
    "AUTH_BINDING_KEY_ID_INVALID",
    /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u,
    128
  );
  const encodedKey = asStrictString(
    input.keyBase64,
    "AUTH_BINDING_KEY_MATERIAL_INVALID",
    /^[A-Za-z0-9+/]+={0,2}$/u,
    256
  );
  const key = Buffer.from(encodedKey, "base64");
  if (key.byteLength < 32 || key.byteLength > 128 || key.toString("base64") !== encodedKey) {
    throw new Error("AUTH_BINDING_KEY_MATERIAL_INVALID");
  }
  return { keyId, key };
}

function assertBindingKeyFilePermissions(mode: number): void {
  if (process.platform !== "win32" && ((mode & 0o400) === 0 || (mode & 0o077) !== 0)) {
    throw new Error("AUTH_BINDING_KEY_FILE_PERMISSIONS_INVALID");
  }
}

function assertSameBindingKeyFile(
  expected: { dev: number; ino: number; size: number; mtimeMs: number },
  actual: { dev: number; ino: number; size: number; mtimeMs: number }
): void {
  if (expected.dev !== actual.dev || expected.ino !== actual.ino || expected.size !== actual.size ||
    expected.mtimeMs !== actual.mtimeMs) {
    throw new Error("AUTH_BINDING_KEY_FILE_CHANGED");
  }
}

function assertDirectDatabaseUrl(databaseUrl: string, rawTarget: AuthDispositionInput["target"], now: Date): void {
  const target = parseCloudTargetBinding(rawTarget, now);
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("AUTH_RUNTIME_DATABASE_CREDENTIAL_INVALID");
  }
  let username: string;
  try {
    username = decodeURIComponent(parsed.username);
  } catch {
    throw new Error("AUTH_RUNTIME_DATABASE_CREDENTIAL_INVALID");
  }
  if ((parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") ||
    parsed.hostname !== target.database.host || (parsed.port || "5432") !== "5432" ||
    parsed.pathname !== `/${target.database.name}` || username !== target.database.loginUser ||
    parsed.password.length < 1 || parsed.searchParams.getAll("schema").length !== 1 ||
    parsed.searchParams.get("schema") !== target.database.schema ||
    parsed.searchParams.getAll("sslmode").length !== 1 ||
    parsed.searchParams.get("sslmode") !== "verify-full" || parsed.hash) {
    throw new Error("AUTH_RUNTIME_DATABASE_TARGET_MISMATCH");
  }
}

function defaultAuthCliFactories(): DirectAuthCliFactories {
  return {
    createSupabaseClient(origin, secret) {
      return createClient(origin, secret, {
        auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false }
      }) as unknown as SupabaseMaintenanceAdminClient;
    },
    createPrismaClient(databaseUrl) {
      return new PrismaClient({ datasourceUrl: databaseUrl });
    },
    loadBootstrapSuperAdminModule() {
      return require("../runtime-auth/bootstrap-super-admin.js");
    }
  };
}

type BootstrapSuperAdminServiceConstructor = new (
  prisma: unknown,
  provider: { getUserById(userId: string): Promise<{ id: string; email: string; emailVerified: boolean }> }
) => {
  run(input: { authUserId: string; email: string; dryRun: boolean }): Promise<{
    action: "create" | "update" | "unchanged";
  }>;
};

function loadBootstrapSuperAdminServiceFactory(factories: DirectAuthCliFactories) {
  let loaded: unknown;
  try {
    loaded = factories.loadBootstrapSuperAdminModule();
  } catch {
    throw new Error("AUTH_BOOTSTRAP_RUNTIME_MODULE_MISSING");
  }
  const module = asRecord(loaded, "AUTH_BOOTSTRAP_RUNTIME_MODULE_INVALID");
  const Service = module.BootstrapSuperAdminService;
  if (typeof Service !== "function" || Service.name !== "BootstrapSuperAdminService" ||
    typeof Service.prototype?.run !== "function") {
    throw new Error("AUTH_BOOTSTRAP_RUNTIME_MODULE_INVALID");
  }
  const Constructor = Service as BootstrapSuperAdminServiceConstructor;
  return (
    prisma: unknown,
    provider: { getUserById(userId: string): Promise<{ id: string; email: string; emailVerified: boolean }> }
  ) => new Constructor(prisma, provider);
}

if (require.main === module) {
  void runDirectUserDispositionCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((failure) => {
    const code = failure instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/u.test(failure.message)
      ? failure.message
      : "AUTH_MAINTENANCE_RUNNER_FAILED";
    process.stderr.write(`${code}\n`);
    process.exitCode = 2;
  });
}
