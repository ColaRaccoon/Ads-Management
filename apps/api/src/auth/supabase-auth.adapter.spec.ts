import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthConfig } from "./auth.config";
import { ProviderPasswordPolicyError, ProviderUnavailableError } from "./identity-provider";
import { providerFetch, SupabaseAuthAdapter } from "./supabase-auth.adapter";

const config = {
  supabaseUrl: "https://example.supabase.co",
  supabasePublishableKey: "publishable-test-value",
  supabaseSecretKey: "test-admin-credential-placeholder"
} as AuthConfig;

describe("SupabaseAuthAdapter provider transport", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("aborts a provider request at the configured upper bound", async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(providerFetch("https://project.supabase.co/auth/v1/token", undefined, 5))
      .rejects.toMatchObject({ name: "TimeoutError" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://project.supabase.co/auth/v1/token",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it("updates the first password with the onboarding access JWT and returns only safe identity fields", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: "11111111-1111-4111-8111-111111111111",
      email: "guest@example.com",
      email_confirmed_at: "2026-08-25T00:00:00Z",
      user_metadata: { invitation_request_id: "22222222-2222-4222-8222-222222222222" }
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await new SupabaseAuthAdapter(config).updatePassword("onboarding-access", "long-password-value");
    expect(result).toEqual({
      id: "11111111-1111-4111-8111-111111111111",
      email: "guest@example.com",
      emailVerified: true,
      invitationRequestId: "22222222-2222-4222-8222-222222222222"
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.supabase.co/auth/v1/user",
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({ authorization: "Bearer onboarding-access" })
      })
    );
    expect(JSON.stringify(result)).not.toContain("long-password-value");
  });

  it("classifies provider password policy and transport failures without raw messages", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("provider raw", { status: 422 })));
    await expect(new SupabaseAuthAdapter(config).updatePassword("access", "weak"))
      .rejects.toBeInstanceOf(ProviderPasswordPolicyError);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network raw")));
    await expect(new SupabaseAuthAdapter(config).updatePassword("access", "strong-password"))
      .rejects.toBeInstanceOf(ProviderUnavailableError);
  });
});
