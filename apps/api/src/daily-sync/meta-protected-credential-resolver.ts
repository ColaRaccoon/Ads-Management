import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { MetaCredentialRequest, MetaCredentialResolver, MetaResolvedCredential,
  UnconfiguredMetaCredentialResolver, allowedMetaScopesForTransport } from "./meta-credential-resolver";
import { syncError } from "./sync-contract";

const APP_ID = "4474691502806219";
const GRAPH = "https://graph.facebook.com/v26.0";
const MAX_BYTES = 32_768;
const REF = /^vault:\/\/meta\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Material = MetaCredentialRequest & { token: string; inspectorToken: string };
type Envelope = { version: 1 | 2; iv: string; authTag: string; ciphertext: string };

function credentialIdentity(input: MetaCredentialRequest) {
  const authClass = input.authClass ?? "SYSTEM_USER";
  if (authClass === "SYSTEM_USER" && input.expectedUserId === undefined)
    return { authClass, version: 1 as const };
  if (authClass === "USER" && input.transport === "MCP" &&
      typeof input.expectedUserId === "string" && /^\d{1,30}$/.test(input.expectedUserId))
    return { authClass, version: 2 as const };
  return syncError("PROVIDER_AUTH_REQUIRED");
}

function aad(input: MetaCredentialRequest) {
  if ((input.transport !== undefined && !["GRAPH", "MCP"].includes(input.transport)) ||
      !REF.test(input.credentialRef) || !UUID.test(input.connectionId) ||
      !/^\d{1,30}$/.test(input.accountId)) syncError("PROVIDER_AUTH_REQUIRED");
  const identity = credentialIdentity(input);
  const binding = ["META_VAULT", identity.version, APP_ID, input.credentialRef, input.connectionId, input.accountId];
  // Preserve existing Graph records; MCP ciphertext is separately bound to its transport.
  if (input.transport === "MCP") binding.push("MCP");
  if (identity.authClass === "USER") binding.push("USER", input.expectedUserId!);
  return Buffer.from(JSON.stringify(binding));
}
function token(value: unknown) {
  return typeof value === "string" && /^[\x21-\x7e]{40,4096}$/.test(value);
}
function decoded(value: unknown, length?: number) {
  if (typeof value !== "string" || value.length > MAX_BYTES ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) syncError("PROVIDER_AUTH_REQUIRED");
  const result = Buffer.from(value, "base64");
  if (result.toString("base64") !== value || (length !== undefined && result.length !== length))
    syncError("PROVIDER_AUTH_REQUIRED");
  return result;
}
function material(value: unknown, input: MetaCredentialRequest): Material {
  const item = value as Material | null;
  if (!item || item.credentialRef !== input.credentialRef || item.connectionId !== input.connectionId ||
      item.accountId !== input.accountId || (item.transport ?? "GRAPH") !== (input.transport ?? "GRAPH") ||
      (item.authClass ?? "SYSTEM_USER") !== (input.authClass ?? "SYSTEM_USER") ||
      item.expectedUserId !== input.expectedUserId ||
      !token(item.token) || !token(item.inspectorToken))
    syncError("PROVIDER_AUTH_REQUIRED");
  return item;
}

