import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BootstrapSuperAdminService } from "../../src/auth/bootstrap-super-admin";
import { targetBindingSha256, type CloudTargetBinding } from "../shared/target-binding";
import type { AuthMaintenanceProvider } from "./provider";
import { parseUserDispositionCliArgs, runDirectUserDispositionCli } from "./user-disposition.cli";
import {
  applyAuthDisposition,
  createBootstrapSuperAdminMaintenanceAdapter,
  createPrismaAuthDispositionStore,
  planAuthDisposition,
  type AppUserSnapshot,
  type AuthDispositionAction,
  type AuthDispositionEntry,
  type AuthDispositionInput,
  type AuthDispositionPlan,
  type AuthDispositionStore,
  type BootstrapSuperAdminMaintenanceAdapter
} from "./user-disposition";

const projectRef = "iygjmosbelbosfxidqxv";
const releaseGitSha = "d0dd9081159a9acad24df458ca14b9f05bdc115a";
const appUserId = "22222222-2222-4222-8222-222222222222";
const providerUserId = "11111111-1111-4111-8111-111111111111";

describe("planAuthDisposition", () => {
  it("defaults to a read-only plan and emits no identity material", async () => {
    const store = storeFake(snapshot({ providerUserId: null }));
    const provider = providerFake();
    const plan = await planAuthDisposition(manifest(entry({ action: "LINK" })), dependencies(provider, store), clock());

    expect(plan.mode).toBe("DRY_RUN");
    expect(plan.entries).toEqual([{
      entryId: "entry-link-001",
      action: "LINK",
      outcome: "READY",
      code: "AUTH_LINK_READY"
    }]);
    expect(store.applyAtomic).not.toHaveBeenCalled();
    expect(store.claimReinvite).not.toHaveBeenCalled();
    const serialized = JSON.stringify(plan);
    expect(serialized).not.toContain("admin@example.com");
    expect(serialized).not.toContain(providerUserId);
    expect(serialized).not.toContain(appUserId);
  });

  it("fails closed before inspection when the provider binding differs", async () => {
    const provider = providerFake();
    Object.defineProperty(provider, "projectRef", { value: "abcdefghijklmnopqrst" });
    const store = storeFake(snapshot({ providerUserId: null }));
    await expect(planAuthDisposition(manifest(entry({ action: "LINK" })), dependencies(provider, store), clock()))
      .rejects.toThrow("AUTH_PROVIDER_TARGET_MISMATCH");
    expect(store.inspectUser).not.toHaveBeenCalled();
  });

  it("blocks subject/email conflicts without attempting a mutation", async () => {
    const store = storeFake(snapshot({ providerUserId: null }));
    const provider = providerFake();
    provider.findUserByEmail = vi.fn().mockResolvedValue(providerUser({
      id: "33333333-3333-4333-8333-333333333333"
    }));
    const plan = await planAuthDisposition(manifest(entry({ action: "LINK" })), dependencies(provider, store), clock());
    expect(plan.entries[0]).toMatchObject({
      outcome: "BLOCKED",
      code: "AUTH_PROVIDER_IDENTITY_CONFLICT"
    });
    expect(store.applyAtomic).not.toHaveBeenCalled();
  });

  it("rejects unknown manifest fields instead of silently accepting them", async () => {
    const input = { ...manifest(entry()), unexpectedSecret: "must-not-be-accepted" };
    await expect(planAuthDisposition(
      input as never,
      dependencies(providerFake(), storeFake(snapshot())),
      clock()
    )).rejects.toThrow("AUTH_MANIFEST_KEYS_INVALID");
  });

  it("redacts store failures before they cross the maintenance boundary", async () => {
    const store = storeFake(null);
    store.inspectUser = vi.fn().mockRejectedValue(new Error("admin@example.com password detail"));
    await expect(planAuthDisposition(manifest(entry()), dependencies(providerFake(), store), clock()))
      .rejects.toThrow("AUTH_STORE_INSPECTION_FAILED");
  });

  it("accepts GUEST dispositions but restricts BOOTSTRAP_SUPER_ADMIN to the exact desired state", async () => {
    const guestInput = manifest(entry({ action: "LINK", desiredRole: "GUEST" }));
    await expect(planAuthDisposition(
      guestInput,
      dependencies(providerFake(), storeFake(snapshot({ providerUserId: null }))),
      clock()
    )).resolves.toMatchObject({ counts: { ready: 1 } });
    const invalidBootstrap = manifest(entry({
      action: "BOOTSTRAP_SUPER_ADMIN",
      appUserId: null,
      expectedAuthzVersion: null,
      expectedLinkedProviderUserId: null,
      desiredRole: "ADMIN"
    }));
    await expect(planAuthDisposition(
      invalidBootstrap,
      dependencies(providerFake(), storeFake(null)),
      clock()
    )).rejects.toThrow("AUTH_BOOTSTRAP_SUPER_ADMIN_DESIRED_STATE_INVALID");
  });

  it("treats KEEP as exact-state UNCHANGED and blocks any mismatch without mutation", async () => {
    const exactInput = manifest(entry({ action: "KEEP" }));
    const exactStore = storeFake(snapshot());
    const exactPlan = await planAuthDisposition(exactInput, dependencies(providerFake(), exactStore), clock());
    expect(exactPlan.entries[0]).toMatchObject({
      outcome: "UNCHANGED",
      code: "AUTH_KEEP_EXACT_STATE_UNCHANGED"
    });
    const mismatchStore = storeFake(snapshot({ role: "ADMIN" }));
    const mismatchPlan = await planAuthDisposition(exactInput, dependencies(providerFake(), mismatchStore), clock());
    expect(mismatchPlan.entries[0]).toMatchObject({
      outcome: "BLOCKED",
      code: "AUTH_KEEP_EXACT_STATE_MISMATCH"
    });
    expect(exactStore.applyAtomic).not.toHaveBeenCalled();
    expect(mismatchStore.applyAtomic).not.toHaveBeenCalled();
  });
});

