import { Injectable } from "@nestjs/common";
import { syncError } from "./sync-contract";

/** The protected store must attest this metadata for the exact token it returns. */
export type MetaResolvedCredential = {
  token: string;
  credentialRef: string;
  connectionId: string;
  accountId: string;
  appId: string;
  authClass: "SYSTEM_USER";
  scopes: readonly string[];
  expiresAt: Date;
  transport?: "GRAPH" | "MCP";
  currencyCode?: string;
  timeZone?: string;
};

export type MetaCredentialRequest = {
  credentialRef: string;
  connectionId: string;
  accountId: string;
  transport?: "GRAPH" | "MCP";
};

export abstract class MetaCredentialResolver {
  abstract resolve(input: MetaCredentialRequest, signal: AbortSignal): Promise<MetaResolvedCredential>;
}

/** No production protected-store backend has been approved or configured. */
@Injectable()
export class UnconfiguredMetaCredentialResolver extends MetaCredentialResolver {
  async resolve(_input: MetaCredentialRequest, _signal: AbortSignal): Promise<MetaResolvedCredential> {
    return syncError("PROVIDER_AUTH_REQUIRED");
  }
}

const META_REF = /^vault:\/\/meta\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN = /^[\x21-\x7e]{40,4096}$/;
const APP_ID = "4474691502806219";

/** public_profile may be automatically granted; it authorizes no extra collector fields. */
export function allowedMetaReadScopes(value: unknown): value is string[] {
  return Array.isArray(value) && value.length >= 1 && value.length <= 2 &&
    new Set(value).size === value.length && value.includes("ads_read") &&
    value.every((scope) => scope === "ads_read" || scope === "public_profile");
}

/** The MCP permission is accepted only by the explicitly selected read-only MCP path. */
export function allowedMetaMcpScopes(value: unknown): value is string[] {
  return Array.isArray(value) && value.length >= 2 && value.length <= 3 &&
    new Set(value).size === value.length && value.includes("ads_read") &&
    value.includes("ads_mcp_management") && value.every((scope) =>
      scope === "ads_read" || scope === "ads_mcp_management" || scope === "public_profile");
}

export function allowedMetaScopesForTransport(value: unknown, transport?: "GRAPH" | "MCP"): value is string[] {
  return transport === "MCP" ? allowedMetaMcpScopes(value) : allowedMetaReadScopes(value);
}

export function configuredMetaTransport(env: NodeJS.ProcessEnv = process.env): "GRAPH" | "MCP" {
  if (env.DAILY_SYNC_META_TRANSPORT === undefined || env.DAILY_SYNC_META_TRANSPORT === "GRAPH") return "GRAPH";
  if (env.DAILY_SYNC_META_TRANSPORT === "MCP") return "MCP";
  return syncError("PROVIDER_AUTH_REQUIRED");
}

/** Reject an unbound, overprivileged, expired or substituted token before any Graph call. */
export async function resolveMetaCredential(
  resolver: MetaCredentialResolver, input: MetaCredentialRequest, now = new Date(),
  maxWaitMs = 20_000
): Promise<MetaResolvedCredential> {
  // Resolve against the caller's original binding, even if an injected backend mutates its argument.
  input = Object.freeze({ credentialRef: input.credentialRef, connectionId: input.connectionId,
    accountId: input.accountId, transport: input.transport });
  if ((input.transport !== undefined && !["GRAPH", "MCP"].includes(input.transport)) ||
      !META_REF.test(input.credentialRef) || !/^\d{1,30}$/.test(input.accountId) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.connectionId))
    syncError("PROVIDER_AUTH_REQUIRED");
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let credential: MetaResolvedCredential;
  try {
    credential = await Promise.race([
      resolver.resolve(input, controller.signal),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error("Meta credential resolution timed out"));
        }, Math.min(20_000, Math.max(1, maxWaitMs)));
      })
    ]);
  } catch {
    controller.abort();
    return syncError("PROVIDER_AUTH_REQUIRED");
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  if (!credential || credential.credentialRef !== input.credentialRef ||
      credential.connectionId !== input.connectionId || credential.accountId !== input.accountId ||
      credential.appId !== APP_ID || credential.authClass !== "SYSTEM_USER" ||
      !allowedMetaScopesForTransport(credential.scopes, input.transport) ||
      (input.transport === "MCP" ? credential.transport !== "MCP" || credential.currencyCode !== "USD" ||
        credential.timeZone !== "Asia/Seoul" : credential.transport !== undefined && credential.transport !== "GRAPH") ||
      typeof credential.token !== "string" ||
      !TOKEN.test(credential.token) || !(credential.expiresAt instanceof Date) ||
      !Number.isFinite(credential.expiresAt.getTime()) ||
      credential.expiresAt.getTime() <= now.getTime() + 7 * 86_400_000)
    syncError("PROVIDER_AUTH_REQUIRED");
  return credential;
}
