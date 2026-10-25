import { Injectable } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import { PrismaService } from "../common/prisma.service";
import { boundedProviderRequest, ProviderFailure } from "./bounded-request";
import { cafe24RetryAfterMs } from "./cafe24-rate-limit";
import { cafe24TestAllowed } from "./cafe24-test-connection.service";
import { CredentialVault } from "./credential-vault";
import { assertEnabled, assertCafe24AuthorizationEnabled, syncError } from "./sync-contract";
import { assertScheduledCheckpointConfigured } from "./scheduled-checkpoint";
import { accountAllowlist, accountKey } from "./source-connections.service";

const SCOPE = "mall.read_order";
const MAX_TOKEN_BYTES = 32_768;
const SHARED_RAILWAY_CALLBACK_ORIGIN = "https://grand-fascination-staging.up.railway.app";
type TokenResponse = { access_token: string; refresh_token: string; expires_at: string;
  refresh_token_expires_at: string; client_id: string; mall_id: string;
  shop_no: string | number; token_type: string; scopes: string[] };

function settings(env: NodeJS.ProcessEnv = process.env) {
  const clientId = env.DAILY_SYNC_CAFE24_CLIENT_ID;
  const clientSecret = env.DAILY_SYNC_CAFE24_CLIENT_SECRET;
  const redirect = env.DAILY_SYNC_CAFE24_REDIRECT_URI;
  const isolatedOrigin = env.DAILY_SYNC_CAFE24_ISOLATED_ORIGIN;
  let url: URL;
  try { url = new URL(redirect ?? ""); } catch { syncError("PROVIDER_AUTH_REQUIRED"); }
  if (!clientId || !/^[A-Za-z0-9]{8,128}$/.test(clientId) ||
      !clientSecret || clientSecret.length > 512 || !isolatedOrigin ||
      url.protocol !== "https:" || url.origin !== isolatedOrigin ||
      url.pathname !== "/backend-api/integrations/cafe24/oauth/callback" ||
      url.search || url.hash || url.username || url.password || url.port ||
      (url.hostname === "patimagroup-work.com" ||
        url.hostname.endsWith(".patimagroup-work.com")) ||
      (url.origin === SHARED_RAILWAY_CALLBACK_ORIGIN &&
        env.DAILY_SYNC_CAFE24_RAILWAY_CALLBACK_ENABLED !== "true"))
    syncError("PROVIDER_AUTH_REQUIRED");
  return { clientId, clientSecret, redirect: url.href };
}

function mallHost(mallId: string) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(mallId)) syncError("ACCOUNT_SCOPE_MISMATCH");
  return `https://${mallId}.cafe24api.com`;
}

function digest(state: string) { return createHash("sha256").update(state).digest("hex"); }

function tokenDate(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)?$/.test(value))
    throw new ProviderFailure("FIELD_UNSUPPORTED", false);
  // Cafe24 examples omit an offset; the verified mall time zone is Asia/Seoul.
  // Never let the host machine's local time zone decide expiration.
  const date = new Date(/(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : `${value}+09:00`);
  if (!Number.isFinite(date.getTime())) throw new ProviderFailure("FIELD_UNSUPPORTED", false);
  return date;
}

function validateToken(value: unknown, mallId: string, shopKey: string, clientId: string) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ProviderFailure("FIELD_UNSUPPORTED", false);
  const token = value as Partial<TokenResponse>;
  if (token.mall_id !== mallId || String(token.shop_no) !== shopKey.slice(4) ||
      token.client_id !== clientId || token.token_type !== "Bearer" ||
      !Array.isArray(token.scopes) || !token.scopes.includes(SCOPE) ||
      typeof token.access_token !== "string" || !token.access_token ||
      typeof token.refresh_token !== "string" || !token.refresh_token)
    throw new ProviderFailure("ACCOUNT_SCOPE_MISMATCH", false);
  const accessExpiry = tokenDate(token.expires_at), refreshExpiry = tokenDate(token.refresh_token_expires_at);
  if (accessExpiry <= new Date() || refreshExpiry <= accessExpiry)
    throw new ProviderFailure("PROVIDER_AUTH_REQUIRED", false);
  return { access: token.access_token, refresh: token.refresh_token,
    accessExpiry, refreshExpiry };
}

