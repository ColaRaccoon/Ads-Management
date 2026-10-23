import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaService } from "../common/prisma.service";
import { CredentialVault } from "./credential-vault";
import { Cafe24OauthService } from "./cafe24-oauth.service";
import { ProviderFailure } from "./bounded-request";

type AuthContext = { prisma: PrismaClient; connectionId: string; oauth: Cafe24OauthService;
  env?: NodeJS.ProcessEnv; request?: typeof fetch };

function assertRegisteredRedirect(env: NodeJS.ProcessEnv) {
  const expected = "https://cafe24-callback-test-production.up.railway.app/backend-api/integrations/cafe24/oauth/callback";
  const verifiedAt = Date.parse(env.DAILY_SYNC_CAFE24_REGISTERED_ISOLATED_REDIRECT_VERIFIED_AT ?? "");
  if (env.DAILY_SYNC_CAFE24_REDIRECT_URI !== expected ||
      env.DAILY_SYNC_CAFE24_ISOLATED_ORIGIN !== "https://cafe24-callback-test-production.up.railway.app" ||
      env.DAILY_SYNC_CAFE24_REGISTERED_ISOLATED_REDIRECT_VERIFIED !== "true" ||
      !Number.isFinite(verifiedAt) || verifiedAt > Date.now() || Date.now()-verifiedAt > 24*60*60_000)
    throw new Error("REGISTERED_ISOLATED_REDIRECT_EVIDENCE_REQUIRED");
}

export async function rotateCafe24LiveCredential(context: AuthContext, acknowledgement: string) {
  if (acknowledgement !== "ROTATE_EXISTING_ISOLATED_06_TOKEN_PAIR") throw new Error("ISOLATED_ROTATION_ACK_REQUIRED");
  const before = await context.prisma.sourceCredential.findMany({ where: { connectionId: context.connectionId },
    select: { kind: true, revision: true, expiresAt: true, refreshOwner: true, refreshUntil: true } });
  const access = before.find((credential) => credential.kind === "CAFE24_ACCESS");
  const refresh = before.find((credential) => credential.kind === "CAFE24_REFRESH");
  const connection=await context.prisma.sourceConnection.findUnique({where:{id:context.connectionId},
    select:{provider:true,externalAccountId:true,shopKey:true,accessState:true,enabled:true,credentialExpiresAt:true}});
  if (!connection || connection.provider !== "CAFE24" || connection.externalAccountId !== "didadi0729" ||
      connection.shopKey !== "shop1" || connection.accessState !== "READY" || !connection.enabled ||
      !connection.credentialExpiresAt || connection.credentialExpiresAt.getTime()<=Date.now()+12*60_000 ||
      !access || !refresh || !refresh.expiresAt || refresh.expiresAt.getTime()<=Date.now()+12*60_000 ||
      before.length !== 2 || refresh.refreshOwner || refresh.refreshUntil)
    throw new Error("ISOLATED_CREDENTIAL_OWNER_BUSY");
  const changed = await context.prisma.sourceCredential.updateMany({ where: {
    connectionId: context.connectionId, kind: "CAFE24_ACCESS", revision: access.revision,
    expiresAt: access.expiresAt
  }, data: { expiresAt: new Date() } });
  if (changed.count !== 1) throw new Error("ISOLATED_CREDENTIAL_REVISION_CHANGED");
  await context.oauth.accessToken(context.connectionId,"didadi0729","shop1");
  const after = await context.prisma.sourceCredential.findMany({ where: { connectionId: context.connectionId },
    select: { kind: true, revision: true, refreshOwner: true, refreshUntil: true } });
  if (after.length !== 2 || after.some((credential) => credential.refreshOwner || credential.refreshUntil ||
      credential.revision !== before.find((old) => old.kind === credential.kind)!.revision+1))
    throw new Error("ISOLATED_ROTATION_NOT_CONFIRMED");
  return { tokenPairRotated: true, priorRevisions: before.map((credential) => credential.revision),
    currentRevisions: after.map((credential) => credential.revision), tokenCopied: false };
}

/** One explicit provider revocation. No retry or token backup restoration. The
 * caller queues a real day run first and executes it in onRevoked, proving that
 * the ordinary runner records provider 401 and retains the last successful day. */
export async function revokeCafe24LiveCredential<T>(context: AuthContext,
  acknowledgement: string, onRevoked: () => Promise<T>) {
  const env = context.env ?? process.env;
  if (acknowledgement !== "REVOKE_EXISTING_ISOLATED_06_TOKEN_PAIR_AND_RECONNECT")
    throw new Error("ISOLATED_REVOCATION_ACK_REQUIRED");
  assertRegisteredRedirect(env);
  const clientId = env.DAILY_SYNC_CAFE24_CLIENT_ID ?? "";
  const clientSecret = env.DAILY_SYNC_CAFE24_CLIENT_SECRET ?? "";
  if (!/^[A-Za-z0-9]{8,128}$/.test(clientId) || !clientSecret || clientSecret.length > 512)
    throw new Error("ISOLATED_CLIENT_CREDENTIAL_REQUIRED");
  let access = await context.oauth.accessToken(context.connectionId,"didadi0729","shop1");
  const pair = await context.prisma.sourceCredential.findMany({ where: { connectionId: context.connectionId },
    select: { kind: true, revision: true, refreshOwner: true, refreshUntil: true } });
  const refresh = pair.find((credential) => credential.kind === "CAFE24_REFRESH");
  if (pair.length !== 2 || !refresh || refresh.refreshOwner || refresh.refreshUntil)
    throw new Error("ISOLATED_CREDENTIAL_OWNER_BUSY");
  const owner = randomUUID();
  const claimed = await context.prisma.sourceCredential.updateMany({ where: {
    connectionId: context.connectionId, kind: "CAFE24_REFRESH", revision: refresh.revision,
    refreshOwner: null, refreshUntil: null
  }, data: { refreshOwner: owner, refreshUntil: new Date(Date.now()+90_000) } });
  if (claimed.count !== 1) throw new Error("ISOLATED_CREDENTIAL_REVISION_CHANGED");
  const vault = new CredentialVault(context.prisma as unknown as PrismaService);
  try {
    const request = context.request ?? fetch;
    const response = await request("https://didadi0729.cafe24api.com/api/v2/oauth/revoke", {
      method: "POST", redirect:"error",signal: AbortSignal.timeout(20_000),
      headers: { Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: access, token_hint: "access_token" }).toString()
    });
    await response.body?.cancel();
    if (!response.ok) throw new ProviderFailure(response.status === 429 ? "PROVIDER_RATE_LIMITED" :
      response.status === 400 || response.status === 401 || response.status === 403 ? "PROVIDER_AUTH_REQUIRED" :
        "PROVIDER_UNAVAILABLE",false);
    const result = await onRevoked();
    return { providerRevocationSucceeded: true, oldPairRestored: false, tokenCopied: false, result };
  } finally {
    access="";
    // The provider might have processed a request whose response was lost.
    // Keep the single store, stop reads, and reconnect instead of replaying it.
    await vault.markCafe24ReauthIfRevision(context.connectionId,refresh.revision);
    await vault.releaseRefreshClaim(context.connectionId,owner);
    // The caller's real failed run is the 401/last-success evidence; revocation
    // response success alone never claims that recovery has succeeded.
  }
}
