import { randomUUID } from "node:crypto";
import { AppRole, InviteStatus, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AuthService } from "../auth/auth.service";
import { lockInvitationState } from "./invite-state-machine";
import { UsersService } from "./users.service";

const enabled = integrationEnabled();
const integrationDescribe = enabled ? describe : describe.skip;
const KNOWN_FIXTURE_EMAIL_PATTERN =
  "^(actor|super-one|super-two|cas|cancel-actor|accept-cancel|restart-actor|restart)-" +
  "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}@example\\.com$";

integrationDescribe("user lifecycle PostgreSQL concurrency", () => {
  let prisma: PrismaClient;
  const runFixtureIds = new Set<string>();

  beforeAll(async () => {
    prisma = new PrismaClient({ datasourceUrl: process.env.TEST_DATABASE_URL });
    await prisma.$connect();
    const previousFixtureIds = await knownFixtureIds(prisma);
    await deactivateFixtures(prisma, previousFixtureIds);
    await expect(activeKnownFixtureCount(prisma)).resolves.toBe(0);
    await expect(activeKnownFixtureCount(prisma, AppRole.SUPER_ADMIN)).resolves.toBe(0);
  });

  afterAll(async () => {
    try {
      await deactivateFixtures(prisma, [...runFixtureIds]);
      await expect(activeFixtureCount(prisma, [...runFixtureIds])).resolves.toBe(0);
      await expect(activeKnownFixtureCount(prisma)).resolves.toBe(0);
      await expect(activeKnownFixtureCount(prisma, AppRole.SUPER_ADMIN)).resolves.toBe(0);
    } finally {
      await prisma.$disconnect();
    }
  });

  it("serializes concurrent last-SUPER_ADMIN demotions in real transactions", async () => {
    const suffix = randomUUID();
    const fixtureIds: string[] = [];
    let originalSupers: Array<{ id: string; isActive: boolean; deactivatedAt: Date | null }> = [];
    try {
      originalSupers = await prisma.appUser.findMany({
        where: {
          role: AppRole.SUPER_ADMIN,
          isActive: true,
          inviteStatus: InviteStatus.ACTIVE
        },
        select: { id: true, isActive: true, deactivatedAt: true }
      });
      await prisma.appUser.updateMany({
        where: { id: { in: originalSupers.map(({ id }) => id) } },
        data: { isActive: false }
      });
      const actor = trackFixture(
        await createActiveUser(prisma, suffix, "actor", AppRole.ADMIN),
        fixtureIds,
        runFixtureIds
      );
      const first = trackFixture(
        await createActiveUser(prisma, suffix, "super-one", AppRole.SUPER_ADMIN),
        fixtureIds,
        runFixtureIds
      );
      const second = trackFixture(
        await createActiveUser(prisma, suffix, "super-two", AppRole.SUPER_ADMIN),
        fixtureIds,
        runFixtureIds
      );
      const service = new UsersService(
        prisma as never,
        invitationProvider() as never,
        { allowedOrigins: new Set(["http://localhost:3200"]) } as never
      );
      const results = await Promise.allSettled([
        service.update(first.id, { role: AppRole.ADMIN }, actor.id),
        service.update(second.id, { role: AppRole.ADMIN }, actor.id)
      ]);
      expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
      const rejected = results.find(({ status }) => status === "rejected");
      expect(rejected).toMatchObject({
        status: "rejected",
        reason: { code: "LAST_ACTIVE_SUPER_ADMIN" }
      });
    } finally {
      try {
        await deactivateFixtures(prisma, fixtureIds);
      } finally {
        await restoreUserActivity(prisma, originalSupers);
      }
      await expect(activeFixtureCount(prisma, fixtureIds)).resolves.toBe(0);
      await assertUserActivityRestored(prisma, originalSupers);
    }
  });

  it("allows only one concurrent invitation compare-and-set after the shared advisory lock", async () => {
    const suffix = randomUUID();
    const fixtureIds: string[] = [];
    try {
      const user = trackFixture(await prisma.appUser.create({
        data: {
          email: `cas-${suffix}@example.com`,
          normalizedEmail: `cas-${suffix}@example.com`,
          name: "CAS invitation",
          role: AppRole.GUEST,
          isActive: true,
          inviteStatus: InviteStatus.INVITED,
          authUserId: randomUUID(),
          invitationRequestId: randomUUID()
        }
      }), fixtureIds, runFixtureIds);
      const compareAndSet = (next: InviteStatus) => prisma.$transaction(async (tx) => {
        await lockInvitationState(tx, user.id);
        const locked = await tx.appUser.findUnique({ where: { id: user.id } });
        if (locked?.inviteStatus !== InviteStatus.INVITED) throw new Error("CAS_MISS");
        await new Promise((resolve) => setTimeout(resolve, 25));
        return tx.appUser.update({
          where: { id: user.id },
          data: { inviteStatus: next }
        });
      });
      const results = await Promise.allSettled([
        compareAndSet(InviteStatus.VERIFIED_PENDING_PASSWORD),
        compareAndSet(InviteStatus.CANCELLED)
      ]);
      expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
      expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    } finally {
      await deactivateFixtures(prisma, fixtureIds);
      await expect(activeFixtureCount(prisma, fixtureIds)).resolves.toBe(0);
    }
  });

  it("uses the same AppUser lock for concurrent accept and cancel without resurrection", async () => {
    const suffix = randomUUID();
    const fixtureIds: string[] = [];
    try {
      const actor = trackFixture(
        await createActiveUser(prisma, suffix, "cancel-actor", AppRole.SUPER_ADMIN),
        fixtureIds,
        runFixtureIds
      );
      const authUserId = randomUUID();
      const requestId = randomUUID();
      const email = `accept-cancel-${suffix}@example.com`;
      const invited = trackFixture(await prisma.appUser.create({
        data: {
          email,
          normalizedEmail: email,
          name: "Accept cancel race",
          role: AppRole.GUEST,
          isActive: true,
          inviteStatus: InviteStatus.INVITED,
          authUserId,
          invitationRequestId: requestId,
          invitedAt: new Date(),
          invitedBy: actor.id
        }
      }), fixtureIds, runFixtureIds);
      const provider = invitationProvider({ authUserId, email, requestId });
      const auth = new AuthService(
        prisma as never,
        provider as never,
        { verify: vi.fn().mockResolvedValue({
          subject: authUserId,
          sessionId: randomUUID(),
          expiresAt: Math.floor(Date.now() / 1000) + 600
        }) } as never,
        { authorizationVersion: vi.fn().mockReturnValue("opaque") } as never
      );
      const users = new UsersService(
        prisma as never,
        provider as never,
        { allowedOrigins: new Set(["http://localhost:3200"]) } as never
      );

      await Promise.allSettled([
        auth.acceptInvitation("a".repeat(64)),
        users.reconcile(invited.id, "CANCEL", actor.id)
      ]);
      const final = await prisma.appUser.findUniqueOrThrow({ where: { id: invited.id } });
      expect(final.inviteStatus).toBe(InviteStatus.CANCELLED);
      expect(final.isActive).toBe(false);
      expect(final.authUserId).toBeNull();
      expect(await prisma.appAuthSession.count({
        where: { appUserId: invited.id, revokedAt: null }
      })).toBe(0);
    } finally {
      await deactivateFixtures(prisma, fixtureIds);
      await expect(activeFixtureCount(prisma, fixtureIds)).resolves.toBe(0);
    }
  });

  it("serializes concurrent idempotent restart of one compensated CANCELLED row", async () => {
    const suffix = randomUUID();
    const fixtureIds: string[] = [];
    try {
      const actor = trackFixture(
        await createActiveUser(prisma, suffix, "restart-actor", AppRole.SUPER_ADMIN),
        fixtureIds,
        runFixtureIds
      );
      const email = `restart-${suffix}@example.com`;
      const cancelled = trackFixture(await prisma.appUser.create({
        data: {
          email,
          normalizedEmail: email,
          name: "Cancelled invitation",
          role: AppRole.GUEST,
          isActive: false,
          inviteStatus: InviteStatus.CANCELLED,
          invitationRequestId: randomUUID(),
          invitationErrorCode: null,
          authUserId: null,
          deactivatedAt: new Date()
        }
      }), fixtureIds, runFixtureIds);
      const provider = invitationProvider({
        authUserId: randomUUID(),
        email,
        requestId: "set-per-call"
      });
      const service = new UsersService(
        prisma as never,
        provider as never,
        { allowedOrigins: new Set(["http://localhost:3200"]) } as never
      );
      const requestId = randomUUID();
      const payload = { email, name: "Restarted invitation", role: AppRole.USER };
      const results = await Promise.all([
        service.invite(payload, actor.id, requestId),
        service.invite(payload, actor.id, requestId)
      ]);
      expect(results.every(({ id }) => id === cancelled.id)).toBe(true);
      expect(provider.inviteUserByEmail).toHaveBeenCalledOnce();
      expect(await prisma.appUser.findUniqueOrThrow({ where: { id: cancelled.id } }))
        .toMatchObject({ inviteStatus: InviteStatus.INVITED, invitationRequestId: requestId });
    } finally {
      await deactivateFixtures(prisma, fixtureIds);
      await expect(activeFixtureCount(prisma, fixtureIds)).resolves.toBe(0);
    }
  });

  it("rejects UPDATE, DELETE, and TRUNCATE against the audit ledger without changing its count", async () => {
    const before = await prisma.securityAuditEvent.count();
    expect(before).toBeGreaterThan(0);
    for (const statement of [
      'UPDATE "security_audit_events" SET "action" = \'MUTATED\'',
      'DELETE FROM "security_audit_events"',
      'TRUNCATE TABLE "security_audit_events"'
    ]) {
      await expect(prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(statement);
      })).rejects.toThrow();
      await expect(prisma.securityAuditEvent.count()).resolves.toBe(before);
    }
  });
});