@Injectable()
export class Cafe24OauthService {
  constructor(private readonly prisma: PrismaService, private readonly vault: CredentialVault,
    private readonly request: typeof fetch = fetch) {}

  async begin(connectionId: string, actorUserId: string | null) {
    assertCafe24AuthorizationEnabled();
    const config = settings();
    const connection = await this.prisma.sourceConnection.findUnique({ where: { id: connectionId } });
    if (!connection || connection.provider !== "CAFE24" ||
        connection.accessState === "BLOCKED" || !/^shop[1-9]\d*$/.test(connection.shopKey) ||
        !cafe24TestAllowed(connection.externalAccountId, connection.shopKey))
      syncError("ACCOUNT_SCOPE_MISMATCH");
    const state = randomBytes(32).toString("base64url");
    await this.prisma.cafe24OauthAttempt.create({ data: {
      connectionId, actorUserId, stateHash: digest(state),
      expiresAt: new Date(Date.now() + 5 * 60_000)
    } });
    const url = new URL(`${mallHost(connection.externalAccountId)}/api/v2/oauth/authorize`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", config.clientId);
    url.searchParams.set("state", state);
    url.searchParams.set("redirect_uri", config.redirect);
    url.searchParams.set("scope", SCOPE);
    return { authorizeUrl: url.href, expiresInSeconds: 300 };
  }

  async callback(input: { state?: string; code?: string; error?: string }) {
    assertCafe24AuthorizationEnabled();
    const config = settings();
    if (!input.state || !/^[A-Za-z0-9_-]{43}$/.test(input.state))
      syncError("PROVIDER_AUTH_REQUIRED");
    // Consume before using a single-use authorization code; replay and concurrent
    // callbacks cannot exchange the same code or overwrite a newer connection.
    const attempt = await this.prisma.cafe24OauthAttempt.findUnique({
      where: { stateHash: digest(input.state) }, include: { connection: true }
    });
    if (!attempt || attempt.consumedAt || attempt.expiresAt <= new Date() ||
        attempt.connection.provider !== "CAFE24" ||
        attempt.connection.accessState === "BLOCKED" ||
        !cafe24TestAllowed(attempt.connection.externalAccountId,
          attempt.connection.shopKey)) syncError("PROVIDER_AUTH_REQUIRED");
    const claimed = await this.prisma.cafe24OauthAttempt.updateMany({
      where: { id: attempt.id, consumedAt: null, expiresAt: { gt: new Date() } },
      data: { consumedAt: new Date() }
    });
    if (claimed.count !== 1 || input.error || !input.code ||
        !/^[A-Za-z0-9_-]{1,512}$/.test(input.code)) syncError("PROVIDER_AUTH_REQUIRED");
    const token = await this.exchange(attempt.connection.externalAccountId, attempt.connection.shopKey,
      { grant_type: "authorization_code", code: input.code, redirect_uri: config.redirect });
    const existing = await this.prisma.sourceCredential.findUnique({ where: {
      connectionId_kind: { connectionId: attempt.connectionId, kind: "CAFE24_REFRESH" }
    }, select: { revision: true } });
    await this.vault.storeCafe24Pair({ connectionId: attempt.connectionId,
      refresh: token.refresh, access: token.access,
      refreshExpiresAt: token.refreshExpiry, accessExpiresAt: token.accessExpiry,
      expectedRefreshRevision: existing?.revision ?? null, actorUserId: attempt.actorUserId });
    return { connected: true, connectionId: attempt.connectionId, scope: SCOPE };
  }

  async accessToken(connectionId: string, mallId: string, shopKey: string) {
    const current = await this.vault.readCafe24Access(connectionId);
    if (current) return current;
    const claim = await this.vault.claimCafe24Refresh(connectionId);
    if (!claim) {
      const waitUntil = Date.now() + 21_000;
      while (Date.now() < waitUntil) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const winner = await this.vault.readCafe24Access(connectionId);
        if (winner) return winner;
      }
      throw new ProviderFailure("PROVIDER_UNAVAILABLE", true);
    }
    return this.refreshClaim(connectionId, mallId, shopKey, claim, null);
  }

