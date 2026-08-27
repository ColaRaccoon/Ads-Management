import { AppRole, InviteStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { BootstrapLocalSuperAdminService } from "./bootstrap-local-super-admin";

const userId = "11111111-1111-4111-8111-111111111111";
const config = {
  provider: "local",
  localSetupTokenSecret: "c7b0e4a5298d3f0162bc7e8a941d5f03b6c9e2a7184d0f52b7c3e9a6182d4f05",
  localSetupTokenTtlMs: 86_400_000
} as const;

describe("BootstrapLocalSuperAdminService", () => {
  it("permits one bootstrap only when the local identity set is empty", async () => {
    const prisma = { appUser: { count: vi.fn().mockResolvedValue(0) } };
    await expect(new BootstrapLocalSuperAdminService(prisma as never, config as never).inspect("Local.Admin"))
      .resolves.toEqual({ canApply: true, plannedUsers: 1, username: "local.admin" });
    prisma.appUser.count.mockResolvedValue(1);
    await expect(new BootstrapLocalSuperAdminService(prisma as never, config as never).inspect("local.admin"))
      .resolves.toMatchObject({ canApply: false });
  });

  it("recovers only the single unfinished bootstrap account and revokes old tokens and sessions atomically", async () => {
    const unfinished = {
      id: userId, username: "local.admin", role: AppRole.SUPER_ADMIN, isActive: true,
      inviteStatus: InviteStatus.VERIFIED_PENDING_PASSWORD, localCredential: null
    };
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      appUser: { findMany: vi.fn().mockResolvedValue([unfinished]), update: vi.fn().mockResolvedValue(unfinished) },
      securityAuditEvent: { create: vi.fn().mockResolvedValue({}) }
    };
    const prisma = { $transaction: vi.fn(async (work: (client: typeof tx) => unknown) => work(tx)) };
    const service = new BootstrapLocalSuperAdminService(prisma as never, config as never);
    await expect(service.recover("local.admin", "A".repeat(43)))
      .resolves.toEqual({ usersCreated: 0, setupTokensReissued: 1 });
    expect(tx.$executeRaw).toHaveBeenCalledTimes(4);
    expect(tx.appUser.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: userId }, data: expect.objectContaining({ inviteStatus: InviteStatus.INVITED })
    }));
    expect(tx.securityAuditEvent.create).toHaveBeenCalledOnce();
  });

  it("permits offline recovery of the sole active super admin while preserving other local users", async () => {
    const active = {
      id: userId, username: "local.admin", role: AppRole.SUPER_ADMIN, isActive: true,
      inviteStatus: InviteStatus.ACTIVE, localCredential: { appUserId: userId }
    };
    const ordinary = {
      id: "22222222-2222-4222-8222-222222222222", username: "operator", role: AppRole.ADMIN,
      isActive: true, inviteStatus: InviteStatus.ACTIVE, localCredential: { appUserId: "22222222-2222-4222-8222-222222222222" }
    };
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      appUser: { findMany: vi.fn().mockResolvedValue([active, ordinary]), update: vi.fn().mockResolvedValue(active) },
      localCredential: { delete: vi.fn().mockResolvedValue({}) },
      securityAuditEvent: { create: vi.fn().mockResolvedValue({}) }
    };
    const prisma = { $transaction: vi.fn(async (work: (client: typeof tx) => unknown) => work(tx)) };
    await expect(new BootstrapLocalSuperAdminService(prisma as never, config as never)
      .recover("local.admin", "B".repeat(43))).resolves.toMatchObject({ setupTokensReissued: 1 });
    expect(tx.localCredential.delete).toHaveBeenCalledWith({ where: { appUserId: userId } });
    expect(tx.securityAuditEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      action: "LOCAL_SUPER_ADMIN_BREAK_GLASS_RECOVERY"
    }) });
  });

  it("can reissue an unfinished break-glass setup after the first handoff is lost", async () => {
    const unfinished = {
      id: userId, username: "local.admin", role: AppRole.SUPER_ADMIN, isActive: true,
      inviteStatus: InviteStatus.INVITED, localCredential: null
    };
    const ordinary = {
      id: "22222222-2222-4222-8222-222222222222", username: "operator", role: AppRole.ADMIN,
      isActive: true, inviteStatus: InviteStatus.ACTIVE, localCredential: { appUserId: "22222222-2222-4222-8222-222222222222" }
    };
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      appUser: { findMany: vi.fn().mockResolvedValue([unfinished, ordinary]), update: vi.fn().mockResolvedValue(unfinished) },
      securityAuditEvent: { create: vi.fn().mockResolvedValue({}) }
    };
    const prisma = { appUser: { findMany: vi.fn().mockResolvedValue([unfinished, ordinary]) }, $transaction: vi.fn(async (work: (client: typeof tx) => unknown) => work(tx)) };
    const service = new BootstrapLocalSuperAdminService(prisma as never, config as never);
    await expect(service.inspectRecovery("local.admin")).resolves.toMatchObject({ canRecover: true, recoveryKind: "UNFINISHED_BOOTSTRAP" });
    await expect(service.recover("local.admin", "C".repeat(43))).resolves.toMatchObject({ setupTokensReissued: 1 });
  });

  it.each([
    [{ inviteStatus: InviteStatus.ACTIVE, localCredential: null }],
    [{ inviteStatus: InviteStatus.INVITED, localCredential: { appUserId: userId } }],
    [{ role: AppRole.ADMIN, inviteStatus: InviteStatus.INVITED, localCredential: null }]
  ])("rejects recovery after activation, credential creation, or role drift", async (change) => {
    const user = Object.assign({
      id: userId, username: "local.admin", role: AppRole.SUPER_ADMIN, isActive: true,
      inviteStatus: InviteStatus.INVITED, localCredential: null
    }, change);
    const tx = { $executeRaw: vi.fn(), appUser: { findMany: vi.fn().mockResolvedValue([user]) } };
    const prisma = { $transaction: vi.fn(async (work: (client: typeof tx) => unknown) => work(tx)) };
    await expect(new BootstrapLocalSuperAdminService(prisma as never, config as never)
      .recover("local.admin", "A".repeat(43))).rejects.toThrow("BOOTSTRAP_RECOVERY_STATE_REJECTED");
  });
});