describe("user disposition CLI contract", () => {
  it("is plan-only by default and rejects unknown execution switches", () => {
    expect(parseUserDispositionCliArgs(["--manifest", "protected.json"])).toMatchObject({ mode: "PLAN" });
    expect(() => parseUserDispositionCliArgs(["--execute", "yes", "--manifest", "protected.json"]))
      .toThrow("AUTH_CLI_ARGUMENT_UNKNOWN");
  });

  it("directly composes protected runtime credentials with concrete clients", async () => {
    const directory = await mkdtemp(join(tmpdir(), "auth-direct-cli-"));
    try {
      const manifestPath = join(directory, "manifest.json");
      const bindingKeyPath = join(directory, "binding-key.json");
      const input = manifest(entry({ action: "LINK" }));
      await writeFile(manifestPath, JSON.stringify(input), { mode: 0o600 });
      const bindingKeyBase64 = Buffer.alloc(32, 0x42).toString("base64");
      await writeFile(bindingKeyPath, JSON.stringify({
        version: "auth-manifest-binding-key/v1",
        keyId: "auth-binding-key-001",
        keyBase64: bindingKeyBase64
      }), { mode: 0o600 });
      const user = {
        id: providerUserId,
        email: "admin@example.com",
        email_confirmed_at: "2026-09-02T00:00:00.000Z",
        banned_until: null,
        user_metadata: {}
      };
      const supabase = {
        auth: { admin: {
          getUserById: vi.fn().mockResolvedValue({ data: { user }, error: null }),
          listUsers: vi.fn().mockResolvedValue({ data: { users: [user], lastPage: 1 }, error: null }),
          inviteUserByEmail: vi.fn(),
          updateUserById: vi.fn(),
          deleteUser: vi.fn()
        } }
      };
      const current = {
        id: appUserId,
        normalizedEmail: "admin@example.com",
        authUserId: null,
        role: "SUPER_ADMIN",
        isActive: true,
        authzVersion: 7
      };
      const prisma: any = {
        $queryRaw: vi.fn().mockResolvedValue([{
          current_user: "auth_maintenance",
          current_database: "postgres",
          current_schema: "public",
          has_required_role: true
        }]),
        appUser: {
          findUnique: vi.fn().mockResolvedValue(current),
          count: vi.fn().mockResolvedValue(2)
        },
        $disconnect: vi.fn().mockResolvedValue(undefined)
      };
      const outputs: string[] = [];
      const environment = {
        SUPABASE_URL: input.target.supabaseOrigin,
        SUPABASE_SECRET_KEY: ["test", "provider", "credential"].join("-"),
        DATABASE_URL: databaseUrl("auth_maintenance")
      };
      await expect(runDirectUserDispositionCli([
        "--manifest", manifestPath,
        "--manifest-binding-key-file", bindingKeyPath
      ], {
        createSupabaseClient: vi.fn().mockReturnValue(supabase),
        createPrismaClient: vi.fn().mockReturnValue(prisma),
        loadBootstrapSuperAdminModule: vi.fn().mockReturnValue({ BootstrapSuperAdminService })
      }, (value) => outputs.push(value), clock(), environment)).resolves.toBe(0);
      expect(JSON.parse(outputs[0])).toMatchObject({ mode: "DRY_RUN", counts: { ready: 1 } });
      expect(outputs[0]).not.toContain(bindingKeyBase64);
      expect(outputs[0]).not.toContain(environment.SUPABASE_SECRET_KEY);
      expect(outputs[0]).not.toContain(environment.DATABASE_URL);
      expect(prisma.$disconnect).toHaveBeenCalledOnce();
      expect(supabase.auth.admin.getUserById).toHaveBeenCalledOnce();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("direct APPLY instantiates the actual BootstrapSuperAdminService and preserves locks, transaction, revoke, and audit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "auth-direct-bootstrap-"));
    try {
      const manifestPath = join(directory, "manifest.json");
      const bindingKeyPath = join(directory, "binding-key.json");
      const input = manifest(entry({
        action: "BOOTSTRAP_SUPER_ADMIN",
        appUserId: null,
        expectedLinkedProviderUserId: null,
        expectedAuthzVersion: null,
        desiredRole: "SUPER_ADMIN",
        desiredActive: true
      }));
      const expectedPlan = await planAuthDisposition(
        input,
        dependencies(providerFake(), storeFake(null)),
        clock()
      );
      await Promise.all([
        writeFile(manifestPath, JSON.stringify(input), { mode: 0o600 }),
        writeFile(bindingKeyPath, JSON.stringify({
          version: "auth-manifest-binding-key/v1",
          keyId: expectedPlan.manifestBinding.keyId,
          keyBase64: Buffer.alloc(32, 0x42).toString("base64")
        }), { mode: 0o600 })
      ]);
      const providerAdminUser = {
        id: providerUserId,
        email: "admin@example.com",
        email_confirmed_at: "2026-09-02T00:00:00.000Z",
        banned_until: null,
        user_metadata: {}
      };
      const providerMutations = {
        inviteUserByEmail: vi.fn(),
        updateUserById: vi.fn(),
        deleteUser: vi.fn()
      };
      const supabase = {
        auth: { admin: {
          getUserById: vi.fn().mockResolvedValue({ data: { user: providerAdminUser }, error: null }),
          listUsers: vi.fn().mockResolvedValue({
            data: { users: [providerAdminUser], lastPage: 1 },
            error: null
          }),
          ...providerMutations
        } }
      };
      let persisted: any = null;
      const appUser = {
        findUnique: vi.fn(async ({ where }: any) => {
          if (!persisted) return null;
          if (where.id === persisted.id || where.authUserId === persisted.authUserId ||
            where.normalizedEmail === persisted.normalizedEmail) return persisted;
          return null;
        }),
        count: vi.fn().mockImplementation(async () => persisted ? 1 : 0),
        create: vi.fn(async ({ data }: any) => {
          persisted = { id: appUserId, authzVersion: 0, ...data };
          return persisted;
        }),
        update: vi.fn()
      };
      const prisma: any = {
        $queryRaw: vi.fn()
          .mockResolvedValueOnce([{
            current_user: "auth_maintenance",
            current_database: "postgres",
            current_schema: "public",
            has_required_role: true
          }])
          .mockResolvedValue([]),
        appUser,
        appAuthSession: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        securityAuditEvent: { create: vi.fn().mockResolvedValue({}) },
        $transaction: vi.fn(async (callback: (tx: any) => unknown) => callback(prisma)),
        $disconnect: vi.fn().mockResolvedValue(undefined)
      };
      const loadBootstrapSuperAdminModule = vi.fn().mockReturnValue({ BootstrapSuperAdminService });
      const bootstrapRun = vi.spyOn(BootstrapSuperAdminService.prototype, "run");
      const outputs: string[] = [];
      await expect(runDirectUserDispositionCli([
        "--apply",
        "--manifest", manifestPath,
        "--manifest-binding-key-file", bindingKeyPath,
        "--action", "BOOTSTRAP_SUPER_ADMIN",
        "--confirm-plan", expectedPlan.planId,
        "--confirm-project-ref", projectRef,
        "--confirm-release", releaseGitSha,
        "--confirm-target", targetBindingSha256(input.target),
        "--confirm-manifest-hmac", expectedPlan.manifestBinding.value,
        "--confirm-binding-key-id", expectedPlan.manifestBinding.keyId
      ], {
        createSupabaseClient: vi.fn().mockReturnValue(supabase),
        createPrismaClient: vi.fn().mockReturnValue(prisma),
        loadBootstrapSuperAdminModule
      }, (value) => outputs.push(value), clock(), {
        SUPABASE_URL: input.target.supabaseOrigin,
        SUPABASE_SECRET_KEY: ["test", "provider", "credential"].join("-"),
        DATABASE_URL: databaseUrl("auth_maintenance")
      })).resolves.toBe(0);
      expect(loadBootstrapSuperAdminModule).toHaveBeenCalledOnce();
      expect(bootstrapRun).toHaveBeenCalledWith({
        authUserId: providerUserId,
        email: "admin@example.com",
        dryRun: false
      });
      expect(JSON.parse(outputs[0])).toMatchObject({ mode: "APPLY", counts: { applied: 1 } });
      expect(appUser.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ role: "SUPER_ADMIN", inviteStatus: "ACTIVE", isActive: true })
      }));
      expect(prisma.$transaction).toHaveBeenCalledOnce();
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(3);
      expect(prisma.appAuthSession.updateMany).toHaveBeenCalledOnce();
      expect(prisma.securityAuditEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          actorType: "SYSTEM",
          action: "AUTH_DISPOSITION_BOOTSTRAP_SUPER_ADMIN",
          result: "SUCCESS"
        })
      });
      expect(providerMutations.inviteUserByEmail).not.toHaveBeenCalled();
      expect(providerMutations.updateUserById).not.toHaveBeenCalled();
      expect(providerMutations.deleteUser).not.toHaveBeenCalled();
      bootstrapRun.mockRestore();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed on a missing or wrong bootstrap runtime module before provider or DB clients exist", async () => {
    const directory = await mkdtemp(join(tmpdir(), "auth-direct-module-"));
    try {
      const manifestPath = join(directory, "manifest.json");
      const bindingKeyPath = join(directory, "binding-key.json");
      const input = manifest(entry({ action: "LINK" }));
      await Promise.all([
        writeFile(manifestPath, JSON.stringify(input), { mode: 0o600 }),
        writeFile(bindingKeyPath, JSON.stringify({
          version: "auth-manifest-binding-key/v1",
          keyId: "auth-binding-key-001",
          keyBase64: Buffer.alloc(32, 0x42).toString("base64")
        }), { mode: 0o600 })
      ]);
      for (const loadBootstrapSuperAdminModule of [
        vi.fn(() => { throw new Error("local path detail"); }),
        vi.fn().mockReturnValue({ BootstrapSuperAdminService: class WrongService {} })
      ]) {
        const createSupabaseClient = vi.fn();
        const createPrismaClient = vi.fn();
        await expect(runDirectUserDispositionCli([
          "--manifest", manifestPath,
          "--manifest-binding-key-file", bindingKeyPath
        ], {
          createSupabaseClient,
          createPrismaClient,
          loadBootstrapSuperAdminModule
        }, undefined, clock(), {
          SUPABASE_URL: input.target.supabaseOrigin,
          SUPABASE_SECRET_KEY: ["test", "provider", "credential"].join("-"),
          DATABASE_URL: databaseUrl("auth_maintenance")
        })).rejects.toThrow(/AUTH_BOOTSTRAP_RUNTIME_MODULE_(?:MISSING|INVALID)/u);
        expect(createSupabaseClient).not.toHaveBeenCalled();
        expect(createPrismaClient).not.toHaveBeenCalled();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("the production class seam preserves UUID rejection before provider lookup", async () => {
    const provider = { getUserById: vi.fn() };
    const prisma = { appUser: { findUnique: vi.fn() }, $transaction: vi.fn() };
    const service = new BootstrapSuperAdminService(prisma as never, provider as never);
    await expect(service.run({
      authUserId: "provider-user-invalid-001",
      email: "admin@example.com",
      dryRun: false
    })).rejects.toThrow("BOOTSTRAP_INVALID_AUTH_USER_ID");
    expect(provider.getUserById).not.toHaveBeenCalled();
    expect(prisma.appUser.findUnique).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("the production class seam preserves subject/email conflict detection before transaction", async () => {
    const provider = { getUserById: vi.fn().mockResolvedValue(providerUser()) };
    const bySubject = {
      id: appUserId,
      authUserId: providerUserId,
      normalizedEmail: "admin@example.com"
    };
    const byEmail = {
      id: "33333333-3333-4333-8333-333333333333",
      authUserId: null,
      normalizedEmail: "admin@example.com"
    };
    const prisma = {
      appUser: {
        findUnique: vi.fn(async ({ where }: any) => where.authUserId ? bySubject : byEmail)
      },
      $transaction: vi.fn()
    };
    const service = new BootstrapSuperAdminService(prisma as never, provider as never);
    await expect(service.run({
      authUserId: providerUserId,
      email: "admin@example.com",
      dryRun: false
    })).rejects.toThrow("BOOTSTRAP_IDENTITY_ALREADY_LINKED");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("rejects a direct apply HMAC substitution before constructing provider or database clients", async () => {
    const directory = await mkdtemp(join(tmpdir(), "auth-direct-binding-"));
    try {
      const manifestPath = join(directory, "manifest.json");
      const bindingKeyPath = join(directory, "binding-key.json");
      const input = manifest(entry({ action: "LINK" }));
      await Promise.all([
        writeFile(manifestPath, JSON.stringify(input), { mode: 0o600 }),
        writeFile(bindingKeyPath, JSON.stringify({
          version: "auth-manifest-binding-key/v1",
          keyId: "auth-binding-key-001",
          keyBase64: Buffer.alloc(32, 0x42).toString("base64")
        }), { mode: 0o600 })
      ]);
      const createSupabaseClient = vi.fn();
      const createPrismaClient = vi.fn();
      await expect(runDirectUserDispositionCli([
        "--apply",
        "--manifest", manifestPath,
        "--manifest-binding-key-file", bindingKeyPath,
        "--action", "LINK",
        "--confirm-plan", "a".repeat(64),
        "--confirm-project-ref", projectRef,
        "--confirm-release", releaseGitSha,
        "--confirm-target", targetBindingSha256(input.target),
        "--confirm-manifest-hmac", "f".repeat(64),
        "--confirm-binding-key-id", "auth-binding-key-001"
      ], {
        createSupabaseClient,
        createPrismaClient,
        loadBootstrapSuperAdminModule: vi.fn().mockReturnValue({ BootstrapSuperAdminService })
      }, undefined, clock(), {
        SUPABASE_URL: input.target.supabaseOrigin,
        SUPABASE_SECRET_KEY: ["test", "provider", "credential"].join("-"),
        DATABASE_URL: databaseUrl("auth_maintenance")
      })).rejects.toThrow("AUTH_CLI_MANIFEST_CONFIRMATION_MISMATCH");
      expect(createSupabaseClient).not.toHaveBeenCalled();
      expect(createPrismaClient).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("concrete Prisma AuthDispositionStore factory", () => {
  it("performs zero DB I/O until target/TLS/role confirmation is exact", async () => {
    const client = { $queryRaw: vi.fn() };
    await expect(createPrismaAuthDispositionStore({
      client: client as never,
      target: target(),
      confirmation: { projectRef, releaseGitSha, targetSha256: "f".repeat(64) },
      credentialPurpose: "AUTH_DISPOSITION_DB",
      tls: { authorized: true, mode: "verify-full", serverName: `db.${projectRef}.supabase.co` },
      now: clock()
    })).rejects.toThrow("CONFIRM_TARGET_SHA_MISMATCH");
    expect(client.$queryRaw).not.toHaveBeenCalled();
  });

  it("acquires both locks, CAS-updates, revokes sessions, and writes a SYSTEM audit", async () => {
    const current = {
      id: appUserId,
      normalizedEmail: "admin@example.com",
      authUserId: null,
      role: "ADMIN",
      isActive: true,
      authzVersion: 7,
      invitationRequestId: null,
      inviteStatus: "ACTIVE"
    };
    const appUser = {
      findUnique: vi.fn(async ({ where }: any) =>
        where.id === appUserId || where.normalizedEmail === "admin@example.com" ? current : null),
      count: vi.fn().mockResolvedValue(2),
      update: vi.fn().mockResolvedValue({
        ...current,
        authUserId: providerUserId,
        role: "GUEST",
        authzVersion: 8
      })
    };
    const client: any = {
      appUser,
      appAuthSession: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      securityAuditEvent: { create: vi.fn().mockResolvedValue({}) },
      $queryRaw: vi.fn()
        .mockResolvedValueOnce([{
          current_user: "auth_maintenance",
          current_database: "postgres",
          current_schema: "public",
          has_required_role: true
        }])
        .mockResolvedValue([])
    };
    client.$transaction = vi.fn(async (callback: (tx: any) => unknown) => callback(client));
    const store = await createPrismaAuthDispositionStore({
      client,
      target: target(),
      confirmation: { projectRef, releaseGitSha, targetSha256: targetBindingSha256(target()) },
      credentialPurpose: "AUTH_DISPOSITION_DB",
      tls: { authorized: true, mode: "verify-full", serverName: `db.${projectRef}.supabase.co` },
      now: clock()
    });
    await expect(store.applyAtomic({
      operationId: `auth-op:${"a".repeat(64)}`,
      action: "LINK",
      entry: entry({ action: "LINK", desiredRole: "GUEST" }),
      targetSha256: targetBindingSha256(target()),
      lockKeys: [`auth-disposition:${projectRef}`, "auth-disposition:entry-link-001"],
      revokeSessions: true,
      auditCode: "AUTH_DISPOSITION_LINK"
    })).resolves.toBe("APPLIED");
    expect(client.$queryRaw).toHaveBeenCalledTimes(3);
    expect(client.appAuthSession.updateMany).toHaveBeenCalledOnce();
    expect(client.securityAuditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ actorType: "SYSTEM", result: "SUCCESS" })
    });
  });
});

describe("applyAuthDisposition", () => {
  it("never mutates for an exact KEEP entry", async () => {
    const provider = providerFake();
    const store = storeFake(snapshot());
    const input = manifest(entry({ action: "KEEP" }));
    const deps = dependencies(provider, store);
    const plan = await planAuthDisposition(input, deps, clock());
    const result = await applyAuthDisposition(input, deps, confirmation(plan, "KEEP"), plan, clock());
    expect(result.counts).toEqual({ applied: 0, unchanged: 1, partial: 0 });
    expect(store.applyAtomic).not.toHaveBeenCalled();
    expect(store.claimReinvite).not.toHaveBeenCalled();
  });

  it("requires exact target, plan, action approval and passes lock/audit/CAS intent", async () => {
    const store = storeFake(snapshot({ providerUserId: null }));
    store.applyAtomic = vi.fn().mockResolvedValue("APPLIED");
    const provider = providerFake();
    const input = manifest(entry({ action: "LINK" }));
    const deps = dependencies(provider, store);
    const plan = await planAuthDisposition(input, deps, clock());

    const result = await applyAuthDisposition(input, deps, confirmation(plan, "LINK"), plan, clock());
    expect(result.counts).toEqual({ applied: 1, unchanged: 0, partial: 0 });
    expect(store.applyAtomic).toHaveBeenCalledWith(expect.objectContaining({
      action: "LINK",
      operationId: expect.stringMatching(/^auth-op:[a-f0-9]{64}$/),
      revokeSessions: true,
      auditCode: "AUTH_DISPOSITION_LINK",
      targetSha256: targetBindingSha256(input.target),
      lockKeys: [
        `auth-disposition:${projectRef}`,
        "auth-disposition:entry-link-001"
      ]
    }));
  });

  it("reports adapter idempotency without a second logical application", async () => {
    const store = storeFake(snapshot({ providerUserId: null }));
    store.applyAtomic = vi.fn().mockResolvedValue("UNCHANGED");
    const provider = providerFake();
    const input = manifest(entry({ action: "LINK" }));
    const deps = dependencies(provider, store);
    const plan = await planAuthDisposition(input, deps, clock());
    const result = await applyAuthDisposition(input, deps, confirmation(plan, "LINK"), plan, clock());
    expect(result.counts).toEqual({ applied: 0, unchanged: 1, partial: 0 });
  });

  it("fails closed on an unconfirmed plan", async () => {
    const store = storeFake(snapshot({ providerUserId: null }));
    const provider = providerFake();
    const input = manifest(entry({ action: "LINK" }));
    const deps = dependencies(provider, store);
    const plan = await planAuthDisposition(input, deps, clock());
    await expect(applyAuthDisposition(
      input,
      deps,
      { ...confirmation(plan, "LINK"), approved: false } as never,
      plan,
      clock()
    )).rejects.toThrow("AUTH_APPLY_EXPLICIT_APPROVAL_REQUIRED");
    expect(store.applyAtomic).not.toHaveBeenCalled();
  });

  it("compensates an owned invitation and records a redacted partial journal", async () => {
    const input = manifest(entry({
      action: "RE_INVITE",
      providerUserId: null,
      expectedLinkedProviderUserId: null,
      desiredActive: true
    }));
    const store = storeFake(snapshot({ providerUserId: null }));
    store.claimReinvite = vi.fn().mockResolvedValue("APPLIED");
    store.finalizeReinvite = vi.fn().mockRejectedValue(new Error("database detail"));
    const provider = providerFake();
    provider.findUserByEmail = vi.fn().mockResolvedValue(null);
    const deps = dependencies(provider, store);
    const plan = await planAuthDisposition(input, deps, clock());
    const result = await applyAuthDisposition(
      input,
      deps,
      confirmation(plan, "RE_INVITE"),
      plan,
      clock()
    );
    expect(result.counts.partial).toBe(1);
    expect(provider.removeOwnedInvitation).toHaveBeenCalledWith(expect.objectContaining({
      invitationId: "invitation-owned-001"
    }));
    expect(store.recordPartial).toHaveBeenCalledWith(expect.objectContaining({
      action: "RE_INVITE",
      state: "PROVIDER_APPLIED_DB_FAILED",
      compensation: "SUCCEEDED",
      code: "AUTH_REINVITE_FINALIZE_FAILED_COMPENSATED"
    }));
    expect(JSON.stringify(vi.mocked(store.recordPartial).mock.calls)).not.toContain("admin@example.com");
  });

  it("keeps the DB disabled and records a partial journal on provider failure", async () => {
    const input = manifest(entry({ action: "DISABLE", desiredActive: false }));
    const store = storeFake(snapshot({ providerUserId, active: true }));
    store.applyAtomic = vi.fn().mockResolvedValue("APPLIED");
    const provider = providerFake();
    provider.setUserDisabled = vi.fn().mockRejectedValue(new Error("admin@example.com secret"));
    const deps = dependencies(provider, store);
    const plan = await planAuthDisposition(input, deps, clock());
    const result = await applyAuthDisposition(
      input,
      deps,
      confirmation(plan, "DISABLE"),
      plan,
      clock()
    );
    expect(result.counts.partial).toBe(1);
    expect(store.recordPartial).toHaveBeenCalledWith(expect.objectContaining({
      state: "DB_APPLIED_PROVIDER_FAILED",
      compensation: "NOT_APPLICABLE",
      code: "AUTH_DISABLE_PROVIDER_FAILED"
    }));
  });

  it("rejects full protected-manifest substitution even when the redacted outcome is identical", async () => {
    const provider = providerFake();
    const store = storeFake(snapshot({ providerUserId: null }));
    const original = manifest(entry({ action: "LINK", desiredRole: "ADMIN" }));
    const substituted = manifest(entry({ action: "LINK", desiredRole: "GUEST" }));
    const deps = dependencies(provider, store);
    const plan = await planAuthDisposition(original, deps, clock());
    const substitutedPlan = await planAuthDisposition(substituted, deps, clock());
    expect(substitutedPlan.entries).toEqual(plan.entries);
    expect(substitutedPlan.manifestBinding.value).not.toBe(plan.manifestBinding.value);
    expect(substitutedPlan.planId).not.toBe(plan.planId);
    await expect(applyAuthDisposition(
      substituted,
      deps,
      confirmation(plan, "LINK"),
      plan,
      clock()
    )).rejects.toThrow("AUTH_APPLY_PLAN_STALE");
    expect(store.applyAtomic).not.toHaveBeenCalled();
  });

  it("reuses BootstrapSuperAdminService through the locked maintenance adapter", async () => {
    const provider = providerFake();
    const appUser = {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: appUserId }),
      update: vi.fn()
    };
    const store = storeFake(null);
    store.runBootstrapSuperAdmin = vi.fn(async ({ invoke }: any) => {
      const prismaFacade: any = { appUser };
      prismaFacade.$transaction = async (callback: (tx: any) => unknown) => callback(prismaFacade);
      const result = await invoke(prismaFacade);
      return result.action === "unchanged" ? "UNCHANGED" : "APPLIED";
    });
    const bootstrap = createBootstrapSuperAdminMaintenanceAdapter({
      store,
      provider,
      createService: (prisma, identityProvider) =>
        new BootstrapSuperAdminService(prisma as never, identityProvider as never)
    });
    const input = manifest(entry({
      action: "BOOTSTRAP_SUPER_ADMIN",
      appUserId: null,
      expectedLinkedProviderUserId: null,
      expectedAuthzVersion: null,
      desiredRole: "SUPER_ADMIN",
      desiredActive: true
    }));
    const deps = dependencies(provider, store, bootstrap);
    const plan = await planAuthDisposition(input, deps, clock());
    const result = await applyAuthDisposition(
      input,
      deps,
      confirmation(plan, "BOOTSTRAP_SUPER_ADMIN"),
      plan,
      clock()
    );
    expect(result.counts.applied).toBe(1);
    expect(store.runBootstrapSuperAdmin).toHaveBeenCalledOnce();
    expect(appUser.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ role: "SUPER_ADMIN", isActive: true })
    }));
  });
});