  /** A guarded retry of an existing refresh credential, never a forced READY. */
  async recoverConnection(connectionId: string, input: {
    expectedUpdatedAt: string; expectedRefreshRevision: number;
  }, actorUserId: string) {
    assertEnabled();
    assertScheduledCheckpointConfigured();
    const connection = await this.prisma.sourceConnection.findUnique({ where: { id: connectionId } });
    if (!connection || connection.provider !== "CAFE24" ||
        !accountAllowlist().has(accountKey("CAFE24", connection.externalAccountId, connection.shopKey)))
      syncError("ACCOUNT_SCOPE_MISMATCH");
    const credential = await this.prisma.sourceCredential.findUnique({ where: {
      connectionId_kind: { connectionId, kind: "CAFE24_REFRESH" }
    }, select: { revision: true, expiresAt: true } });
    const lease = await this.prisma.syncLease.findFirst({ where: { connectionId,
      expiresAt: { gt: new Date() } }, select: { connectionId: true } });
    if (connection.enabled || connection.accessState !== "REAUTH_REQUIRED" || lease ||
        connection.updatedAt.toISOString() !== input.expectedUpdatedAt ||
        connection.credentialRef !== `source_credentials:${connectionId}:CAFE24_REFRESH` ||
        !credential?.expiresAt || credential.expiresAt <= new Date() ||
        credential.revision !== input.expectedRefreshRevision)
      syncError("PROVIDER_AUTH_REQUIRED");
    const claim = await this.vault.claimCafe24Refresh(connectionId);
    if (!claim) syncError("LEASE_LOST");
    if (claim.revision !== input.expectedRefreshRevision) {
      await this.vault.releaseRefreshClaim(connectionId, claim.owner);
      syncError("LEASE_LOST");
    }
    await this.refreshClaim(connectionId, connection.externalAccountId, connection.shopKey, claim, actorUserId);
    return { connectionId, accessState: "READY", enabled: false, refreshed: true };
  }

  private async refreshClaim(connectionId: string, mallId: string, shopKey: string,
    claim: { token: string; owner: string; revision: number }, actorUserId: string | null) {
    try {
      const token = await this.exchange(mallId, shopKey,
        { grant_type: "refresh_token", refresh_token: claim.token });
      await this.vault.storeCafe24Pair({ connectionId, refresh: token.refresh, access: token.access,
        refreshExpiresAt: token.refreshExpiry, accessExpiresAt: token.accessExpiry,
        expectedRefreshRevision: claim.revision, refreshOwner: claim.owner, actorUserId });
      return token.access;
    } catch (error) {
      if (!(error instanceof ProviderFailure && error.safeCode === "PROVIDER_RATE_LIMITED")) {
        // An ambiguous response may have consumed the one-use refresh token.
        await this.vault.markCafe24ReauthIfRevision(connectionId, claim.revision).catch(() => undefined);
      }
      if (error instanceof ProviderFailure) throw error;
      syncError("PROVIDER_AUTH_REQUIRED");
    } finally {
      await this.vault.releaseRefreshClaim(connectionId, claim.owner).catch(() => undefined);
    }
  }

  private async exchange(mallId: string, shopKey: string, fields: Record<string, string>) {
    const config = settings();
    const endpoint = `${mallHost(mallId)}/api/v2/oauth/token`;
    return boundedProviderRequest(async (signal) => {
      let response: Response;
      try { response = await this.request(endpoint, { method: "POST", signal,
        headers: { Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(fields).toString() }); }
      catch { throw new ProviderFailure("PROVIDER_UNAVAILABLE", true); }
      if (!response.ok) throw new ProviderFailure(response.status === 429 ? "PROVIDER_RATE_LIMITED" :
        response.status === 400 || response.status === 401 || response.status === 403
          ? "PROVIDER_AUTH_REQUIRED" : "PROVIDER_UNAVAILABLE",
      response.status === 429 || response.status >= 500,
      response.status === 429 ? cafe24RetryAfterMs(response.headers) : null);
      const body = await readSmallJson(response, MAX_TOKEN_BYTES);
      return validateToken(body, mallId, shopKey, config.clientId);
    }, Date.now() + 20_000);
  }
}

async function readSmallJson(response: Response, limit: number): Promise<unknown> {
  if (!response.body) throw new ProviderFailure("PARTIAL_PAGE", false);
  const reader = response.body.getReader();
  const buffers: Buffer[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > limit) throw new ProviderFailure("RUN_LIMIT_EXCEEDED", false);
      buffers.push(Buffer.from(part.value));
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(buffers).toString("utf8")); }
  catch { throw new ProviderFailure("FIELD_UNSUPPORTED", false); }
}