/** Provisioning helper: the caller writes only this ciphertext in a private server directory. */
export function sealMetaVaultRecord(input: Material, key: Uint8Array): string {
  const binding = aad(input);
  material(input, input);
  if (key.byteLength !== 32) syncError("PROVIDER_AUTH_REQUIRED");
  const iv = randomBytes(12), plain = Buffer.from(JSON.stringify(input));
  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(binding);
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    return JSON.stringify({ version: credentialIdentity(input).version, iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") });
  } finally { plain.fill(0); }
}

/** Cross-platform ciphertext store; root key belongs in the host's protected secret store. */
export class ProtectedFileMetaCredentialResolver extends MetaCredentialResolver {
  constructor(private readonly directory: string, private readonly encodedKey: string,
    private readonly request: typeof fetch = fetch) { super(); }

  async resolve(input: MetaCredentialRequest, signal: AbortSignal): Promise<MetaResolvedCredential> {
    input = Object.freeze({ credentialRef: input.credentialRef, connectionId: input.connectionId,
      accountId: input.accountId, transport: input.transport, authClass: input.authClass,
      expectedUserId: input.expectedUserId });
    let key: Buffer | undefined, plain: Buffer | undefined;
    try {
      const binding = aad(input);
      const identity = credentialIdentity(input);
      if (signal.aborted || !isAbsolute(this.directory)) syncError("PROVIDER_AUTH_REQUIRED");
      key = decoded(this.encodedKey, 32);
      const directory = await realpath(this.directory);
      if (directory !== resolve(this.directory)) syncError("PROVIDER_AUTH_REQUIRED");
      await privatePath(this.directory, true);
      // Ref UUID is the entire filename; an encrypted record cannot redirect this lookup.
      const filename = join(directory, `${REF.exec(input.credentialRef)![1]}.json`);
      await privatePath(filename, false);
      const file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let envelope: Envelope;
      try {
        const info = await file.stat();
        if (!info.isFile() || (process.platform !== "win32" &&
            ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())))
          syncError("PROVIDER_AUTH_REQUIRED");
        const size = info.size;
        if (size < 1 || size > MAX_BYTES) syncError("PROVIDER_AUTH_REQUIRED");
        const buffer = Buffer.alloc(MAX_BYTES + 1);
        try {
          const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
          if (bytesRead !== size) syncError("PROVIDER_AUTH_REQUIRED");
          envelope = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")) as Envelope;
        } finally { buffer.fill(0); }
      } finally { await file.close(); }
      if (envelope?.version !== identity.version) syncError("PROVIDER_AUTH_REQUIRED");
      const decipher = createDecipheriv("aes-256-gcm", key, decoded(envelope.iv, 12));
      decipher.setAAD(binding);
      decipher.setAuthTag(decoded(envelope.authTag, 16));
      plain = Buffer.concat([decipher.update(decoded(envelope.ciphertext)), decipher.final()]);
      const secret = material(JSON.parse(plain.toString("utf8")), input);
      if (signal.aborted) syncError("PROVIDER_AUTH_REQUIRED");
      const debug = await this.get("debug_token", secret.inspectorToken,
        new URLSearchParams({ input_token: secret.token }), signal);
      const data = debug.data as Record<string, unknown> | null;
      const expiry = data?.expires_at;
      if (!data || data.app_id !== APP_ID || data.type !== identity.authClass || data.is_valid !== true ||
          !allowedMetaScopesForTransport(data.scopes, input.transport) ||
          typeof data.user_id !== "string" || !/^\d{1,30}$/.test(data.user_id) ||
          (identity.authClass === "USER" && data.user_id !== input.expectedUserId) ||
          typeof expiry !== "number" || !Number.isSafeInteger(expiry) ||
          expiry <= Date.now() / 1000 + 7 * 86_400 || expiry > 253_402_300_799)
        syncError("PROVIDER_AUTH_REQUIRED");
      // A positive data-access expiry is an additional limit, not a token-expiry substitute.
      const dataExpiry = data.data_access_expires_at;
      if (dataExpiry !== undefined && (typeof dataExpiry !== "number" ||
          !Number.isSafeInteger(dataExpiry) || dataExpiry < 0 ||
          (dataExpiry > 0 && dataExpiry <= Date.now() / 1000 + 7 * 86_400)))
        syncError("PROVIDER_AUTH_REQUIRED");
      const me = await this.get("me", secret.token, new URLSearchParams({ fields: "id" }), signal);
      const account = await this.get(`act_${input.accountId}`, secret.token,
        new URLSearchParams({ fields: input.transport === "MCP" ? "id,currency,timezone_name" : "id" }), signal);
      if (me.id !== data.user_id || ![input.accountId, `act_${input.accountId}`].includes(account.id as string))
        syncError("PROVIDER_AUTH_REQUIRED");
      if (input.transport === "MCP" && (account.currency !== "USD" || account.timezone_name !== "Asia/Seoul"))
        syncError("PROVIDER_AUTH_REQUIRED");
      if (signal.aborted) syncError("PROVIDER_AUTH_REQUIRED");
      return { ...input, ...(input.transport === "MCP" ? { currencyCode: "USD", timeZone: "Asia/Seoul" } : {}),
        token: secret.token, appId: APP_ID, authClass: identity.authClass,
        ...(identity.authClass === "USER" ? { subjectId: data.user_id } : {}), scopes: [...data.scopes],
        expiresAt: new Date(Math.min(expiry, typeof dataExpiry === "number" && dataExpiry > 0
          ? dataExpiry : expiry) * 1000) };
    } catch { return syncError("PROVIDER_AUTH_REQUIRED"); }
    finally { key?.fill(0); plain?.fill(0); }
  }

  private async get(path: string, accessToken: string, params: URLSearchParams, signal: AbortSignal) {
    const response = await this.request(`${GRAPH}/${path}?${params}`, {
      headers: { Authorization: `Bearer ${accessToken}` }, signal, redirect: "error"
    });
    try {
      if (!response.ok || !response.body) syncError("PROVIDER_AUTH_REQUIRED");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_BYTES || signal.aborted) syncError("PROVIDER_AUTH_REQUIRED");
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || "error" in parsed)
        syncError("PROVIDER_AUTH_REQUIRED");
      return parsed as Record<string, unknown>;
    } finally { await response.body?.cancel().catch(() => undefined); }
  }
}

async function privatePath(path: string, directory: boolean) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) ||
      (process.platform !== "win32" && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())))
    syncError("PROVIDER_AUTH_REQUIRED");
}

/** No environment presence, local DPAPI file or unknown backend activates production. */
export function configuredMetaCredentialResolver(env: NodeJS.ProcessEnv = process.env): MetaCredentialResolver {
  if (env.DAILY_SYNC_META_VAULT_BACKEND !== "ENCRYPTED_FILE") return new UnconfiguredMetaCredentialResolver();
  return new ProtectedFileMetaCredentialResolver(env.DAILY_SYNC_META_VAULT_DIRECTORY ?? "",
    env.DAILY_SYNC_META_VAULT_KEY ?? "");
}
