export type AuthSyncEvent =
  | { type: "refresh-start"; sender: string; at: number }
  | { type: "refresh-complete"; sender: string; at: number; generation: number }
  | { type: "logout"; sender: string; at: number }
  | { type: "account-changed"; sender: string; at: number }
  | { type: "authorization-changed"; sender: string; at: number; authorizationVersion: string };

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type ChannelLike = {
  postMessage(value: AuthSyncEvent): void;
  addEventListener(type: "message", listener: (event: MessageEvent<AuthSyncEvent>) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent<AuthSyncEvent>) => void): void;
};
type LocksLike = {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
};

const CHANNEL_NAME = "meta-ads-auth-v1";
const GENERATION_KEY = "meta-ads.auth.refresh-generation";
const LEASE_KEY = "meta-ads.auth.refresh-lease";
const LOCK_NAME = "meta-ads.auth.refresh";
const LEASE_MS = 4_000;

export class AuthCoordinator {
  private readonly sender = createSenderId();
  private readonly listeners = new Set<(event: AuthSyncEvent) => void>();
  private readonly onMessage = (event: MessageEvent<AuthSyncEvent>) => {
    if (!isAuthSyncEvent(event.data) || event.data.sender === this.sender) return;
    this.observedGeneration = Math.max(
      this.observedGeneration,
      event.data.type === "refresh-complete" ? event.data.generation : 0
    );
    for (const listener of this.listeners) listener(event.data);
  };
  private observedGeneration = 0;

  constructor(
    private readonly storage: StorageLike | null = browserStorage(),
    private readonly channel: ChannelLike | null = browserChannel(),
    private readonly locks: LocksLike | null = browserLocks()
  ) {
    this.channel?.addEventListener("message", this.onMessage);
  }

  subscribe(listener: (event: AuthSyncEvent) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  broadcastLogout() {
    this.send({ type: "logout", sender: this.sender, at: Date.now() });
  }

  broadcastAccountChanged() {
    this.send({ type: "account-changed", sender: this.sender, at: Date.now() });
  }

  broadcastAuthorizationChanged(authorizationVersion: string) {
    this.send({
      type: "authorization-changed",
      sender: this.sender,
      at: Date.now(),
      authorizationVersion
    });
  }

  async runRefresh(task: () => Promise<void>): Promise<"performed" | "peer-completed"> {
    const generation = this.generation();
    if (this.locks) {
      return this.locks.request(LOCK_NAME, async () => {
        if (this.generation() > generation) return "peer-completed";
        return this.performRefresh(task);
      });
    }
    if (!this.storage) return this.performRefresh(task);
    return this.runRefreshWithLease(generation, task);
  }

  async runExclusive<T>(task: () => Promise<T>): Promise<T> {
    if (this.locks) return this.locks.request(LOCK_NAME, task);
    if (!this.storage) return task();
    const deadline = Date.now() + LEASE_MS;
    while (Date.now() < deadline) {
      if (this.acquireLease()) {
        try {
          return await task();
        } finally {
          this.releaseLease();
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Authentication operation coordination timed out.");
  }

  async waitForPeerRefresh(afterGeneration = this.generation(), timeoutMs = LEASE_MS) {
    if (this.generation() > afterGeneration) return true;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (result: boolean) => {
        if (settled) return;
        settled = true;
        clearInterval(poll);
        clearTimeout(timeout);
        unsubscribe();
        resolve(result);
      };
      const unsubscribe = this.subscribe((event) => {
        if (event.type === "refresh-complete" && event.generation > afterGeneration) finish(true);
      });
      const poll = setInterval(() => {
        if (this.generation() > afterGeneration) finish(true);
      }, 50);
      const timeout = setTimeout(() => finish(false), timeoutMs);
    });
  }

  private async runRefreshWithLease(
    initialGeneration: number,
    task: () => Promise<void>
  ): Promise<"performed" | "peer-completed"> {
    const deadline = Date.now() + LEASE_MS;
    while (Date.now() < deadline) {
      if (this.generation() > initialGeneration) return "peer-completed";
      if (this.acquireLease()) {
        try {
          if (this.generation() > initialGeneration) return "peer-completed";
          return await this.performRefresh(task);
        } finally {
          this.releaseLease();
        }
      }
      if (await this.waitForPeerRefresh(initialGeneration, 250)) return "peer-completed";
    }
    if (this.acquireLease()) {
      try {
        if (this.generation() > initialGeneration) return "peer-completed";
        return await this.performRefresh(task);
      } finally {
        this.releaseLease();
      }
    }
    throw new Error("Authentication refresh coordination timed out.");
  }

  private async performRefresh(task: () => Promise<void>): Promise<"performed"> {
    this.send({ type: "refresh-start", sender: this.sender, at: Date.now() });
    await task();
    const generation = this.generation() + 1;
    this.observedGeneration = generation;
    try {
      this.storage?.setItem(GENERATION_KEY, String(generation));
    } catch {
      // BroadcastChannel still provides a bounded best-effort fallback.
    }
    this.send({
      type: "refresh-complete",
      sender: this.sender,
      at: Date.now(),
      generation
    });
    return "performed";
  }

  private acquireLease() {
    if (!this.storage) return true;
    const now = Date.now();
    try {
      const current = parseLease(this.storage.getItem(LEASE_KEY));
      if (current && current.expiresAt > now && current.sender !== this.sender) return false;
      this.storage.setItem(LEASE_KEY, JSON.stringify({ sender: this.sender, expiresAt: now + LEASE_MS }));
      return parseLease(this.storage.getItem(LEASE_KEY))?.sender === this.sender;
    } catch {
      return true;
    }
  }

  private releaseLease() {
    if (!this.storage) return;
    try {
      if (parseLease(this.storage.getItem(LEASE_KEY))?.sender === this.sender) {
        this.storage.removeItem(LEASE_KEY);
      }
    } catch {
      // The short lease expires without storing credentials.
    }
  }

  private generation() {
    let stored = 0;
    try {
      stored = Number(this.storage?.getItem(GENERATION_KEY) ?? 0);
    } catch {
      stored = 0;
    }
    return Math.max(this.observedGeneration, Number.isSafeInteger(stored) && stored >= 0 ? stored : 0);
  }

  private send(event: AuthSyncEvent) {
    this.channel?.postMessage(event);
  }
}

export const authCoordinator = new AuthCoordinator();

function browserStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function browserChannel(): ChannelLike | null {
  try {
    return typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CHANNEL_NAME);
  } catch {
    return null;
  }
}

function browserLocks(): LocksLike | null {
  if (typeof navigator === "undefined" || !("locks" in navigator)) return null;
  return navigator.locks as unknown as LocksLike;
}

function createSenderId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function parseLease(raw: string | null) {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (
      typeof value !== "object" || value === null ||
      typeof (value as { sender?: unknown }).sender !== "string" ||
      typeof (value as { expiresAt?: unknown }).expiresAt !== "number"
    ) return null;
    return value as { sender: string; expiresAt: number };
  } catch {
    return null;
  }
}

function isAuthSyncEvent(value: unknown): value is AuthSyncEvent {
  return typeof value === "object" && value !== null &&
    typeof (value as { type?: unknown }).type === "string" &&
    typeof (value as { sender?: unknown }).sender === "string" &&
    typeof (value as { at?: unknown }).at === "number";
}