async function createActiveUser(
  prisma: PrismaClient,
  suffix: string,
  label: string,
  role: AppRole
) {
  const email = `${label}-${suffix}@example.com`;
  return prisma.appUser.create({
    data: {
      email,
      normalizedEmail: email,
      name: label,
      role,
      isActive: true,
      inviteStatus: InviteStatus.ACTIVE,
      authUserId: randomUUID()
    }
  });
}

function trackFixture<T extends { id: string }>(
  user: T,
  fixtureIds: string[],
  runFixtureIds: Set<string>
) {
  fixtureIds.push(user.id);
  runFixtureIds.add(user.id);
  return user;
}

async function deactivateFixtures(prisma: PrismaClient, ids: string[]) {
  if (ids.length === 0) return;
  const deactivatedAt = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.appAuthSession.updateMany({
      where: { appUserId: { in: ids }, revokedAt: null },
      data: { revokedAt: deactivatedAt }
    });
    await tx.appUser.updateMany({
      where: { id: { in: ids }, isActive: true },
      data: { isActive: false, deactivatedAt }
    });
  });
}

function activeFixtureCount(prisma: PrismaClient, ids: string[]) {
  if (ids.length === 0) return Promise.resolve(0);
  return prisma.appUser.count({ where: { id: { in: ids }, isActive: true } });
}

