/** Bounded Meta JSON/SSE transport. Server requests, notifications and instructions are never executed. */
function rejected(): never { throw new Error("MCP_ENVELOPE_REJECTED"); }
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

async function boundedJson(response: Response, limit: number): Promise<unknown> {
  if (!response || response.status !== 200 || response.redirected || !response.body ||
      !/^application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) rejected();
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d{1,8}$(?![\s\S])/.test(length) || Number(length) > limit)) rejected();
  const reader = response.body.getReader(), chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) rejected();
      chunks.push(Buffer.from(value));
    }
    const bytes = Buffer.concat(chunks);
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    finally { bytes.fill(0); }
  } finally {
    for (const chunk of chunks) chunk.fill(0);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function boundedMetaMcpEnvelope(response: Response, limit: number): Promise<unknown> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2 * 1024 * 1024) rejected();
  const type = response?.headers?.get("content-type") ?? "";
  if (/^application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|$)/i.test(type)) return boundedJson(response, limit);
  if (!response || response.status !== 200 || response.redirected || !response.body || type.length > 512 ||
      !/^text\/event-stream(?:\s*;|$)/i.test(type)) rejected();
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d{1,8}$(?![\s\S])/.test(length) || Number(length) > limit)) rejected();
  const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0, events = 0, pending = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) { decoder.decode(); rejected(); }
      size += value.byteLength;
      if (size > limit) { value.fill(0); rejected(); }
      try { pending += decoder.decode(value, { stream: true }); }
      finally { value.fill(0); }
      let matching: Record<string, unknown> | null = null;
      let delimiter: RegExpExecArray | null;
      while ((delimiter = /\r?\n\r?\n/.exec(pending)) !== null) {
        const event = pending.slice(0, delimiter.index);
        pending = pending.slice(delimiter.index + delimiter[0].length);
        if (++events > 128) rejected();
        const data = event.split(/\r?\n/).filter(line => line.startsWith("data:"))
          .map(line => line.slice(5).replace(/^ /, "")).join("\n");
        if (!data) continue;
        const envelope: unknown = JSON.parse(data);
        if (!object(envelope) || envelope.jsonrpc !== "2.0") rejected();
        if (envelope.id !== 1 || "method" in envelope) continue;
        if (matching) rejected();
        matching = envelope;
      }
      if (matching) {
        pending += decoder.decode();
        if (pending.trim()) rejected();
        return matching;
      }
    }
  } finally {
    pending = "";
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
