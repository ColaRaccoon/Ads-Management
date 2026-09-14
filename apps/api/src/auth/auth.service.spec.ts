import { AppRole, InviteStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { AuthConfig } from "./auth.config";
import { AuthCookieService } from "./cookie.service";
import {
  ProviderInvalidCredentialsError,
  ProviderInvalidInvitationError,
  ProviderInvalidRefreshTokenError
} from "./identity-provider";
import { AuthService } from "./auth.service";
import { authError } from "./auth.errors";

const authUserId = "11111111-1111-4111-8111-111111111111";
const providerSessionId = "22222222-2222-4222-8222-222222222222";
const appSessionId = "33333333-3333-4333-8333-333333333333";
const appUserId = "44444444-4444-4444-8444-444444444444";
const config = {
  production: false,
  cookieSecure: false,
  sessionHandleSecret: "s".repeat(48),
  authorizationVersionSecret: "a".repeat(48),
  csrfSecret: "c".repeat(48)
} as AuthConfig;

const baseUser = {
  id: appUserId,
  authUserId,
  email: "user@example.com",
  normalizedEmail: "user@example.com",
  name: "User",
  role: AppRole.USER,
  inviteStatus: InviteStatus.ACTIVE,
  isActive: true,
  lastLoginAt: null,
  deactivatedAt: null,
  authzVersion: 1,
  createdAt: new Date(),
  updatedAt: new Date()
};

describe("AuthService", () => {
  it("creates only an opaque app session and never returns provider tokens in the body", async () => {
    const provider = providerFake();
    const verifier = { verify: vi.fn().mockResolvedValue({ subject: authUserId, sessionId: providerSessionId }) };
    const prisma = transactionPrisma({
      appUser: {
        findUnique: vi.fn().mockResolvedValue(baseUser),
        update: vi.fn().mockResolvedValue(baseUser)
      },
      appAuthSession: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: appSessionId })
      }
    });
    const service = makeService(prisma, provider, verifier);
    const result = await service.login("user@example.com", "password");

    expect(prisma.appAuthSession.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        appUserId,
        providerSessionId,
        lastSeenAt: expect.any(Date)
      })
    });
    expect(JSON.stringify(result.response)).not.toContain("access-token");
    expect(JSON.stringify(result.response)).not.toContain("refresh-token");
    expect(result.response.user.inviteStatus).toBe(InviteStatus.ACTIVE);
    expect(result.response.permissions).toEqual(["data.read", "change_logs.create", "reports.generate"]);
  });

  it("generalizes provider credential errors", async () => {
    const provider = providerFake();
    provider.signInWithPassword.mockRejectedValue(new ProviderInvalidCredentialsError());
    const service = makeService(transactionPrisma({}), provider, { verify: vi.fn() });
    await expect(service.login("user@example.com", "wrong"))
      .rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
  });

  it("maps a provider-returned email outside the identity policy to SESSION_INVALID and revokes", async () => {
    const provider = providerFake();
    provider.signInWithPassword.mockResolvedValue({
      ...providerSession(),
      user: { ...providerSession().user, email: "caf\u00e9@example.com" }
    });
    const service = makeService(transactionPrisma({}), provider, {
      verify: vi.fn().mockResolvedValue({ subject: authUserId, sessionId: providerSessionId })
    });
    await expect(service.login("user@example.com", "password"))
      .rejects.toMatchObject({ code: "SESSION_INVALID" });
    expect(provider.revokeSession).toHaveBeenCalledWith("access-token");
  });

  it.each([
    ["unregistered", null, null, "ACCOUNT_NOT_PROVISIONED"],
    ["inactive", { ...baseUser, isActive: false }, null, "ACCOUNT_INACTIVE"],
    ["onboarding", { ...baseUser, inviteStatus: InviteStatus.INVITED }, null, "ACCOUNT_ONBOARDING_REQUIRED"],
    ["missing session", baseUser, null, "SESSION_INVALID"],
    ["revoked session", baseUser, { id: appSessionId, appUserId, revokedAt: new Date() }, "SESSION_REVOKED"]
  ])("separates %s errors", async (_name, user, session, code) => {
    const prisma = {
      appUser: { findUnique: vi.fn().mockResolvedValue(user) },
      appAuthSession: {
        findUnique: vi.fn().mockResolvedValue(session),
        update: vi.fn()
      }
    };
    const service = makeService(prisma, providerFake(), {
      verify: vi.fn().mockResolvedValue({ subject: authUserId, sessionId: providerSessionId })
    });
    await expect(service.authenticateAccessToken("access-token")).rejects.toMatchObject({ code });
  });

  it("reads the current role from AppUser on every request", async () => {
    const findUser = vi.fn()
      .mockResolvedValueOnce(baseUser)
      .mockResolvedValueOnce({ ...baseUser, role: AppRole.ADMIN, authzVersion: 2 });
    const prisma = {
      appUser: { findUnique: findUser },
      appAuthSession: {
        findUnique: vi.fn().mockResolvedValue({ id: appSessionId, appUserId, revokedAt: null }),
        update: vi.fn().mockResolvedValue({})
      }
    };
    const service = makeService(prisma, providerFake(), {
      verify: vi.fn().mockResolvedValue({ subject: authUserId, sessionId: providerSessionId })
    });
    expect((await service.authenticateAccessToken("first")).role).toBe(AppRole.USER);
    expect((await service.authenticateAccessToken("second")).role).toBe(AppRole.ADMIN);
    expect(findUser).toHaveBeenCalledTimes(2);
  });

  it("authenticates only the verified onboarding session with no business permissions", async () => {
    const onboarding = { ...baseUser, inviteStatus: InviteStatus.VERIFIED_PENDING_PASSWORD };
    const prisma = {
      appUser: { findUnique: vi.fn().mockResolvedValue(onboarding) },
      appAuthSession: {
        findUnique: vi.fn().mockResolvedValue({ id: appSessionId, appUserId, revokedAt: null }),
        update: vi.fn().mockResolvedValue({})
      }
    };
    const service = makeService(prisma, providerFake(), matchingVerifier());
    const principal = await service.authenticateAccessToken("onboarding-access");
    expect(principal.inviteStatus).toBe(InviteStatus.VERIFIED_PENDING_PASSWORD);
    expect(principal.permissions).toEqual([]);
    expect(service.me(principal).user.inviteStatus).toBe(InviteStatus.VERIFIED_PENDING_PASSWORD);
  });

  it.each(["invite", "recovery"] as const)("accepts an exact one-time %s identity only after local commit", async (tokenType) => {
    const invited = {
      ...baseUser,
      inviteStatus: InviteStatus.INVITED,
      invitationRequestId: "55555555-5555-4555-8555-555555555555"
    };
    const updated = { ...invited, inviteStatus: InviteStatus.VERIFIED_PENDING_PASSWORD };
    const tx = {
      $executeRaw: vi.fn(),
      appUser: {
        findUnique: vi.fn().mockResolvedValue(invited),
        update: vi.fn().mockResolvedValue(updated)
      },
      appAuthSession: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: appSessionId })
      }
    };
    const provider = providerFake();
    provider.verifyInvitationToken.mockResolvedValue({
      ...providerSession(),
      user: {
        ...providerSession().user,
        invitationRequestId: invited.invitationRequestId
      }
    });
    const service = makeService(transactionPrisma(tx), provider, matchingVerifier());
    const result = await service.acceptInvitation("opaque-link-hash", tokenType);
    expect(result.response.user.inviteStatus).toBe(InviteStatus.VERIFIED_PENDING_PASSWORD);
    expect(result.response.permissions).toEqual([]);
    expect(result.cookies.sessionId).toBe(appSessionId);
  });

  it("maps invalid or expired provider invitation links to one stable error without raw details", async () => {
    const provider = providerFake();
    provider.verifyInvitationToken.mockRejectedValue(
      new ProviderInvalidInvitationError("raw expired provider token detail")
    );
    let thrown: any;
    try {
      await makeService(transactionPrisma({}), provider, matchingVerifier())
        .acceptInvitation("expired-link-hash");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: "INVITATION_INVALID_OR_EXPIRED", status: 400 });
    expect(JSON.stringify(thrown.getResponse())).not.toMatch(/raw expired|link-hash/i);
  });

  it.each([InviteStatus.VERIFIED_PENDING_PASSWORD, InviteStatus.ACTIVE])("rejects recovery for %s accounts and revokes the provider session", async (inviteStatus) => {
    const replayed = {
      ...baseUser,
      inviteStatus: InviteStatus.VERIFIED_PENDING_PASSWORD,
      invitationRequestId: "55555555-5555-4555-8555-555555555555"
    };
    const tx = {
      $executeRaw: vi.fn(),
      appUser: { findUnique: vi.fn().mockResolvedValue(replayed), update: vi.fn() },
      appAuthSession: { findUnique: vi.fn(), create: vi.fn() }
    };
    const provider = providerFake();
    provider.verifyInvitationToken.mockResolvedValue({
      ...providerSession(),
      user: { ...providerSession().user, invitationRequestId: replayed.invitationRequestId }
    });
    await expect(makeService(transactionPrisma(tx), provider, matchingVerifier())
      .acceptInvitation("replayed-link-hash", "recovery"))
      .rejects.toMatchObject({ code: "INVITATION_INVALID_OR_EXPIRED" });
    expect(provider.revokeSession).toHaveBeenCalledWith("access-token");
    expect(tx.appUser.update).not.toHaveBeenCalled();
  });

  it("rejects a provider subject mismatch before local invitation state changes", async () => {
    const provider = providerFake();
    provider.verifyInvitationToken.mockResolvedValue(providerSession());
    const service = makeService(transactionPrisma({}), provider, {
      verify: vi.fn().mockResolvedValue({
        subject: "77777777-7777-4777-8777-777777777777",
        sessionId: providerSessionId
      })
    });
    await expect(service.acceptInvitation("subject-mismatch-link"))
      .rejects.toMatchObject({ code: "INVITATION_INVALID_OR_EXPIRED" });
    expect(provider.revokeSession).toHaveBeenCalledWith("access-token");
  });

  it.each([
    ["email", { email: "other@example.com" }],
    ["request id", { invitationRequestId: "66666666-6666-4666-8666-666666666666" }]
  ])("rejects provider %s mismatch against the local invitation", async (_name, providerOverride) => {
    const invited = {
      ...baseUser,
      inviteStatus: InviteStatus.INVITED,
      invitationRequestId: "55555555-5555-4555-8555-555555555555"
    };
    const tx = {
      $executeRaw: vi.fn(),
      appUser: { findUnique: vi.fn().mockResolvedValue(invited), update: vi.fn() },
      appAuthSession: { findUnique: vi.fn(), create: vi.fn() }
    };
    const provider = providerFake();
    provider.verifyInvitationToken.mockResolvedValue({
      ...providerSession(),
      user: {
        ...providerSession().user,
        invitationRequestId: invited.invitationRequestId,
        ...providerOverride
      }
    });
    await expect(makeService(transactionPrisma(tx), provider, matchingVerifier())
      .acceptInvitation("mismatched-link"))
      .rejects.toMatchObject({ code: "INVITATION_INVALID_OR_EXPIRED" });
    expect(provider.revokeSession).toHaveBeenCalledWith("access-token");
    expect(tx.appUser.update).not.toHaveBeenCalled();
  });

  it("marks provider-success/local-audit failure for reconciliation and issues no service result", async () => {
    const invited = {
      ...baseUser,
      inviteStatus: InviteStatus.INVITED,
      invitationRequestId: "55555555-5555-4555-8555-555555555555"
    };
    const verified = { ...invited, inviteStatus: InviteStatus.VERIFIED_PENDING_PASSWORD };
    const reconciliation = {
      ...invited,
      inviteStatus: InviteStatus.RECONCILE_REQUIRED,
      invitationErrorCode: "INVITATION_ACCEPT_LOCAL_COMMIT_FAILED"
    };
    const auditCreate = vi.fn()
      .mockRejectedValueOnce(new Error("raw local audit failure"))
      .mockResolvedValueOnce({});
    const tx = {
      $executeRaw: vi.fn(),
      appUser: {
        findUnique: vi.fn().mockResolvedValue(invited),
        update: vi.fn()
          .mockResolvedValueOnce(verified)
          .mockResolvedValueOnce(reconciliation)
      },
      appAuthSession: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: appSessionId })
      },
      securityAuditEvent: { create: auditCreate }
    };
    const provider = providerFake();
    provider.verifyInvitationToken.mockResolvedValue({
      ...providerSession(),
      user: { ...providerSession().user, invitationRequestId: invited.invitationRequestId }
    });
    let thrown: any;
    try {
      await makeService(transactionPrisma(tx), provider, matchingVerifier())
        .acceptInvitation("local-failure-link");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: "INVITATION_INVALID_OR_EXPIRED" });
    expect(JSON.stringify(thrown.getResponse())).not.toContain("raw local audit failure");
    expect(provider.revokeSession).toHaveBeenCalledWith("access-token");
    expect(tx.appUser.update).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        inviteStatus: InviteStatus.RECONCILE_REQUIRED,
        invitationErrorCode: "INVITATION_ACCEPT_LOCAL_COMMIT_FAILED"
      })
    }));
  });

  it("completes the first password and atomically activates the onboarding user", async () => {
    const onboarding = { ...baseUser, inviteStatus: InviteStatus.VERIFIED_PENDING_PASSWORD };
    const active = { ...baseUser, inviteStatus: InviteStatus.ACTIVE, authzVersion: 2 };
    const tx = {
      $executeRaw: vi.fn(),
      appUser: {
        findUnique: vi.fn().mockResolvedValue(onboarding),
        update: vi.fn().mockResolvedValue(active)
      },
      appAuthSession: {
        findUnique: vi.fn().mockResolvedValue({ id: appSessionId, appUserId, revokedAt: null })
      }
    };
    const provider = providerFake();
    provider.updatePassword.mockResolvedValue(providerSession().user);
    const service = makeService(transactionPrisma(tx), provider, matchingVerifier());
    const response = await service.completeInitialPassword({
      id: appUserId,
      authUserId,
      email: baseUser.email,
      name: baseUser.name,
      role: baseUser.role,
      inviteStatus: InviteStatus.VERIFIED_PENDING_PASSWORD,
      isActive: true,
      authzVersion: 1,
      permissions: [],
      sessionId: appSessionId
    }, "onboarding-access", "a sufficiently long password");
    expect(provider.updatePassword).toHaveBeenCalledWith("onboarding-access", "a sufficiently long password");
    expect(response.user.inviteStatus).toBe(InviteStatus.ACTIVE);
    expect(response.permissions).toContain("data.read");
  });

  it("keeps onboarding blocked after local activation failure and allows same-session retry", async () => {
    let user: any = { ...baseUser, inviteStatus: InviteStatus.VERIFIED_PENDING_PASSWORD };
    const active = { ...baseUser, inviteStatus: InviteStatus.ACTIVE, authzVersion: 2 };
    const session = { id: appSessionId, appUserId, revokedAt: null };
    const tx = {
      $executeRaw: vi.fn(),
      appUser: {
        findUnique: vi.fn().mockImplementation(async () => user),
        update: vi.fn().mockImplementation(async () => {
          user = active;
          return active;
        })
      },
      appAuthSession: { findUnique: vi.fn().mockResolvedValue(session) },
      securityAuditEvent: { create: vi.fn().mockResolvedValue({}) }
    };
    const prisma = transactionPrisma(tx);
    let transactionAttempt = 0;
    prisma.$transaction.mockImplementation(async (callback: (client: any) => unknown) => {
      transactionAttempt += 1;
      if (transactionAttempt === 1) throw new Error("raw database activation failure");
      return callback(tx);
    });
    const provider = providerFake();
    provider.updatePassword.mockResolvedValue(providerSession().user);
    const service = makeService(prisma, provider, matchingVerifier());
    const principal = onboardingPrincipal();
    let thrown: any;
    try {
      await service.completeInitialPassword(
        principal,
        "onboarding-access-token",
        "a sufficiently long password"
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: "PASSWORD_LOCAL_COMMIT_FAILED" });
    expect(JSON.stringify(thrown.getResponse())).not.toMatch(/raw database|access-token|sufficiently long/i);
    expect(user.inviteStatus).toBe(InviteStatus.VERIFIED_PENDING_PASSWORD);
    expect(service.me(principal).permissions).toEqual([]);

    await expect(service.completeInitialPassword(
      principal,
      "onboarding-access-token",
      "a sufficiently long password"
    )).resolves.toMatchObject({
      user: { inviteStatus: InviteStatus.ACTIVE },
      permissions: expect.arrayContaining(["data.read"])
    });
    expect(provider.updatePassword).toHaveBeenCalledTimes(2);
    expect(user.inviteStatus).toBe(InviteStatus.ACTIVE);
  });

  it("returns REFRESH_RACE_RETRY after taking the database advisory lock", async () => {
    const requestObservedAt = new Date("2026-08-24T00:00:00.000Z");
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ observedAt: requestObservedAt }]),
      $executeRaw: vi.fn(),
      appAuthSession: {
        findUnique: vi.fn().mockResolvedValue({
          id: appSessionId,
          appUser: baseUser,
          revokedAt: null,
          refreshedAt: new Date("2026-08-24T00:00:00.001Z")
        })
      }
    };
    const prisma = transactionPrisma(tx);
    const provider = providerFake();
    const service = makeService(prisma, provider, { verify: vi.fn() });
    const handle = signedHandle((service as never as { cookies: AuthCookieService }).cookies);
    await expect(service.refresh("refresh-token", handle)).rejects.toMatchObject({
      code: "REFRESH_RACE_RETRY"
    });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(provider.refreshSession).not.toHaveBeenCalled();
  });

  it("rotates provider tokens and records a successful refresh under the DB lock", async () => {
    const tx = refreshTransaction();
    const prisma = transactionPrisma(tx);
    const provider = providerFake();
    provider.refreshSession.mockResolvedValue({
      ...providerSession(),
      accessToken: "rotated-access",
      refreshToken: "rotated-refresh"
    });
    const service = makeService(prisma, provider, matchingVerifier());
    const result = await service.refresh("old-refresh", signedHandleFor(service));
    if (!("cookies" in result)) throw new Error("Expected a verified refresh result.");
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(provider.refreshSession).toHaveBeenCalledWith("old-refresh");
    expect(result.cookies).toMatchObject({
      accessToken: "rotated-access",
      refreshToken: "rotated-refresh",
      sessionId: appSessionId
    });
    expect(tx.appAuthSession.update).toHaveBeenCalledWith({
      where: { id: appSessionId },
      data: { refreshedAt: expect.any(Date), lastSeenAt: expect.any(Date) }
    });
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 30_000 });
  });

  it("revokes the app session when the provider rejects a refresh token", async () => {
    const tx = refreshTransaction();
    const provider = providerFake();
    provider.refreshSession.mockRejectedValue(new ProviderInvalidRefreshTokenError());
    const service = makeService(transactionPrisma(tx), provider, matchingVerifier());
    await expect(service.refresh("reused-refresh", signedHandleFor(service)))
      .rejects.toMatchObject({ code: "SESSION_REVOKED" });
    expect(tx.appAuthSession.update).toHaveBeenCalledWith({
      where: { id: appSessionId },
      data: { revokedAt: expect.any(Date) }
    });
  });

  it("preserves the app session when refreshed-token JWKS verification is unavailable", async () => {
    const tx = refreshTransaction();
    const provider = providerFake();
    const service = makeService(transactionPrisma(tx), provider, {
      verify: vi.fn().mockRejectedValue(authError("AUTH_PROVIDER_UNAVAILABLE"))
    });
    await expect(service.refresh("refresh-token", signedHandleFor(service)))
      .resolves.toEqual({ recoveryRefreshToken: "refresh-token" });
    expect(provider.refreshSession).toHaveBeenCalledTimes(1);
    expect(tx.appAuthSession.update).not.toHaveBeenCalled();
  });

  it("preserves the rotated refresh token after verified identity when the DB write cannot finish", async () => {
    const tx = refreshTransaction();
    tx.$queryRaw
      .mockResolvedValueOnce([{ observedAt: new Date() }])
      .mockRejectedValueOnce(new Error("database unavailable"));
    const provider = providerFake();
    const service = makeService(transactionPrisma(tx), provider, matchingVerifier());

    await expect(service.refresh("refresh-token", signedHandleFor(service)))
      .resolves.toEqual({ recoveryRefreshToken: "refresh-token" });
    expect(tx.appAuthSession.update).not.toHaveBeenCalled();
  });

  it("serializes two-tab refresh and returns one success plus one retryable race", async () => {
    let refreshedAt: Date | null = null;
    let transactionTail = Promise.resolve();
    const tx = refreshTransaction();
    tx.appAuthSession.findUnique.mockImplementation(async () => ({
      id: appSessionId,
      appUser: baseUser,
      appUserId,
      providerSessionId,
      revokedAt: null,
      refreshedAt
    }));
    tx.appAuthSession.update.mockImplementation(async ({ data }: any) => {
      if (data.refreshedAt) refreshedAt = data.refreshedAt;
      return {};
    });
    const prisma: any = { ...tx };
    prisma.$transaction = vi.fn(async (callback: (client: any) => unknown) => {
      const previous = transactionTail;
      let release!: () => void;
      transactionTail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try {
        return await callback(tx);
      } finally {
        release();
      }
    });
    const provider = providerFake();
    const service = makeService(prisma, provider, matchingVerifier());
    const handle = signedHandleFor(service);
    const results = await Promise.allSettled([
      service.refresh("refresh-one", handle),
      service.refresh("refresh-two", handle)
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "REFRESH_RACE_RETRY" });
    expect(provider.refreshSession).toHaveBeenCalledTimes(1);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
  });

  it("revokes a local session when refresh returns an invalid provider email", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ observedAt: new Date() }]),
      $executeRaw: vi.fn(),
      appAuthSession: {
        findUnique: vi.fn().mockResolvedValue({
          id: appSessionId,
          appUser: baseUser,
          appUserId,
          providerSessionId,
          revokedAt: null,
          refreshedAt: null
        }),
        update: vi.fn()
      }
    };
    const provider = providerFake();
    provider.refreshSession.mockResolvedValue({
      ...providerSession(),
      user: { ...providerSession().user, email: "caf\u00e9@example.com" }
    });
    const service = makeService(transactionPrisma(tx), provider, {
      verify: vi.fn().mockResolvedValue({ subject: authUserId, sessionId: providerSessionId })
    });
    const handle = signedHandle((service as never as { cookies: AuthCookieService }).cookies);
    await expect(service.refresh("refresh-token", handle)).rejects.toMatchObject({
      code: "SESSION_REVOKED"
    });
    expect(tx.appAuthSession.update).toHaveBeenCalledWith({
      where: { id: appSessionId },
      data: { revokedAt: expect.any(Date) }
    });
  });

  it("revokes locally before refreshing an expired/missing access token for provider logout", async () => {
    const order: string[] = [];
    const provider = providerFake();
    provider.refreshSession.mockImplementation(async () => {
      order.push("provider-refresh");
      return providerSession();
    });
    provider.revokeSession.mockImplementation(async () => { order.push("provider-revoke"); });
    const tx = {
      appAuthSession: {
        findUnique: vi.fn().mockResolvedValue({
          id: appSessionId,
          providerSessionId,
          revokedAt: null,
          appUser: baseUser
        }),
        update: vi.fn().mockImplementation(async () => { order.push("local-revoke"); })
      }
    };
    const verifier = {
      verify: vi.fn().mockResolvedValue({ subject: authUserId, sessionId: providerSessionId })
    };
    const service = makeService(transactionPrisma(tx), provider, verifier);
    const handle = signedHandle((service as never as { cookies: AuthCookieService }).cookies);
    await service.logout(handle, undefined, "refresh-token");
    expect(order).toEqual(["local-revoke", "provider-refresh", "provider-revoke"]);
  });

  it("keeps the local revocation when provider logout fails", async () => {
    const provider = providerFake();
    provider.revokeSession.mockRejectedValue(new Error("provider detail must not escape"));
    const update = vi.fn().mockResolvedValue({});
    const tx = {
      appAuthSession: {
        findUnique: vi.fn().mockResolvedValue({
          id: appSessionId,
          providerSessionId,
          revokedAt: null,
          appUser: baseUser
        }),
        update
      }
    };
    const service = makeService(transactionPrisma(tx), provider, matchingVerifier());

    await expect(service.logout(signedHandleFor(service), "access-token", undefined))
      .resolves.toBeUndefined();
    expect(update).toHaveBeenCalledWith({
      where: { id: appSessionId },
      data: { revokedAt: expect.any(Date) }
    });
    expect(provider.revokeSession).toHaveBeenCalledWith("access-token");
  });

  it("rejects a signed handle whose session row belongs to a different provider identity", async () => {
    const tx = refreshTransaction({
      appUser: { ...baseUser, authUserId: "55555555-5555-4555-8555-555555555555" }
    });
    const service = makeService(transactionPrisma(tx), providerFake(), matchingVerifier());
    await expect(service.refresh("refresh-token", signedHandleFor(service)))
      .rejects.toMatchObject({ code: "SESSION_REVOKED" });
    expect(tx.appAuthSession.update).toHaveBeenCalledWith({
      where: { id: appSessionId },
      data: { revokedAt: expect.any(Date) }
    });
  });
});