function manifest(dispositionEntry: AuthDispositionEntry): AuthDispositionInput {
  return {
    version: "auth-disposition-input/v1",
    manifestId: "auth-manifest-release-001",
    target: target(),
    entries: [dispositionEntry]
  };
}

function entry(overrides: Partial<AuthDispositionEntry> = {}): AuthDispositionEntry {
  const action = overrides.action ?? "LINK";
  return {
    entryId: `entry-${action.toLowerCase().replace("_", "-")}-001`,
    action,
    appUserId,
    normalizedEmail: "admin@example.com",
    providerUserId,
    expectedLinkedProviderUserId: action === "LINK" ? null : providerUserId,
    expectedAuthzVersion: 7,
    desiredRole: "SUPER_ADMIN",
    desiredActive: action !== "DISABLE",
    ...overrides
  };
}

function target(): CloudTargetBinding {
  return {
    version: "cloud-target-binding/v1",
    environmentId: "production-seoul",
    environmentClass: "production",
    projectRef,
    supabaseOrigin: `https://${projectRef}.supabase.co`,
    database: {
      connectionMode: "direct",
      host: `db.${projectRef}.supabase.co`,
      port: 5432,
      name: "postgres",
      schema: "public",
      loginUser: "auth_maintenance",
      expectedCurrentUser: "auth_maintenance",
      requiredRole: "auth_maintenance_role",
      sslMode: "verify-full",
      tlsServerName: `db.${projectRef}.supabase.co`
    },
    releaseGitSha,
    issuedAt: "2026-09-02T00:00:00.000Z",
    expiresAt: "2026-09-02T12:00:00.000Z"
  };
}

