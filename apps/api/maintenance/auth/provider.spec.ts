import { describe, expect, it, vi } from "vitest";
import { targetBindingSha256, type CloudTargetBinding } from "../shared/target-binding";
import {
  BoundAuthMaintenanceProvider,
  createSupabaseAdminTransport,
  normalizeProviderEmail,
  redactProviderError,
  type AuthAdminTransport
} from "./provider";

const projectRef = "iygjmosbelbosfxidqxv";
const userId = "11111111-1111-4111-8111-111111111111";

describe("BoundAuthMaintenanceProvider", () => {
  it("fails closed when the declared project and provider origin differ", () => {
    expect(() => new BoundAuthMaintenanceProvider({
      projectRef,
      providerOrigin: "https://abcdefghijklmnopqrst.supabase.co",
      transport: transportFake()
    })).toThrow("AUTH_PROVIDER_TARGET_MISMATCH");
  });

  it("normalizes lookup inputs and validates returned identities", async () => {
    const transport = transportFake();
    const provider = new BoundAuthMaintenanceProvider({
      projectRef,
      providerOrigin: `https://${projectRef}.supabase.co`,
      transport
    });

    await expect(provider.findUserByEmail(" Admin@Example.COM ")).resolves.toMatchObject({
      id: userId,
      email: "admin@example.com"
    });
    expect(transport.findUserByEmail).toHaveBeenCalledWith("admin@example.com");
  });

  it("passes only validated opaque identifiers to mutation transports", async () => {
    const transport = transportFake();
    const provider = new BoundAuthMaintenanceProvider({
      projectRef,
      providerOrigin: `https://${projectRef}.supabase.co`,
      transport
    });
    await provider.setUserDisabled({
      userId,
      disabled: true,
      idempotencyKey: "release:entry:disable:001"
    });
    expect(transport.setUserDisabled).toHaveBeenCalledWith({
      userId,
      disabled: true,
      idempotencyKey: "release:entry:disable:001"
    });
  });
});

describe("provider validation", () => {
  it("rejects non-ASCII or structurally invalid email input", () => {
    expect(() => normalizeProviderEmail("a @example.com")).toThrow("AUTH_EMAIL_INVALID");
    expect(() => normalizeProviderEmail("admin@example.com@other.test")).toThrow("AUTH_EMAIL_INVALID");
  });

  it("redacts unclassified provider failures", () => {
    expect(redactProviderError(new Error("request failed for admin@example.com: secret"))).toEqual(
      new Error("AUTH_PROVIDER_OPERATION_FAILED")
    );
    expect(redactProviderError(new Error("AUTH_PROVIDER_TIMEOUT"))).toEqual(
      new Error("AUTH_PROVIDER_TIMEOUT")
    );
  });
});

describe("concrete Supabase Admin transport", () => {
  it("performs zero provider I/O until target and TLS confirmation are exact", () => {
    const client = supabaseClientFake();
    expect(() => createSupabaseAdminTransport({
      target: target(),
      confirmation: { projectRef, releaseGitSha: releaseGitSha(), targetSha256: "f".repeat(64) },
      credentialPurpose: "SUPABASE_AUTH_ADMIN",
      tls: { authorized: true, mode: "verify-full", serverName: `${projectRef}.supabase.co` },
      client,
      now: clock()
    })).toThrow("CONFIRM_TARGET_SHA_MISMATCH");
    expect(client.auth.admin.getUserById).not.toHaveBeenCalled();
    expect(client.auth.admin.listUsers).not.toHaveBeenCalled();
  });

  it("maps the maintenance-only Admin API without exposing a credential", async () => {
    const client = supabaseClientFake();
    const transport = createSupabaseAdminTransport({
      target: target(),
      confirmation: {
        projectRef,
        releaseGitSha: releaseGitSha(),
        targetSha256: targetBindingSha256(target())
      },
      credentialPurpose: "SUPABASE_AUTH_ADMIN",
      tls: { authorized: true, mode: "verify-full", serverName: `${projectRef}.supabase.co` },
      client,
      now: clock()
    });
    await expect(transport.findUserById(userId)).resolves.toMatchObject({
      id: userId,
      emailVerified: true,
      disabled: false
    });
    expect(client.auth.admin.getUserById).toHaveBeenCalledWith(userId);
  });
});

function transportFake(): AuthAdminTransport & Record<string, ReturnType<typeof vi.fn>> {
  return {
    findUserById: vi.fn().mockResolvedValue({
      id: userId,
      email: "admin@example.com",
      emailVerified: true,
      disabled: false
    }),
    findUserByEmail: vi.fn().mockResolvedValue({
      id: userId,
      email: "admin@example.com",
      emailVerified: true,
      disabled: false
    }),
    inviteUser: vi.fn().mockResolvedValue({
      operationId: "operation-invite-001",
      invitationId: "invitation-owned-001",
      userId
    }),
    setUserDisabled: vi.fn().mockResolvedValue({ operationId: "operation-disable-001", userId }),
    removeInvitation: vi.fn().mockResolvedValue({ operationId: "operation-remove-001", userId })
  };
}

function supabaseClientFake() {
  const user = {
    id: userId,
    email: "admin@example.com",
    email_confirmed_at: "2026-09-01T00:00:00.000Z",
    banned_until: null,
    user_metadata: {}
  };
  return {
    auth: {
      admin: {
        getUserById: vi.fn().mockResolvedValue({ data: { user }, error: null }),
        listUsers: vi.fn().mockResolvedValue({ data: { users: [user], lastPage: 1 }, error: null }),
        inviteUserByEmail: vi.fn().mockResolvedValue({ data: { user }, error: null }),
        updateUserById: vi.fn().mockResolvedValue({ data: { user }, error: null }),
        deleteUser: vi.fn().mockResolvedValue({ data: {}, error: null })
      }
    }
  };
}

function releaseGitSha() {
  return "d0dd9081159a9acad24df458ca14b9f05bdc115a";
}

function clock() {
  return new Date("2026-09-02T01:00:00.000Z");
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
    releaseGitSha: releaseGitSha(),
    issuedAt: "2026-09-02T00:00:00.000Z",
    expiresAt: "2026-09-02T12:00:00.000Z"
  };
}