function makeService(prisma: any, provider: any, verifier: any) {
  const cookies = new AuthCookieService(config);
  const service = new AuthService(prisma, provider, verifier, cookies);
  Object.defineProperty(service, "cookies", { value: cookies });
  return service;
}

function transactionPrisma(tx: any) {
  const audit = tx.securityAuditEvent ?? { create: vi.fn().mockResolvedValue({}) };
  const transactionClient = { ...tx, securityAuditEvent: audit };
  const prisma: any = { ...transactionClient };
  prisma.$transaction = vi.fn(async (callback: (client: any) => unknown) => callback(transactionClient));
  return prisma;
}

function providerFake() {
  return {
    signInWithPassword: vi.fn().mockResolvedValue(providerSession()),
    refreshSession: vi.fn().mockResolvedValue(providerSession()),
    revokeSession: vi.fn(),
    getUserById: vi.fn(),
    inviteUserByEmail: vi.fn(),
    verifyInvitationToken: vi.fn(),
    updatePassword: vi.fn(),
    deleteInvitationUser: vi.fn()
  };
}

function providerSession() {
  return {
    accessToken: "access-token",
    refreshToken: "refresh-token",
    expiresIn: 600,
    user: { id: authUserId, email: "user@example.com", emailVerified: true }
  };
}