function clock(): Date {
  return new Date("2026-09-02T01:00:00.000Z");
}

function databaseUrl(username: string): string {
  const value = new URL(`postgresql://db.${projectRef}.supabase.co:5432/postgres`);
  value.username = username;
  value.password = ["test", "password"].join("-");
  value.searchParams.set("schema", "public");
  value.searchParams.set("sslmode", "verify-full");
  return value.toString();
}

function confirmation(plan: AuthDispositionPlan, action: AuthDispositionAction) {
  return {
    approved: true as const,
    planId: plan.planId,
    action,
    projectRef,
    releaseGitSha,
    targetSha256: targetBindingSha256(target()),
    manifestBindingKeyId: plan.manifestBinding.keyId,
    manifestHmacSha256: plan.manifestBinding.value
  };
}

function dependencies(
  provider: AuthMaintenanceProvider,
  store: AuthDispositionStore,
  bootstrapSuperAdmin?: BootstrapSuperAdminMaintenanceAdapter
) {
  return {
    provider,
    store,
    manifestBindingKey: {
      keyId: "auth-binding-key-001",
      key: Buffer.alloc(32, 0x42)
    },
    bootstrapSuperAdmin
  };
}

function snapshot(overrides: Partial<AppUserSnapshot> = {}): AppUserSnapshot {
  return {
    appUserId,
    normalizedEmail: "admin@example.com",
    providerUserId,
    role: "SUPER_ADMIN",
    active: true,
    authzVersion: 7,
    remainingEnabledSuperAdmins: 2,
    ...overrides
  };
}

