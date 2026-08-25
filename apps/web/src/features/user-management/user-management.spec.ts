import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import {
  createIdempotencyKey,
  invitationAcceptanceError,
  normalizeInvitationPayload,
  parseAuditResponse,
  parseUsersResponse,
  safeAuditSummary,
  takeInvitationTokenHash,
  validateInvitationPayload
} from "./user-management";

describe("user management boundary parsing", () => {
  it("normalizes invitations and creates RFC 4122 UUID idempotency keys", () => {
    const payload = normalizeInvitationPayload({ email: "  USER@Example.Test ", name: " 사용자 ", role: "GUEST" });
    expect(payload).toEqual({ email: "user@example.test", name: "사용자", role: "GUEST" });
    expect(validateInvitationPayload(payload)).toBeNull();
    expect(createIdempotencyKey()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(validateInvitationPayload({ ...payload, email: "not-an-email" })).toContain("이메일");
  });

  it("rejects non-ASCII and control-character invitation email values", () => {
    expect(validateInvitationPayload({ email: "ü@example.com", name: "User", role: "USER" }))
      .toBe("올바른 이메일 주소를 입력해 주세요.");
    expect(validateInvitationPayload({ email: "user\u0000@example.com", name: "User", role: "USER" }))
      .toBe("올바른 이메일 주소를 입력해 주세요.");
  });

  it("retains only the documented user summary fields", () => {
    const users = parseUsersResponse({
      items: [{
        id: "user-1",
        email: "user@example.test",
        name: "사용자",
        role: "USER",
        isActive: true,
        inviteStatus: "ACTIVE",
        reconciliationActions: [],
        lastLoginAt: null,
        invitedAt: "2026-08-25T00:00:00.000Z",
        createdAt: "2026-08-25T00:00:00.000Z",
        updatedAt: "2026-08-25T00:00:00.000Z",
        authUserId: "provider-subject-secret",
        accessToken: "provider-token-secret",
        metadata: { password: "never-render" }
      }]
    });

    expect(users).toHaveLength(1);
    expect(JSON.stringify(users)).not.toContain("provider-subject-secret");
    expect(JSON.stringify(users)).not.toContain("provider-token-secret");
    expect(JSON.stringify(users)).not.toContain("never-render");
  });

  it("fails closed on an unexpected reconciliation action", () => {
    expect(() => parseUsersResponse({
      items: [{
        id: "user-1",
        email: "user@example.test",
        name: "사용자",
        role: "USER",
        isActive: true,
        inviteStatus: "RECONCILE_REQUIRED",
        reconciliationActions: ["DELETE_PROVIDER_USER"],
        lastLoginAt: null,
        invitedAt: null,
        createdAt: "2026-08-25T00:00:00.000Z",
        updatedAt: "2026-08-25T00:00:00.000Z"
      }]
    })).toThrow("서버 응답 형식이 올바르지 않습니다.");
  });

  it("reduces audit JSON to an allowlisted summary before caching", () => {
    const page = parseAuditResponse({
      items: [{
        id: "audit-1",
        actorUserId: "actor-1",
        actorType: "USER",
        action: "USER_ROLE_CHANGED",
        targetType: "AppUser",
        targetId: "user-1",
        result: "SUCCESS",
        beforeJson: { role: "GUEST", password: "secret-before", tokenHash: "hash-before" },
        afterJson: { role: "USER", password: "secret-after", providerResponse: { token: "provider-token" } },
        requestId: "request-1",
        createdAt: "2026-08-25T00:00:00.000Z"
      }],
      nextCursor: "opaque-cursor"
    });

    expect(page.items[0].summary).toBe("역할: 게스트 → 사용자");
    expect(JSON.stringify(page)).not.toMatch(/secret-before|secret-after|hash-before|provider-token/);
    expect(page.nextCursor).toBe("opaque-cursor");
  });

  it("never includes arbitrary nested or control-character audit values", () => {
    expect(safeAuditSummary(
      { name: "before", email: "private@example.test", token: "secret" },
      { name: "after\nforged", email: "other@example.test", token: "new-secret" }
    )).toBe("이름: before → -");
  });

  it("removes the fragment without putting its value in the replacement URL", () => {
    const replaceState = vi.fn();
    const routerState = { __NA: true, tree: ["", {}] };
    const token = takeInvitationTokenHash({
      hash: "#token_hash=abcdefghijklmnopqrstuvwxyz012345",
      pathname: "/invite/accept",
      search: "?campaign=safe"
    } as Location, { replaceState, state: routerState } as unknown as History);

    expect(token).toBe("abcdefghijklmnopqrstuvwxyz012345");
    expect(replaceState).toHaveBeenCalledWith(routerState, "", "/invite/accept?campaign=safe");
    expect(JSON.stringify(replaceState.mock.calls)).not.toContain("abcdefghijklmnopqrstuvwxyz012345");
  });

  it("provides safe retry UX for throttling and preserves an active session conflict", () => {
    expect(invitationAcceptanceError(new ApiError(429, "raw backend detail", "RATE_LIMITED")))
      .toEqual(expect.objectContaining({ retryable: true, activeSession: false }));
    expect(invitationAcceptanceError(new ApiError(409, "raw account detail", "ACTIVE_SESSION_PRESENT")))
      .toEqual(expect.objectContaining({ retryable: true, activeSession: true }));
  });
});
