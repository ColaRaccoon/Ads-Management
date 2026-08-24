import { describe, expect, it } from "vitest";
import { AuthCoordinator, AuthSyncEvent } from "./auth-coordination";

describe("multi-tab authentication coordination", () => {
  it("uses a short storage lease and BroadcastChannel generation so only one tab refreshes", async () => {
    const storage = new MemoryStorage();
    const channels = new ChannelBus();
    const first = new AuthCoordinator(storage, channels.channel(), null);
    const second = new AuthCoordinator(storage, channels.channel(), null);
    let firstCalls = 0;
    let secondCalls = 0;

    const firstRefresh = first.runRefresh(async () => {
      firstCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    const secondRefresh = second.runRefresh(async () => {
      secondCalls += 1;
    });

    await expect(Promise.all([firstRefresh, secondRefresh]))
      .resolves.toEqual(["performed", "peer-completed"]);
    expect(firstCalls + secondCalls).toBe(1);
  });

  it("uses Web Locks plus the shared generation to suppress a stale second refresh", async () => {
    const storage = new MemoryStorage();
    const channels = new ChannelBus();
    const locks = new SerialLocks();
    const first = new AuthCoordinator(storage, channels.channel(), locks);
    const second = new AuthCoordinator(storage, channels.channel(), locks);
    let calls = 0;

    const results = await Promise.all([
      first.runRefresh(async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }),
      second.runRefresh(async () => {
        calls += 1;
      })
    ]);

    expect(results).toEqual(["performed", "peer-completed"]);
    expect(calls).toBe(1);
  });

  it("broadcasts logout without copying credentials into shared state", async () => {
    const storage = new MemoryStorage();
    const channels = new ChannelBus();
    const first = new AuthCoordinator(storage, channels.channel(), null);
    const second = new AuthCoordinator(storage, channels.channel(), null);
    const event = new Promise<AuthSyncEvent>((resolve) => {
      first.subscribe(resolve);
    });

    second.broadcastLogout();

    await expect(event).resolves.toMatchObject({ type: "logout" });
    expect([...storage.values()].join(" ")).not.toMatch(/token|cookie|password/i);
  });
});

class MemoryStorage {
  private readonly valuesByKey = new Map<string, string>();
  getItem(key: string) { return this.valuesByKey.get(key) ?? null; }
  setItem(key: string, value: string) { this.valuesByKey.set(key, value); }
  removeItem(key: string) { this.valuesByKey.delete(key); }
  values() { return this.valuesByKey.values(); }
}

class ChannelBus {
  private readonly listeners = new Set<(event: MessageEvent<AuthSyncEvent>) => void>();
  channel() {
    return {
      postMessage: (value: AuthSyncEvent) => {
        for (const listener of this.listeners) listener({ data: value } as MessageEvent<AuthSyncEvent>);
      },
      addEventListener: (_type: "message", listener: (event: MessageEvent<AuthSyncEvent>) => void) => {
        this.listeners.add(listener);
      },
      removeEventListener: (_type: "message", listener: (event: MessageEvent<AuthSyncEvent>) => void) => {
        this.listeners.delete(listener);
      }
    };
  }
}

class SerialLocks {
  private tail: Promise<unknown> = Promise.resolve();
  request<T>(_name: string, callback: () => Promise<T>): Promise<T> {
    const result = this.tail.then(callback, callback);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
