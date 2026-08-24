import { afterEach, describe, expect, it, vi } from "vitest";
import { providerFetch } from "./supabase-auth.adapter";

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
});
