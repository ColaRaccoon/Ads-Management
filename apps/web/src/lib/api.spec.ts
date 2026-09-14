import { afterEach, describe, expect, it, vi } from "vitest";
import {
  apiGet,
  apiPost,
  apiRequest,
  csrfTokenFromCookieString,
  invalidateApiSession,
  parseApiErrorPayload,
  resetApiClientForTests,
  subscribeAuthLifecycle
} from "./api";

afterEach(() => {
  resetApiClientForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("API error payload parsing", () => {
  it("prefers a validated domain code from the exception details envelope", () => {
    expect(parseApiErrorPayload(JSON.stringify({
      code: "ConflictException",
      message: "The category changed after it was loaded.",
      details: {
        code: "COUPANG_DAILY_CATEGORY_CHANGED",
        message: "The category changed after it was loaded."
      }
    }))).toEqual({
      code: "COUPANG_DAILY_CATEGORY_CHANGED",
      message: "The category changed after it was loaded."
    });
  });

  it("rejects untrusted codes and control-heavy or oversized messages", () => {
    expect(parseApiErrorPayload(JSON.stringify({
      code: "<script>alert(1)</script>",
      message: "x".repeat(501),
      details: { code: "__proto__.polluted" }
    }))).toEqual({ code: null, message: null });
  });

  it("returns a safe empty result for non-JSON and non-object payloads", () => {
    expect(parseApiErrorPayload("<html>proxy error</html>"))
      .toEqual({ code: null, message: null });
    expect(parseApiErrorPayload(JSON.stringify(["unexpected"])))
      .toEqual({ code: null, message: null });
  });
});

describe("authenticated API request layer", () => {
  it.each([503, 429])("keeps the session after a temporary refresh error (%i)", async (status) => {
    const events = vi.fn();
    subscribeAuthLifecycle(events);
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(errorResponse(401, "ACCESS_TOKEN_EXPIRED"))
      .mockResolvedValueOnce(errorResponse(status, status === 503 ? "AUTH_PROVIDER_UNAVAILABLE" : "RATE_LIMITED")));
    await expect(apiGet("/auth/me")).rejects.toMatchObject({ status });
    expect(events).not.toHaveBeenCalled();
  });

  it("ends the session when refresh is definitively revoked", async () => {
    const events = vi.fn();
    subscribeAuthLifecycle(events);
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(errorResponse(401, "ACCESS_TOKEN_EXPIRED"))
      .mockResolvedValueOnce(errorResponse(401, "SESSION_REVOKED")));
    await expect(apiGet("/auth/me")).rejects.toMatchObject({ code: "SESSION_REVOKED" });
    expect(events).toHaveBeenCalledWith({ type: "session-invalid", code: "SESSION_REVOKED" });
  });

  it("includes credentials and applies JSON and CSRF headers to mutations", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("document", { cookie: "meta_csrf=csrf-value" });

    await apiPost("/products", { name: "test" });

    const [, init] = fetchMock.mock.calls[0];
    const headers = init?.headers as Headers;
    expect(init).toMatchObject({ method: "POST", credentials: "include" });
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-csrf-token")).toBe("csrf-value");
    expect(init?.body).toBe(JSON.stringify({ name: "test" }));
  });

  it("lets the browser set a FormData boundary and accepts 204 responses", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const body = new FormData();
    body.append("file", new Blob(["a,b"]), "input.csv");

    await expect(apiRequest("/uploads/test", { method: "POST", body })).resolves.toBeUndefined();

    const [, init] = fetchMock.mock.calls[0];
    expect((init?.headers as Headers).has("content-type")).toBe(false);
    expect(init?.body).toBe(body);
  });

  it("refreshes only ACCESS_TOKEN_EXPIRED with one shared refresh and retries each request once", async () => {
    let dataCalls = 0;
    let refreshCalls = 0;
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/auth/refresh")) {
        refreshCalls += 1;
        await Promise.resolve();
        return jsonResponse({ refreshed: true });
      }
      dataCalls += 1;
      return dataCalls <= 2
        ? errorResponse(401, "ACCESS_TOKEN_EXPIRED")
        : jsonResponse({ request: dataCalls });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(Promise.all([apiGet("/products"), apiGet("/settings")]))
      .resolves.toHaveLength(2);
    expect(refreshCalls).toBe(1);
    expect(dataCalls).toBe(4);
  });

  it("does not retry an unknown 401 mutation whose execution status is unclear", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => errorResponse(401, null));
    vi.stubGlobal("fetch", fetchMock);

    await expect(apiPost("/decisions/run", {})).rejects.toMatchObject({ status: 401, code: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the session on PERMISSION_DENIED and emits one auth revalidation event", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => errorResponse(403, "PERMISSION_DENIED")));
    const events: string[] = [];
    const unsubscribe = subscribeAuthLifecycle((event) => events.push(event.type));

    await expect(apiPost("/settings/secret", {})).rejects.toMatchObject({ code: "PERMISSION_DENIED" });

    expect(events).toEqual(["permission-denied"]);
    unsubscribe();
  });

  it("emits distinct invalid, onboarding, and provisioning lifecycle events", async () => {
    const codes = ["SESSION_REVOKED", "ACCOUNT_ONBOARDING_REQUIRED", "ACCOUNT_NOT_PROVISIONED"];
    const events: string[] = [];
    subscribeAuthLifecycle((event) => events.push(event.type));
    const fetchMock = vi.fn<typeof fetch>(async () => errorResponse(403, codes.shift() ?? null));
    vi.stubGlobal("fetch", fetchMock);

    await expect(apiGet("/one")).rejects.toBeTruthy();
    await expect(apiGet("/two")).rejects.toBeTruthy();
    await expect(apiGet("/three")).rejects.toBeTruthy();

    expect(events).toEqual(["session-invalid", "onboarding-required", "account-not-provisioned"]);
  });

  it("reads either development or __Host CSRF cookie without exposing HttpOnly tokens", () => {
    expect(csrfTokenFromCookieString("one=1; meta_csrf=dev.token; two=2")).toBe("dev.token");
    expect(csrfTokenFromCookieString("__Host-meta_csrf=prod.token")).toBe("prod.token");
    expect(csrfTokenFromCookieString("__Host-staging-meta_csrf=staging.token"))
      .toBe("staging.token");
    expect(csrfTokenFromCookieString("__Host-UPPER-meta_csrf=invalid")).toBeNull();
    expect(csrfTokenFromCookieString(`__Host-${"a".repeat(21)}-meta_csrf=invalid`)).toBeNull();
    expect(csrfTokenFromCookieString("meta_access=secret")).toBeNull();
  });

  it("discards an in-flight user response after logout or account change", async () => {
    let complete: ((response: Response) => void) | undefined;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(() => new Promise<Response>((resolve) => {
      complete = resolve;
    })));

    const request = apiGet("/products");
    invalidateApiSession();
    complete?.(jsonResponse([{ id: "old-user-data" }]));

    await expect(request).rejects.toMatchObject({ code: "AUTH_CONTEXT_CHANGED" });
  });

  it("discards an old-user response when auth changes while its body is being consumed", async () => {
    let completeBody: ((value: string) => void) | undefined;
    const response = new Response(JSON.stringify([{ id: "old-user-data" }]));
    vi.spyOn(response, "text").mockImplementation(() => new Promise<string>((resolve) => {
      completeBody = resolve;
    }));
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => response));

    const request = apiGet("/products");
    await vi.waitFor(() => expect(completeBody).toBeTypeOf("function"));
    invalidateApiSession();
    completeBody?.(JSON.stringify([{ id: "old-user-data" }]));

    await expect(request).rejects.toMatchObject({ code: "AUTH_CONTEXT_CHANGED" });
  });
});

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

function errorResponse(status: number, code: string | null) {
  return new Response(JSON.stringify({ code, message: "Request failed.", details: null }), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
