import { describe, expect, it } from "vitest";
import { authLoginPayload, parseWebAuthProvider } from "./auth-provider";

describe("web auth provider configuration", () => {
  it("keeps the existing local experience as the development default", () => {
    expect(parseWebAuthProvider(undefined)).toBe("local");
    expect(parseWebAuthProvider(" LOCAL ")).toBe("local");
  });

  it("selects the Supabase login contract explicitly", () => {
    expect(parseWebAuthProvider("supabase")).toBe("supabase");
    expect(authLoginPayload("user@example.test", "password", "supabase"))
      .toEqual({ email: "user@example.test", password: "password" });
    expect(authLoginPayload("local.user", "password", "local"))
      .toEqual({ username: "local.user", password: "password" });
  });

  it("fails closed for an unknown public provider value", () => {
    expect(() => parseWebAuthProvider("legacy"))
      .toThrow("NEXT_PUBLIC_AUTH_PROVIDER must be either supabase or local.");
  });
});
