// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiGet, apiPost, resetApiClientForTests } from "./api";
import { POLLING_IDLE_MS, SESSION_IDLE_MS, setActivityRevalidator, watchUserActivity } from "../features/auth/session-activity";

let stop: (() => void) | undefined;
let unregister: (() => void) | undefined;
afterEach(() => {
  stop?.(); unregister?.(); localStorage.clear(); resetApiClientForTests();
  vi.useRealTimers(); vi.unstubAllGlobals();
});
function idleSession(revalidate: () => Promise<void>) {
  vi.useFakeTimers();
  stop = watchUserActivity("idle-api-user", vi.fn(), vi.fn());
  unregister = setActivityRevalidator(revalidate);
  vi.advanceTimersByTime(POLLING_IDLE_MS);
  window.dispatchEvent(new Event("pointerdown"));
}

describe("post-idle authorization preflight", () => {
  it("holds concurrent writes behind one validation and sends each only once", async () => {
    let resolve!: () => void;
    const revalidate = vi.fn(() => new Promise<void>(done => { resolve = done; }));
    idleSession(revalidate);
    const fetch = vi.fn().mockImplementation(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetch);
    const first = apiPost("/products", { name: "one" });
    const second = apiPost("/products", { name: "two" });
    expect(revalidate).toHaveBeenCalledOnce(); expect(fetch).not.toHaveBeenCalled();
    resolve(); await Promise.all([first, second]);
    expect(fetch).toHaveBeenCalledTimes(2);
    await apiGet("/products");
    expect(revalidate).toHaveBeenCalledOnce();
  });
  it("does not send a write if validation fails, and retries validation on the next action", async () => {
    const revalidate = vi.fn().mockRejectedValueOnce(new Error("unavailable")).mockResolvedValue(undefined);
    idleSession(revalidate);
    const fetch = vi.fn().mockImplementation(async () => new Response("{}")); vi.stubGlobal("fetch", fetch);
    await expect(apiPost("/products", {})).rejects.toThrow("unavailable");
    expect(fetch).not.toHaveBeenCalled();
    await apiPost("/products", {});
    expect(revalidate).toHaveBeenCalledTimes(2); expect(fetch).toHaveBeenCalledOnce();
  });
  it("allows the auth preflight through without recursion and never replays a 502 mutation", async () => {
    idleSession(async () => { await apiGet("/auth/me"); });
    const fetch = vi.fn().mockResolvedValueOnce(new Response("{}"))
      .mockResolvedValueOnce(new Response("unavailable", { status: 502 }));
    vi.stubGlobal("fetch", fetch);
    await expect(apiPost("/products", {})).rejects.toMatchObject({ status: 502 });
    expect(fetch.mock.calls.map(call => call[0])).toEqual(["/backend-api/auth/me", "/backend-api/products"]);
  });
  it("does not cancel or discard an upload already in flight when polling pauses", async () => {
    vi.useFakeTimers(); stop = watchUserActivity("idle-api-user", vi.fn(), vi.fn());
    let finish!: (response: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })); vi.stubGlobal("fetch", fetch);
    const upload = apiPost("/uploads/meta-ad-daily-csv", new FormData());
    await Promise.resolve(); await Promise.resolve();
    expect(fetch).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(POLLING_IDLE_MS);
    finish(new Response('{"imported":1}'));
    await expect(upload).resolves.toEqual({ imported: 1 });
  });
  it("rejects a request past two hours even when browser timers have not fired", async () => {
    vi.useFakeTimers(); stop = watchUserActivity("idle-api-user", vi.fn(), vi.fn());
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    vi.setSystemTime(Date.now() + SESSION_IDLE_MS);
    await expect(apiPost("/products", {})).rejects.toThrow("로그인이 만료");
    expect(fetch).not.toHaveBeenCalled();
  });
});
