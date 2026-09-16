// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { POLLING_IDLE_MS, resetUserActivity, SESSION_IDLE_MS, userActivityAge, watchUserActivity } from "./session-activity";
let stop: (() => void) | undefined;
afterEach(() => { stop?.(); stop = undefined; localStorage.clear(); vi.useRealTimers(); });
describe("two-hour user inactivity", () => {
  it("pauses polling after five minutes without ending the session and resumes on input", () => {
    vi.useFakeTimers(); const idle = vi.fn(); const heartbeat = vi.fn(); const polling = vi.fn();
    stop = watchUserActivity("user", idle, heartbeat, polling);
    vi.advanceTimersByTime(POLLING_IDLE_MS);
    expect(polling).toHaveBeenLastCalledWith(false);
    expect(idle).not.toHaveBeenCalled();
    expect(heartbeat).not.toHaveBeenCalled();
    window.dispatchEvent(new Event("pointerdown"));
    expect(polling).toHaveBeenLastCalledWith(true);
    expect(heartbeat).toHaveBeenCalledOnce();
  });
  it("shares resumed activity across tabs but focus alone does not extend the deadline", () => {
    vi.useFakeTimers(); const idle = vi.fn(); const heartbeat = vi.fn(); const polling = vi.fn();
    stop = watchUserActivity("user", idle, heartbeat, polling);
    vi.advanceTimersByTime(POLLING_IDLE_MS);
    window.dispatchEvent(new Event("focus"));
    expect(heartbeat).toHaveBeenCalledOnce();
    expect(polling).toHaveBeenLastCalledWith(false);
    expect(userActivityAge()).toBeUndefined();
    localStorage.setItem("meta-ads.activity.user", String(Date.now()));
    vi.advanceTimersByTime(1_000);
    expect(polling).toHaveBeenLastCalledWith(true);
    expect(heartbeat).toHaveBeenCalledTimes(2);
    expect(idle).not.toHaveBeenCalled();
  });
  it("does not count background reads as input and logs out at two hours", () => {
    vi.useFakeTimers(); const idle = vi.fn(); const heartbeat = vi.fn();
    stop = watchUserActivity("user", idle, heartbeat);
    vi.advanceTimersByTime(60_001);
    expect(userActivityAge()).toBeUndefined();
    vi.advanceTimersByTime(SESSION_IDLE_MS - 60_002);
    expect(idle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(idle).toHaveBeenCalledOnce(); expect(heartbeat).not.toHaveBeenCalled();
  });
  it("renews the deadline on input, throttles heartbeats and shares the timestamp", () => {
    vi.useFakeTimers(); const idle = vi.fn(); const heartbeat = vi.fn();
    stop = watchUserActivity("user", idle, heartbeat);
    vi.advanceTimersByTime(SESSION_IDLE_MS - 1_000);
    window.dispatchEvent(new Event("keydown")); window.dispatchEvent(new Event("scroll"));
    expect(heartbeat).toHaveBeenCalledOnce(); expect(userActivityAge()).toBe(0);
    vi.advanceTimersByTime(2_000); expect(idle).not.toHaveBeenCalled();
    localStorage.setItem("meta-ads.activity.user", String(Date.now()));
    expect(userActivityAge()).toBe(0);
    vi.advanceTimersByTime(SESSION_IDLE_MS); expect(idle).toHaveBeenCalledOnce();
  });
  it("does not revive an expired session after browser sleep", () => {
    vi.useFakeTimers(); const idle = vi.fn(); const heartbeat = vi.fn();
    stop = watchUserActivity("user", idle, heartbeat);
    vi.setSystemTime(Date.now() + SESSION_IDLE_MS);
    window.dispatchEvent(new Event("pointerdown"));
    expect(idle).toHaveBeenCalledOnce(); expect(heartbeat).not.toHaveBeenCalled();
  });
  it("retains the idle deadline on remount and resets it only on explicit login", () => {
    vi.useFakeTimers(); const idle = vi.fn();
    stop = watchUserActivity("user", idle, vi.fn()); stop();
    vi.setSystemTime(Date.now() + SESSION_IDLE_MS);
    stop = watchUserActivity("user", idle, vi.fn()); expect(idle).toHaveBeenCalledOnce(); stop();
    resetUserActivity("user"); stop = watchUserActivity("user", idle, vi.fn());
    expect(userActivityAge()).toBe(0); expect(idle).toHaveBeenCalledOnce();
  });
});
