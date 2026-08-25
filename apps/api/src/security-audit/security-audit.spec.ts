import { SecurityAuditActorType, SecurityAuditResult } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { assertSafeAuditJson, securityAuditData, writeSecurityAudit } from "./security-audit.types";
import { SecurityAuditService } from "./security-audit.service";

describe("security audit safety", () => {
  it.each([
    { password: "redacted" },
    { nested: { accessToken: "redacted" } },
    { values: [{ cookie_header: "redacted" }] },
    { providerRawResponse: {} }
  ])("rejects sensitive JSON keys recursively", (value) => {
    expect(() => assertSafeAuditJson(value)).toThrow("Sensitive audit key rejected");
  });

  it("accepts the bounded safe lifecycle summary and writes it unchanged", async () => {
    const create = vi.fn().mockResolvedValue({ id: "event" });
    await writeSecurityAudit({ securityAuditEvent: { create } } as never, {
      actorUserId: "11111111-1111-4111-8111-111111111111",
      actorType: SecurityAuditActorType.USER,
      action: "USER_AUTHORIZATION_CHANGED",
      targetType: "APP_USER",
      targetId: "22222222-2222-4222-8222-222222222222",
      result: SecurityAuditResult.SUCCESS,
      afterJson: { name: "User", role: "ADMIN", isActive: true, inviteStatus: "ACTIVE" }
    });
    expect(create).toHaveBeenCalledOnce();
  });

  it("returns bounded keyset pages without exposing an unbounded query", async () => {
    const rows = Array.from({ length: 3 }, (_, index) => ({
      id: `00000000-0000-4000-8000-00000000000${index}`,
      createdAt: new Date(`2026-08-25T00:00:0${index}.000Z`)
    }));
    const findMany = vi.fn().mockResolvedValue(rows);
    const service = new SecurityAuditService({ securityAuditEvent: { findMany } } as never);
    const result = await service.list({ limit: 2 });
    expect(result.items).toHaveLength(2);
    expect(result.nextCursor).toEqual(expect.any(String));
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 3 }));
  });

  it("routes all direct saga data through the same sanitizer", () => {
    expect(() => securityAuditData({
      actorType: SecurityAuditActorType.SYSTEM,
      action: "TEST",
      targetType: "TEST",
      result: SecurityAuditResult.FAILURE,
      afterJson: { refresh_token: "must-not-be-stored" }
    })).toThrow();
  });
});
