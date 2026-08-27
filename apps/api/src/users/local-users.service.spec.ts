import { AppRole, InviteStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { LocalUsersService } from "./local-users.service";

const actorId = "11111111-1111-4111-8111-111111111111";
const targetId = "22222222-2222-4222-8222-222222222222";
const requestId = "33333333-3333-4333-8333-333333333333";
type TestUser = {
  id: string;
  username: string | null;
  email: string | null;
  name: string;
  role: AppRole;
  isActive: boolean;
  inviteStatus: InviteStatus;
  lastLoginAt: Date | null;
  invitedAt: Date;
  createdAt: Date;
  updatedAt: Date;
};
const baseUser: TestUser = {
  id: targetId, username: "local.user", email: null, name: "Local User", role: AppRole.USER,
  isActive: true, inviteStatus: InviteStatus.ACTIVE, lastLoginAt: null, invitedAt: new Date(),
  createdAt: new Date(), updatedAt: new Date()
};

describe("LocalUsersService", () => {
  it("lists only local username identities", async () => {
    const findMany = vi.fn().mockResolvedValue([baseUser]);
    await expect(makeService({ appUser: { findMany } })).resolves.toEqual({ items: [baseUser] });
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { normalizedUsername: { not: null } } }));
  });

  it("creates a setup-pending user and returns a one-time token without auditing username or name", async () => {
    const tx = transactionFake({ ...baseUser, inviteStatus: InviteStatus.INVITED });
    tx.appUser.findUnique.mockResolvedValue(null);
    tx.appUser.create.mockResolvedValue({ ...baseUser, inviteStatus: InviteStatus.INVITED });
    const result = await serviceForTx(tx).invite({ username: "Local.User", name: "Local User", role: AppRole.USER }, actorId, requestId);
    expect(result.setupToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const audit = tx.securityAuditEvent.create.mock.calls[0]?.[0]?.data;
    expect(JSON.stringify(audit)).not.toContain("local.user");
    expect(JSON.stringify(audit)).not.toContain("Local User");
  });

  it("rejects an exact idempotent replay without revoking the authoritative setup token", async () => {
    const invited = { ...baseUser, inviteStatus: InviteStatus.INVITED };
    const tx = transactionFake(invited);
    tx.appUser.findUnique.mockResolvedValueOnce(invited);
    await expect(serviceForTx(tx).invite({ username: "Local.User", name: "Local User", role: AppRole.USER }, actorId, requestId))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_REPLAY" });
    expect(tx.appUser.create).not.toHaveBeenCalled();
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(tx.securityAuditEvent.create).not.toHaveBeenCalled();
  });

  it("prevents demotion of the last active local SUPER_ADMIN", async () => {
    const tx = transactionFake({ ...baseUser, role: AppRole.SUPER_ADMIN });
    tx.appUser.count.mockResolvedValue(1);
    await expect(serviceForTx(tx).update(targetId, { role: AppRole.ADMIN }, actorId))
      .rejects.toMatchObject({ code: "LAST_ACTIVE_SUPER_ADMIN" });
    expect(tx.appUser.update).not.toHaveBeenCalled();
  });

  it("allows correcting a setup-pending SUPER_ADMIN when another active SUPER_ADMIN remains", async () => {
    const tx = transactionFake({ ...baseUser, role: AppRole.SUPER_ADMIN, inviteStatus: InviteStatus.INVITED });
    tx.appUser.count.mockResolvedValue(1);
    await expect(serviceForTx(tx).update(targetId, { role: AppRole.GUEST }, actorId))
      .resolves.toMatchObject({ role: AppRole.GUEST });
    expect(tx.appUser.update).toHaveBeenCalledTimes(1);
  });

  it("revokes every session and prior setup token before issuing a password-reset token", async () => {
    const tx = transactionFake(baseUser);
    const result = await serviceForTx(tx).resetPassword(targetId, actorId);
    expect(result.setupToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(5);
    expect(tx.appUser.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ inviteStatus: InviteStatus.INVITED })
    }));
  });

  it("preserves the last ACTIVE local SUPER_ADMIN during password reset", async () => {
    const tx = transactionFake({ ...baseUser, role: AppRole.SUPER_ADMIN });
    tx.appUser.count.mockResolvedValue(1);
    await expect(serviceForTx(tx).resetPassword(targetId, actorId))
      .rejects.toMatchObject({ code: "LAST_ACTIVE_SUPER_ADMIN" });
    expect(tx.appUser.update).not.toHaveBeenCalled();
  });

  it("blocks self password reset and any local operation against legacy provider-only rows", async () => {
    await expect(serviceForTx(transactionFake(baseUser)).resetPassword(actorId, actorId))
      .rejects.toMatchObject({ code: "SELF_LOCKOUT" });
    const legacy = transactionFake({ ...baseUser, username: null });
    await expect(serviceForTx(legacy).resetPassword(targetId, actorId))
      .rejects.toMatchObject({ code: "USER_NOT_FOUND" });
  });
});

async function makeService(prisma: object) {
  return new LocalUsersService(prisma as never, { hashSetupToken: vi.fn() } as never, {} as never).list();
}
function serviceForTx(tx: ReturnType<typeof transactionFake>) {
  const prisma = { $transaction: vi.fn(async (work: (client: typeof tx) => unknown) => work(tx)) };
  return new LocalUsersService(
    prisma as never,
    { hashSetupToken: vi.fn().mockReturnValue("a".repeat(64)) } as never,
    { localSetupTokenTtlMs: 86_400_000 } as never
  );
}
function transactionFake(user: TestUser) {
  return {
    $executeRaw: vi.fn().mockResolvedValue(1),
    appUser: {
      findUnique: vi.fn().mockResolvedValue(user),
      findUniqueOrThrow: vi.fn().mockResolvedValue(user),
      findMany: vi.fn().mockResolvedValue([user]),
      count: vi.fn().mockResolvedValue(2),
      create: vi.fn().mockResolvedValue(user),
      update: vi.fn().mockImplementation(async ({ data }: { data: object }) => ({ ...user, ...data }))
    },
    securityAuditEvent: { create: vi.fn().mockResolvedValue({}) }
  };
}