function providerUser(overrides: Record<string, unknown> = {}) {
  return {
    id: providerUserId,
    email: "admin@example.com",
    emailVerified: true,
    disabled: false,
    ...overrides
  };
}

function providerFake(): AuthMaintenanceProvider & Record<string, any> {
  return {
    projectRef,
    findUserById: vi.fn().mockResolvedValue(providerUser()),
    findUserByEmail: vi.fn().mockResolvedValue(providerUser()),
    inviteUser: vi.fn().mockResolvedValue({
      operationId: "provider-operation-001",
      invitationId: "invitation-owned-001",
      userId: providerUserId
    }),
    setUserDisabled: vi.fn().mockResolvedValue({ operationId: "provider-operation-002", userId: providerUserId }),
    removeOwnedInvitation: vi.fn().mockResolvedValue({ operationId: "provider-operation-003", userId: providerUserId })
  };
}

function storeFake(user: AppUserSnapshot | null): AuthDispositionStore & Record<string, any> {
  return {
    inspectUser: vi.fn().mockResolvedValue(user),
    applyAtomic: vi.fn().mockResolvedValue("APPLIED"),
    claimReinvite: vi.fn().mockResolvedValue("APPLIED"),
    finalizeReinvite: vi.fn().mockResolvedValue("APPLIED"),
    recordPartial: vi.fn().mockResolvedValue(undefined)
  };
}