function matchingVerifier() {
  return {
    verify: vi.fn().mockResolvedValue({ subject: authUserId, sessionId: providerSessionId })
  };
}

function onboardingPrincipal() {
  return {
    id: appUserId,
    authUserId,
    email: baseUser.email,
    name: baseUser.name,
    role: baseUser.role,
    inviteStatus: InviteStatus.VERIFIED_PENDING_PASSWORD,
    isActive: true,
    authzVersion: 1,
    permissions: [],
    sessionId: appSessionId
  };
}

function refreshTransaction(overrides: Record<string, unknown> = {}) {
  return {
    $queryRaw: vi.fn().mockResolvedValue([{ observedAt: new Date() }]),
    $executeRaw: vi.fn(),
    appAuthSession: {
      findUnique: vi.fn().mockResolvedValue({
        id: appSessionId,
        appUser: baseUser,
        appUserId,
        providerSessionId,
        revokedAt: null,
        refreshedAt: null,
        ...overrides
      }),
      update: vi.fn().mockResolvedValue({})
    }
  };
}

function signedHandleFor(service: AuthService) {
  return signedHandle((service as never as { cookies: AuthCookieService }).cookies);
}

function signedHandle(cookies: AuthCookieService) {
  const captured = new Map<string, string>();
  cookies.setAuthenticatedCookies({
    cookie: (name: string, value: string) => { captured.set(name, value); }
  } as never, {
    accessToken: "access",
    refreshToken: "refresh",
    expiresIn: 60,
    sessionId: appSessionId
  });
  return captured.get(cookies.sessionCookieName)!;
}
