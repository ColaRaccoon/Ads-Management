import { AppRole, InviteStatus, SecurityAuditResult } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { AuthService } from "../auth/auth.service";
import { UsersService } from "./users.service";

const actorId = "11111111-1111-4111-8111-111111111111";
const targetId = "22222222-2222-4222-8222-222222222222";
const providerId = "33333333-3333-4333-8333-333333333333";
const requestId = "44444444-4444-4444-8444-444444444444";
const now = new Date("2026-08-25T00:00:00.000Z");

const baseUser = {
  id: targetId,
  email: "guest@example.com",
  normalizedEmail: "guest@example.com",
  name: "Guest",
  role: AppRole.GUEST,
  inviteStatus: InviteStatus.ACTIVE,
  authUserId: providerId,
  isActive: true,
  lastLoginAt: null,
  deactivatedAt: null,
  authzVersion: 1,
  invitedAt: now,
  invitedBy: actorId,
  invitationRequestId: requestId,
  invitationErrorCode: null,
  createdAt: now,
  updatedAt: now
};

describe("UsersService", () => {
  it("maps non-ASCII email normalization failures to a stable 400 lifecycle error", async () => {
    let thrown: any;
    try {
      await makeService(txFake(baseUser)).invite({
        email: "ü@example.com",
        name: "Guest",
        role: AppRole.GUEST
      }, actorId, requestId);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: "USER_EMAIL_INVALID", status: 400 });
    expect(thrown.getResponse()).toEqual({
      code: "USER_EMAIL_INVALID",
      message: "The email address is invalid.",
      details: null
    });
  });

  it("rejects removal of the last active super admin under the DB invariant lock", async () => {
    const user = { ...baseUser, role: AppRole.SUPER_ADMIN };
    const tx = txFake(user);
    tx.appUser.count.mockResolvedValue(1);
    const service = makeService(tx);
    await expect(service.update(targetId, { role: AppRole.ADMIN }, actorId))
      .rejects.toMatchObject({ code: "LAST_ACTIVE_SUPER_ADMIN" });
    expect(tx.$executeRaw).toHaveBeenCalledOnce();
    expect(tx.appUser.update).not.toHaveBeenCalled();
  });

  it.each([
    ["role demotion", { role: AppRole.USER }],
    ["deactivation", { isActive: false }]
  ])("rejects self %s with SELF_LOCKOUT", async (_name, change) => {
    const user = { ...baseUser, role: AppRole.ADMIN };
    const tx = txFake(user);
    await expect(makeService(tx).update(targetId, change, targetId))
      .rejects.toMatchObject({ code: "SELF_LOCKOUT" });
    expect(tx.appAuthSession.updateMany).not.toHaveBeenCalled();
    expect(tx.appUser.update).not.toHaveBeenCalled();
  });

  it("revokes local sessions before an authorization change and audits in the same transaction", async () => {
    const order: string[] = [];
    const tx = txFake(baseUser);
    tx.appAuthSession.updateMany.mockImplementation(async () => { order.push("sessions"); return { count: 1 }; });
    tx.appUser.update.mockImplementation(async ({ data }: any) => {
      order.push("user");
      return { ...baseUser, role: data.role };
    });
    tx.securityAuditEvent.create.mockImplementation(async () => { order.push("audit"); return {}; });
    const service = makeService(tx);
    const result = await service.update(targetId, { role: AppRole.USER }, actorId);
    expect(result.role).toBe(AppRole.USER);
    expect(order).toEqual(["sessions", "user", "audit", "audit"]);
  });

  it("rejects the next authenticated request after a role change revoked its local session", async () => {
    let user: any = { ...baseUser, role: AppRole.ADMIN };
    const session: any = {
      id: "55555555-5555-4555-8555-555555555555",
      appUserId: targetId,
      providerSessionId: "66666666-6666-4666-8666-666666666666",
      revokedAt: null
    };
    const tx = txFake(user);
    tx.appUser.findUnique.mockImplementation(async () => user);
    tx.appUser.update.mockImplementation(async ({ data }: any) => {
      user = { ...user, role: data.role ?? user.role };
      return user;
    });
    tx.appAuthSession.updateMany.mockImplementation(async () => {
      session.revokedAt = new Date();
      return { count: 1 };
    });
    tx.appAuthSession.findUnique = vi.fn().mockImplementation(async () => session);
    const provider = providerFake();
    await makeService(tx, provider).update(targetId, { role: AppRole.USER }, actorId);
    const auth = new AuthService(
      tx as never,
      provider as never,
      { verify: vi.fn().mockResolvedValue({
        subject: providerId,
        sessionId: session.providerSessionId
      }) } as never,
      {} as never
    );
    await expect(auth.authenticateAccessToken("next-request-access"))
      .rejects.toMatchObject({ code: "SESSION_REVOKED" });
  });

  it("completes a provider invitation without returning provider metadata", async () => {
    const pending = {
      ...baseUser,
      authUserId: null,
      inviteStatus: InviteStatus.PENDING_PROVIDER,
      invitedAt: null,
      invitationErrorCode: "INVITATION_REQUEST_IN_PROGRESS"
    };
    const tx = txFake(pending);
    tx.appUser.create.mockResolvedValue(pending);
    tx.appUser.update.mockResolvedValue({
      ...pending,
      authUserId: providerId,
      inviteStatus: InviteStatus.INVITED,
      invitedAt: now
    });
    const provider = providerFake();
    const service = makeService(tx, provider);
    const result = await service.invite({
      email: "Guest@Example.com",
      name: "Guest",
      role: AppRole.GUEST
    }, actorId, requestId);
    expect(result).not.toHaveProperty("authUserId");
    expect(result).not.toHaveProperty("invitationRequestId");
    expect(result.inviteStatus).toBe(InviteStatus.INVITED);
    expect(result.reconciliationActions).toEqual(["CANCEL"]);
    expect(provider.inviteUserByEmail).toHaveBeenCalledWith(
      "guest@example.com",
      "http://localhost:3200/invite/accept",
      requestId
    );
  });

  it("reuses an identical idempotency key and rejects a changed payload", async () => {
    const tx = txFake({ ...baseUser, inviteStatus: InviteStatus.INVITED });
    tx.appUser.findUnique.mockResolvedValue({ ...baseUser, inviteStatus: InviteStatus.INVITED });
    const provider = providerFake();
    const service = makeService(tx, provider);
    await expect(service.invite({ email: baseUser.email, name: baseUser.name, role: baseUser.role }, actorId, requestId))
      .resolves.toMatchObject({ id: targetId });
    await expect(service.invite({ email: baseUser.email, name: "Changed", role: baseUser.role }, actorId, requestId))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_CONFLICT" });
    expect(provider.inviteUserByEmail).not.toHaveBeenCalled();
  });

  it("leaves provider failures reconcilable and returns only the stable error code", async () => {
    const pending = {
      ...baseUser,
      authUserId: null,
      inviteStatus: InviteStatus.PENDING_PROVIDER,
      invitedAt: null,
      invitationErrorCode: "INVITATION_REQUEST_IN_PROGRESS"
    };
    const tx = txFake(pending);
    tx.appUser.create.mockResolvedValue(pending);
    tx.appUser.update.mockResolvedValue({
      ...pending,
      inviteStatus: InviteStatus.RECONCILE_REQUIRED,
      invitationErrorCode: "INVITATION_PROVIDER_UNAVAILABLE"
    });
    const provider = providerFake();
    provider.inviteUserByEmail.mockRejectedValue(new Error("raw provider detail"));
    const service = makeService(tx, provider);
    let thrown: any;
    try {
      await service.invite({ email: baseUser.email, name: baseUser.name, role: baseUser.role }, actorId, requestId);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: "INVITATION_PROVIDER_UNAVAILABLE", status: 503 });
    expect(JSON.stringify(thrown.getResponse())).not.toContain("raw provider detail");
    expect(tx.appUser.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ inviteStatus: InviteStatus.RECONCILE_REQUIRED })
    }));
  });

  it("commits CANCELLED locally even when provider lookup fails and records PARTIAL compensation", async () => {
    const invited = { ...baseUser, inviteStatus: InviteStatus.INVITED };
    const cancelled = {
      ...invited,
      inviteStatus: InviteStatus.CANCELLED,
      isActive: false,
      invitationErrorCode: "INVITATION_PROVIDER_COMPENSATION_REQUIRED"
    };
    const tx = txFake(invited);
    tx.appUser.findUnique.mockImplementation(async ({ where }: any) => {
      if (where.authUserId) return null;
      return tx.appUser.update.mock.calls.length === 0 ? invited : cancelled;
    });
    tx.appUser.update.mockResolvedValue(cancelled);
    const provider = providerFake();
    provider.getUserById.mockRejectedValue(new Error("provider raw message"));
    const service = makeService(tx, provider);
    await expect(service.reconcile(targetId, "CANCEL", actorId)).resolves.toMatchObject({
      inviteStatus: InviteStatus.CANCELLED,
      isActive: false,
      reconciliationActions: ["CANCEL"]
    });
    expect(tx.securityAuditEvent.create).toHaveBeenLastCalledWith({
      data: expect.objectContaining({ result: SecurityAuditResult.PARTIAL })
    });
    expect(provider.deleteInvitationUser).not.toHaveBeenCalled();
  });

  it("claims a retryable provider-failure row before sending exactly one new invitation", async () => {
    const failed = {
      ...baseUser,
      authUserId: null,
      inviteStatus: InviteStatus.RECONCILE_REQUIRED,
      invitationErrorCode: "INVITATION_PROVIDER_UNAVAILABLE"
    };
    const claimed = {
      ...failed,
      inviteStatus: InviteStatus.PENDING_PROVIDER,
      invitationErrorCode: "INVITATION_RETRY_IN_PROGRESS"
    };
    const invited = {
      ...claimed,
      authUserId: providerId,
      inviteStatus: InviteStatus.INVITED,
      invitationErrorCode: null
    };
    const tx = txFake(failed);
    tx.appUser.findUnique
      .mockResolvedValueOnce(failed)
      .mockResolvedValueOnce(failed)
      .mockResolvedValueOnce(claimed);
    tx.appUser.update
      .mockResolvedValueOnce(claimed)
      .mockResolvedValueOnce(invited);
    const provider = providerFake();
    const service = makeService(tx, provider);
    await expect(service.reconcile(targetId, "RETRY_INVITATION", actorId))
      .resolves.toMatchObject({ inviteStatus: InviteStatus.INVITED });
    expect(provider.inviteUserByEmail).toHaveBeenCalledOnce();
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
  });

  it("compensates an exact provider identity when a stale PENDING row was cancelled during the provider call", async () => {
    const pending = {
      ...baseUser,
      authUserId: null,
      inviteStatus: InviteStatus.PENDING_PROVIDER,
      invitedAt: null,
      invitationErrorCode: "INVITATION_REQUEST_IN_PROGRESS"
    };
    const cancelled = {
      ...pending,
      inviteStatus: InviteStatus.CANCELLED,
      isActive: false
    };
    const attached = {
      ...cancelled,
      authUserId: providerId,
      invitationErrorCode: "INVITATION_PROVIDER_COMPENSATION_REQUIRED"
    };
    const compensated = { ...attached, authUserId: null, invitationErrorCode: null };
    const tx = txFake(pending);
    let idReads = 0;
    tx.appUser.findUnique.mockImplementation(async ({ where }: any) => {
      if (where.invitationRequestId || where.normalizedEmail || where.authUserId) return null;
      idReads += 1;
      if (idReads === 1) return cancelled;
      if (idReads <= 3) return cancelled;
      return attached;
    });
    tx.appUser.update
      .mockResolvedValueOnce(attached)
      .mockResolvedValueOnce(compensated);
    tx.appUser.create.mockResolvedValue(pending);
    const provider = providerFake();
    const service = makeService(tx, provider);
    await expect(service.invite({
      email: baseUser.email,
      name: baseUser.name,
      role: baseUser.role
    }, actorId, requestId)).rejects.toMatchObject({ code: "INVITATION_LOCAL_COMMIT_FAILED" });
    expect(provider.deleteInvitationUser).toHaveBeenCalledWith(providerId);
    expect(tx.securityAuditEvent.create).toHaveBeenLastCalledWith({
      data: expect.objectContaining({ result: SecurityAuditResult.SUCCESS })
    });
  });

  it("returns only server-computed reconciliation actions for ambiguous and retryable states", async () => {
    const recentPending = {
      ...baseUser,
      authUserId: null,
      inviteStatus: InviteStatus.PENDING_PROVIDER,
      invitationErrorCode: "INVITATION_REQUEST_IN_PROGRESS",
      updatedAt: new Date()
    };
    const stalePending = {
      ...recentPending,
      id: "55555555-5555-4555-8555-555555555555",
      updatedAt: new Date(Date.now() - 3 * 60_000)
    };
    const retryable = {
      ...recentPending,
      id: "66666666-6666-4666-8666-666666666666",
      inviteStatus: InviteStatus.RECONCILE_REQUIRED,
      invitationErrorCode: "INVITATION_PROVIDER_UNAVAILABLE"
    };
    const verified = {
      ...baseUser,
      id: "77777777-7777-4777-8777-777777777777",
      inviteStatus: InviteStatus.VERIFIED_PENDING_PASSWORD
    };
    const tx = txFake(baseUser);
    tx.appUser.findMany.mockResolvedValue([recentPending, stalePending, retryable, verified]);
    const { items } = await makeService(tx).list();
    expect(items.map((item) => item.reconciliationActions)).toEqual([
      [],
      ["CANCEL"],
      ["RETRY_INVITATION", "CANCEL"],
      ["CANCEL"]
    ]);
    for (const item of items) {
      expect(item).not.toHaveProperty("authUserId");
      expect(item).not.toHaveProperty("invitationErrorCode");
    }
  });

  it("keeps failed cancellation compensation retryable and clears it only after exact deletion", async () => {
    let state: any = { ...baseUser, inviteStatus: InviteStatus.INVITED };
    const tx = txFake(state);
    tx.appUser.findUnique.mockImplementation(async ({ where }: any) => {
      if (where.authUserId) return null;
      return state;
    });
    tx.appUser.update.mockImplementation(async ({ data }: any) => {
      state = { ...state, ...data, updatedAt: new Date() };
      return state;
    });
    const provider = providerFake();
    provider.getUserById
      .mockRejectedValueOnce(new Error("provider unavailable"))
      .mockResolvedValueOnce({
        id: providerId,
        email: baseUser.email,
        emailVerified: false,
        invitationRequestId: requestId
      });
    const service = makeService(tx, provider);
    await expect(service.reconcile(targetId, "CANCEL", actorId)).resolves.toMatchObject({
      inviteStatus: InviteStatus.CANCELLED,
      reconciliationActions: ["CANCEL"]
    });
    expect(state.invitationErrorCode).toBe("INVITATION_PROVIDER_COMPENSATION_REQUIRED");
    expect(provider.deleteInvitationUser).not.toHaveBeenCalled();

    await expect(service.reconcile(targetId, "CANCEL", actorId)).resolves.toMatchObject({
      inviteStatus: InviteStatus.CANCELLED,
      reconciliationActions: []
    });
    expect(provider.deleteInvitationUser).toHaveBeenCalledWith(providerId);
    expect(state.authUserId).toBeNull();
    expect(state.invitationErrorCode).toBeNull();
    const compensationAudits = tx.securityAuditEvent.create.mock.calls.filter(
      ([call]: any[]) => call.data.action === "USER_INVITATION_PROVIDER_COMPENSATION"
    );
    expect(compensationAudits.map(([call]: any[]) => call.data.result))
      .toEqual([SecurityAuditResult.PARTIAL, SecurityAuditResult.SUCCESS]);
  });

  it("restarts a fully compensated CANCELLED row without deleting it or duplicating provider calls", async () => {
    const oldRequestId = "88888888-8888-4888-8888-888888888888";
    let state: any = {
      ...baseUser,
      authUserId: null,
      inviteStatus: InviteStatus.CANCELLED,
      isActive: false,
      invitationRequestId: oldRequestId,
      invitationErrorCode: null
    };
    const tx = txFake(state);
    tx.appUser.findUnique.mockImplementation(async ({ where }: any) => {
      if (where.invitationRequestId) {
        return state.invitationRequestId === where.invitationRequestId ? state : null;
      }
      if (where.normalizedEmail) return state;
      if (where.authUserId) return null;
      return state;
    });
    tx.appUser.update.mockImplementation(async ({ data }: any) => {
      state = { ...state, ...data, updatedAt: new Date() };
      return state;
    });
    const provider = providerFake();
    const service = makeService(tx, provider);
    const result = await service.invite({
      email: baseUser.email,
      name: "Reinvited Guest",
      role: AppRole.USER
    }, actorId, requestId);
    expect(result).toMatchObject({
      id: targetId,
      name: "Reinvited Guest",
      role: AppRole.USER,
      inviteStatus: InviteStatus.INVITED,
      reconciliationActions: ["CANCEL"]
    });
    expect(provider.inviteUserByEmail).toHaveBeenCalledOnce();
    await expect(service.invite({
      email: baseUser.email,
      name: "Reinvited Guest",
      role: AppRole.USER
    }, actorId, requestId)).resolves.toMatchObject({ id: targetId });
    expect(provider.inviteUserByEmail).toHaveBeenCalledOnce();
  });

  it("durably records a provider subject conflict without linking or deleting that identity", async () => {
    let state: any = {
      ...baseUser,
      authUserId: null,
      inviteStatus: InviteStatus.PENDING_PROVIDER,
      invitedAt: null,
      invitationErrorCode: "INVITATION_REQUEST_IN_PROGRESS"
    };
    const subjectOwner = { id: "99999999-9999-4999-8999-999999999999" };
    const tx = txFake(state);
    tx.appUser.findUnique.mockImplementation(async ({ where }: any) => {
      if (where.invitationRequestId || where.normalizedEmail) return null;
      if (where.authUserId) return subjectOwner;
      return state;
    });
    tx.appUser.create.mockImplementation(async () => state);
    tx.appUser.update.mockImplementation(async ({ data }: any) => {
      state = { ...state, ...data };
      return state;
    });
    const provider = providerFake();
    await expect(makeService(tx, provider).invite({
      email: baseUser.email,
      name: baseUser.name,
      role: baseUser.role
    }, actorId, requestId)).rejects.toMatchObject({ code: "INVITATION_LOCAL_COMMIT_FAILED" });
    expect(state).toMatchObject({
      authUserId: null,
      inviteStatus: InviteStatus.RECONCILE_REQUIRED,
      invitationErrorCode: "INVITATION_PROVIDER_SUBJECT_CONFLICT"
    });
    expect(provider.deleteInvitationUser).not.toHaveBeenCalled();
    expect(tx.$executeRaw.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});

function txFake(user: any) {
  const tx: any = {
    $executeRaw: vi.fn(),
    appUser: {
      findUnique: vi.fn().mockImplementation(async ({ where }: any) => {
        if (where.invitationRequestId || where.normalizedEmail || where.authUserId) return null;
        return user;
      }),
      findMany: vi.fn().mockResolvedValue([user]),
      count: vi.fn().mockResolvedValue(2),
      create: vi.fn().mockResolvedValue(user),
      update: vi.fn().mockResolvedValue(user)
    },
    appAuthSession: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    securityAuditEvent: { create: vi.fn().mockResolvedValue({}) }
  };
  tx.$transaction = vi.fn(async (callback: (client: any) => unknown) => callback(tx));
  return tx;
}

function providerFake() {
  return {
    inviteUserByEmail: vi.fn().mockResolvedValue({
      id: providerId,
      email: "guest@example.com",
      emailVerified: false,
      invitationRequestId: requestId
    }),
    getUserById: vi.fn().mockResolvedValue({
      id: providerId,
      email: "guest@example.com",
      emailVerified: false,
      invitationRequestId: requestId
    }),
    deleteInvitationUser: vi.fn()
  };
}

function makeService(prisma: any, provider = providerFake()) {
  return new UsersService(prisma, provider as never, {
    allowedOrigins: new Set(["http://localhost:3200"])
  } as never);
}