async function knownFixtureIds(prisma: PrismaClient) {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "app_users"
    WHERE "email" ~ ${KNOWN_FIXTURE_EMAIL_PATTERN}
  `;
  return rows.map(({ id }) => id);
}

async function activeKnownFixtureCount(prisma: PrismaClient, role?: AppRole) {
  const ids = await knownFixtureIds(prisma);
  if (ids.length === 0) return 0;
  return prisma.appUser.count({
    where: {
      id: { in: ids },
      isActive: true,
      role
    }
  });
}

async function restoreUserActivity(
  prisma: PrismaClient,
  snapshots: Array<{ id: string; isActive: boolean; deactivatedAt: Date | null }>
) {
  if (snapshots.length === 0) return;
  await prisma.$transaction(snapshots.map((snapshot) => prisma.appUser.update({
    where: { id: snapshot.id },
    data: {
      isActive: snapshot.isActive,
      deactivatedAt: snapshot.deactivatedAt
    }
  })));
}

async function assertUserActivityRestored(
  prisma: PrismaClient,
  snapshots: Array<{ id: string; isActive: boolean; deactivatedAt: Date | null }>
) {
  if (snapshots.length === 0) return;
  const restored = await prisma.appUser.findMany({
    where: { id: { in: snapshots.map(({ id }) => id) } },
    select: { id: true, isActive: true, deactivatedAt: true }
  });
  expect(restored).toHaveLength(snapshots.length);
  for (const snapshot of snapshots) {
    expect(restored.find(({ id }) => id === snapshot.id)).toMatchObject({
      isActive: snapshot.isActive,
      deactivatedAt: snapshot.deactivatedAt
    });
  }
}

function invitationProvider(options?: {
  authUserId: string;
  email: string;
  requestId: string;
}) {
  const fallbackId = options?.authUserId ?? randomUUID();
  return {
    signInWithPassword: vi.fn(),
    refreshSession: vi.fn(),
    revokeSession: vi.fn().mockResolvedValue(undefined),
    getUserById: vi.fn().mockImplementation(async () => ({
      id: fallbackId,
      email: options?.email ?? null,
      emailVerified: false,
      invitationRequestId: options?.requestId
    })),
    inviteUserByEmail: vi.fn().mockImplementation(async (
      email: string,
      _redirectTo: string,
      requestId: string
    ) => ({
      id: fallbackId,
      email,
      emailVerified: false,
      invitationRequestId: requestId
    })),
    verifyInvitationToken: vi.fn().mockResolvedValue({
      accessToken: "integration-onboarding-access",
      refreshToken: "integration-onboarding-refresh",
      expiresIn: 600,
      user: {
        id: fallbackId,
        email: options?.email ?? null,
        emailVerified: true,
        invitationRequestId: options?.requestId
      }
    }),
    updatePassword: vi.fn(),
    deleteInvitationUser: vi.fn().mockResolvedValue(undefined)
  };
}

function integrationEnabled() {
  if (process.env.RUN_DB_INTEGRATION !== "true") return false;
  const raw = process.env.TEST_DATABASE_URL;
  if (!raw) throw new Error("TEST_DATABASE_URL is required for DB integration tests.");
  const target = new URL(raw);
  if (
    target.hostname !== "127.0.0.1" || target.port !== "55432" ||
    target.pathname !== "/meta_ads_security_test" ||
    target.searchParams.get("schema") !== "meta_ads_security_test"
  ) {
    throw new Error("DB integration tests require the isolated local security test database.");
  }
  return true;
}
