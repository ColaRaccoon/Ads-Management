import { AppRole, InviteStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { BootstrapSuperAdminService, describeDatabaseTarget } from "./bootstrap-super-admin";

const authUserId = "11111111-1111-4111-8111-111111111111";
const existingId = "22222222-2222-4222-8222-222222222222";

describe("BootstrapSuperAdminService", () => {
  it("supports a read-only dry-run", async () => {
    const prisma = prismaFake(null, null);
    const service = new BootstrapSuperAdminService(prisma as never, providerFake());
    await expect(service.run({ authUserId, email: "admin@example.com", dryRun: true }))
      .resolves.toEqual({ action: "create", dryRun: true, appUserId: null });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.appUser.create).not.toHaveBeenCalled();
  });

  it("rejects a provider subject with the wrong or unverified email", async () => {
    const service = new BootstrapSuperAdminService(prismaFake(null, null) as never, providerFake({
      email: "other@example.com"
    }));
    await expect(service.run({ authUserId, email: "admin@example.com", dryRun: true }))
      .rejects.toThrow("BOOTSTRAP_PROVIDER_IDENTITY_MISMATCH");
  });

  it("stops when subject and normalized email belong to different rows", async () => {
    const bySubject = user({ id: existingId, normalizedEmail: "admin@example.com" });
    const byEmail = user({ id: "33333333-3333-4333-8333-333333333333", authUserId: null });
    const service = new BootstrapSuperAdminService(
      prismaFake(bySubject, byEmail) as never,
      providerFake()
    );
    await expect(service.run({ authUserId, email: "admin@example.com", dryRun: true }))
      .rejects.toThrow("BOOTSTRAP_IDENTITY_ALREADY_LINKED");
  });

  it("explicitly links and activates only the selected AppUser", async () => {
    const existing = user({ authUserId: null, role: AppRole.ADMIN, inviteStatus: InviteStatus.ACTIVE });
    const prisma = prismaFake(null, existing);
    const service = new BootstrapSuperAdminService(prisma as never, providerFake());
    await expect(service.run({ authUserId, email: "admin@example.com", dryRun: false }))
      .resolves.toEqual({ action: "update", dryRun: false, appUserId: existingId });
    expect(prisma.appUser.update).toHaveBeenCalledWith({
      where: { id: existingId },
      data: expect.objectContaining({
        authUserId,
        role: AppRole.SUPER_ADMIN,
        inviteStatus: InviteStatus.ACTIVE,
        isActive: true,
        authzVersion: { increment: 1 }
      })
    });
  });

  it("describes a DB target without credentials", () => {
    expect(describeDatabaseTarget(
      "postgresql://user:secret@db.abcdefghijklmnopqrst.supabase.co:5432/database?schema=security"
    )).toEqual({ host: "db.abcdefghijklmnopqrst.supabase.co", port: "5432", database: "database", schema: "security" });
  });
});

function providerFake(overrides: Partial<{ id: string; email: string; emailVerified: boolean }> = {}) {
  return {
    getUserById: vi.fn().mockResolvedValue({
      id: authUserId,
      email: "admin@example.com",
      emailVerified: true,
      ...overrides
    })
  } as never;
}

function prismaFake(bySubject: any, byEmail: any) {
  const appUser = {
    findUnique: vi.fn().mockImplementation(({ where }: any) =>
      "authUserId" in where ? bySubject : byEmail
    ),
    create: vi.fn(),
    update: vi.fn().mockImplementation(async ({ data }: any) => ({
      ...byEmail,
      ...data,
      id: byEmail?.id ?? existingId
    }))
  };
  const prisma: any = { appUser };
  prisma.$transaction = vi.fn(async (callback: (tx: any) => unknown) => callback({ appUser }));
  return prisma;
}

function user(overrides: Record<string, unknown> = {}) {
  return {
    id: existingId,
    authUserId,
    email: "admin@example.com",
    normalizedEmail: "admin@example.com",
    name: "Admin",
    role: AppRole.SUPER_ADMIN,
    inviteStatus: InviteStatus.ACTIVE,
    isActive: true,
    deactivatedAt: null,
    ...overrides
  };
}
