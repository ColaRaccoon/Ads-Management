import { MAX_PROVIDER_ATTEMPTS, PAGE_ROW_LIMITS, REQUEST_DEADLINE_MS, safeSyncCode } from "./sync-contract";
import { SourceDataKind } from "@prisma/client";

export const MAX_PAGE_BYTES = 2 * 1024 * 1024;
export const MAX_UNIT_BYTES = 16 * 1024 * 1024;
export const MAX_UNIT_PAGES = 100;

export class ProviderFailure extends Error {
  constructor(
    readonly safeCode: string,
    readonly retryable: boolean,
    readonly retryAfterMs: number | null = null,
    readonly requestId: string | null = null,
    readonly diagnosticCode: string | null = null
  ) {
    super(safeCode);
  }
}

export async function readBoundedBody(chunks: AsyncIterable<Uint8Array>, maxBytes = MAX_PAGE_BYTES) {
  const buffers: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of chunks) {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) throw new ProviderFailure("RUN_LIMIT_EXCEEDED", false);
    buffers.push(Buffer.from(chunk));
  }
  return Buffer.concat(buffers, bytes);
}

export async function collectBoundedPages<T>(
  dataKind: SourceDataKind,
  fetchPage: (cursor: string | null) => Promise<{ rows: T[]; nextCursor: string | null; bytes: number }>,
  limits: { maxPageBytes?: number; maxUnitBytes?: number } = {}
) {
  const rows: T[] = [];
  let pageCount = 0;
  let byteCount = 0;
  let cursor: string | null = null;
  const seen = new Set<string>();
  do {
    if (pageCount >= MAX_UNIT_PAGES) throw new ProviderFailure("RUN_LIMIT_EXCEEDED", false);
    const page = await fetchPage(cursor);
    pageCount += 1;
    if (!Number.isSafeInteger(page.bytes) || page.bytes < 0 ||
        page.bytes > (limits.maxPageBytes ?? MAX_PAGE_BYTES) ||
        !Array.isArray(page.rows) || page.rows.length > PAGE_ROW_LIMITS[dataKind] - rows.length) {
      throw new ProviderFailure("RUN_LIMIT_EXCEEDED", false);
    }
    byteCount += page.bytes;
    if (byteCount > (limits.maxUnitBytes ?? MAX_UNIT_BYTES))
      throw new ProviderFailure("RUN_LIMIT_EXCEEDED", false);
    if (page.nextCursor && (page.nextCursor.length > 512 || seen.has(page.nextCursor))) {
      throw new ProviderFailure("PARTIAL_PAGE", false);
    }
    if (page.nextCursor && rows.length + page.rows.length >= PAGE_ROW_LIMITS[dataKind])
      throw new ProviderFailure("RUN_LIMIT_EXCEEDED", false);
    if (page.nextCursor) seen.add(page.nextCursor);
    rows.push(...page.rows);
    cursor = page.nextCursor;
  } while (cursor);
  return { rows, pageCount, byteCount, complete: true as const };
}

export function retryAfterMs(value: string | null | undefined, now = Date.now()): number | null {
  if (!value) return null;
  const seconds = /^\d+$/.test(value) ? Number(value) : null;
  if (seconds !== null && !Number.isSafeInteger(seconds)) return Number.MAX_SAFE_INTEGER;
  const target = seconds === null ? Date.parse(value) : now + seconds * 1_000;
  if (!Number.isFinite(target)) return null;
  return Math.max(0, target - now);
}

/** Calls must use the AbortSignal. No transaction may wrap this function. */
export async function boundedProviderRequest<T>(
  call: (signal: AbortSignal) => Promise<T>,
  runDeadlineAt: number,
  options: { now?: () => number; wait?: (ms: number) => Promise<void>; random?: () => number } = {}
): Promise<T> {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = options.random ?? Math.random;
  for (let attempt = 1; attempt <= MAX_PROVIDER_ATTEMPTS; attempt += 1) {
    const left = runDeadlineAt - now();
    if (left <= 0) throw new ProviderFailure("RUN_LIMIT_EXCEEDED", false);
    try {
      const controller = new AbortController();
      let rejectTimeout: ((error: ProviderFailure) => void) | undefined;
      const timeout = new Promise<never>((_resolve, reject) => { rejectTimeout = reject; });
      const timer = setTimeout(() => {
        controller.abort();
        rejectTimeout?.(new ProviderFailure("PROVIDER_UNAVAILABLE", true));
      }, Math.min(REQUEST_DEADLINE_MS, left));
      try { return await Promise.race([call(controller.signal), timeout]); }
      finally { clearTimeout(timer); }
    } catch (error) {
      const failure = error instanceof ProviderFailure
        ? error
        : new ProviderFailure("PROVIDER_UNAVAILABLE", true);
      if (!failure.retryable || attempt === MAX_PROVIDER_ATTEMPTS) {
        throw new ProviderFailure(safeSyncCode(failure.safeCode), false, null,
          failure.requestId, failure.diagnosticCode);
      }
      const delay = failure.retryAfterMs ?? Math.min(5_000, 250 * 2 ** (attempt - 1) + Math.floor(random() * 250));
      if (delay >= runDeadlineAt - now())
        throw new ProviderFailure(failure.safeCode === "PROVIDER_RATE_LIMITED"
          ? "PROVIDER_RATE_LIMITED" : "RUN_LIMIT_EXCEEDED", false);
      await wait(delay);
    }
  }
  throw new ProviderFailure("PROVIDER_UNAVAILABLE", false);
}
