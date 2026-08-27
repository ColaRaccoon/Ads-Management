import { AppRole, InviteStatus } from "@prisma/client";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createCredential, ScryptWorkLimiter } from "./local-credentials";
import { LocalAuthService } from "./local-auth.service";

const userId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
let credential: Awaited<ReturnType<typeof createCredential>>;

beforeAll(async () => {
  credential = await createCredential("valid-password-12", new ScryptWorkLimiter(1, 0));
});

const config = {
  provider: "local", localScryptConcurrency: 1, localScryptQueueLimit: 1,
  localSessionTokenSecret: "b6a9d3f4187c2e9051ab6d7f830c4e92a5b8d1f6073c9e41a6b2d8f5071c3e94",
  localSetupTokenSecret: "c7b0e4a5298d3f0162bc7e8a941d5f03b6c9e2a7184d0f52b7c3e9a6182d4f05",
  localSessionIdleTtlMs: 1_800_000, localSessionAbsoluteTtlMs: 43_200_000,
  localSessionRotationTtlMs: 900_000, localSetupTokenTtlMs: 86_400_000
};
const activeUser = {
  id: userId, username: "local.user", email: null, name: "Local User", role: AppRole.USER,
  isActive: true, inviteStatus: InviteStatus.ACTIVE, authzVersion: 1, localCredential: null as never
};

describe("LocalAuthService", () => {
  it("performs the KDF before locking and creates login session and audit in one transaction", async () => {
    const user = { ...activeUser, localCredential: credential };
    const order: string[] = [];
    const tx = {
      $executeRaw: vi.fn().mockImplementation(async () => { order.push("session"); return 1; }),
      appUser: {
        findUnique: vi.fn().mockResolvedValue(user),
        update: vi.fn().mockImplementation(async () => { order.push("user"); return user; })
      },
      securityAuditEvent: { create: vi.fn().mockImplementation(async () => { order.push("audit"); return {}; }) }
    };
    const prisma = {
      appUser: { findUnique: vi.fn().mockImplementation(async () => { order.push("kdf-input"); return user; }) },
      $transaction: vi.fn(async (work: (client: typeof tx) => unknown) => { order.push("lock"); return work(tx); }),
      securityAuditEvent: { create: vi.fn() }
    };
    const result = await service(prisma).login("LOCAL.USER", "valid-password-12");
    expect(result.sessionToken).toMatch(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/i);
    expect(result.response.user).toMatchObject({ username: "local.user", inviteStatus: InviteStatus.ACTIVE });
    expect(order.indexOf("lock")).toBeGreaterThan(order.indexOf("kdf-input"));
    expect(order.slice(-3)).toEqual(["session", "user", "audit"]);
  });

  it.each([
    ["wrong password", { ...activeUser, localCredential: null }, "wrong-password-12"],
    ["inactive", { ...activeUser, isActive: false, localCredential: null }, "valid-password-12"],
    ["setup pending", { ...activeUser, inviteStatus: InviteStatus.INVITED, localCredential: null }, "valid-password-12"]
  ])("returns one stable credential error for %s", async (_name, changes, password) => {
    const user = { ...changes, localCredential: credential };
    const prisma = {
      appUser: { findUnique: vi.fn().mockResolvedValue(user) },
      securityAuditEvent: { create: vi.fn().mockResolvedValue({}) },
      $transaction: vi.fn()
    };
    await expect(service(prisma).login("local.user", password)).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("revokes a session immediately when its account is inactive", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: sessionId, appUserId: userId, onboardingOnly: false, rotationDue: false }]),
      appUser: { findUnique: vi.fn().mockResolvedValue({ ...activeUser, isActive: false }) },
      appAuthSession: { updateMany }
    };
    await expect(service(prisma).authenticateSession("A".repeat(43))).rejects.toMatchObject({ code: "SESSION_INVALID" });
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: sessionId, revokedAt: null } }));
  });

  it("revokes the current session family when logout receives an older valid family token", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const instance = service({ appAuthSession: { updateMany } });
    const oldToken = (instance as unknown as { createSessionToken(id: string): string }).createSessionToken(sessionId);
    await instance.logout(oldToken);
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: sessionId, revokedAt: null } }));
  });
});

function service(prisma: object) {
  return new LocalAuthService(
    prisma as never,
    config as never,
    { authorizationVersion: vi.fn().mockReturnValue("synthetic-version") } as never
  );
}
