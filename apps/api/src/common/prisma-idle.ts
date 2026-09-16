export function resolvePrismaIdleDisconnectMs(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return 0;
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) throw new Error("PRISMA_IDLE_DISCONNECT_MS must be 0 or an integer between 1000 and 300000.");
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || (parsed !== 0 && (parsed < 1000 || parsed > 300000))) {
    throw new Error("PRISMA_IDLE_DISCONNECT_MS must be 0 or an integer between 1000 and 300000.");
  }
  return parsed;
}

/** Tracks whole transactions as well as individual queries, including raw SQL. */
export class PrismaIdlePool {
  private active = 0;
  private timer?: NodeJS.Timeout;
  private closing?: Promise<void>;
  private stopping = false;
  private drained?: () => void;

  constructor(
    private readonly idleMs: number,
    private readonly disconnect: () => Promise<void>,
    private readonly onIdleError: () => void = () => undefined
  ) {}

  async run<T>(operation: () => Promise<T>): Promise<T> {
    // A timeout claims the barrier before invoking disconnect. No query can
    // connect a new pool until that old close has finished, even if it fails.
    while (this.closing) await this.closing.catch(() => undefined);
    if (this.stopping && this.active === 0) throw new Error("PRISMA_SERVICE_STOPPING");
    this.active += 1;
    this.clearTimer();
    try {
      return await operation();
    } finally {
      this.active -= 1;
      if (this.active === 0) {
        this.drained?.();
        this.drained = undefined;
        this.arm();
      }
    }
  }

  async shutdown() {
    this.stopping = true;
    this.clearTimer();
    // Nested middleware may still run within a leased transaction while Nest
    // drains requests. Do not interrupt its gaps between database statements.
    while (this.active > 0) await new Promise<void>((resolve) => { this.drained = resolve; });
    if (this.closing) await this.closing;
    else await this.close();
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private arm() {
    if (!this.idleMs || this.stopping || this.active !== 0 || this.timer || this.closing) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.active !== 0 || this.stopping) return;
      void this.close().catch(() => {
        this.onIdleError();
        this.arm();
      });
    }, this.idleMs);
    this.timer.unref();
  }

  private close(): Promise<void> {
    // Assign synchronously; Promise.resolve defers the disconnect callback
    // until after new work can see this barrier.
    const closing = Promise.resolve().then(this.disconnect).finally(() => {
      if (this.closing === closing) this.closing = undefined;
    });
    this.closing = closing;
    return closing;
  }
}
