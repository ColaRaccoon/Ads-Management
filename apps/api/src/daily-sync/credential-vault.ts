import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { Prisma, SecurityAuditActorType, SecurityAuditResult, SourceProvider } from "@prisma/client";
import { PrismaService } from "../common/prisma.service";
import { writeSecurityAudit } from "../security-audit/security-audit.types";
import { syncError } from "./sync-contract";

export type ProtectedCredential = { ciphertext: Uint8Array; iv: Uint8Array; authTag: Uint8Array; keyVersion: number };

export function credentialKey(version: number, env: NodeJS.ProcessEnv = process.env): Buffer {
  if (!Number.isInteger(version) || version < 1 || version > 99) syncError("PROVIDER_AUTH_REQUIRED");
  const retired = env.DAILY_SYNC_RETIRED_CREDENTIAL_KEY_VERSIONS;
  if (retired !== undefined && (!/^[1-9]\d?(?:,[1-9]\d?)*$/.test(retired) ||
      retired.split(",").includes(String(version)))) syncError("PROVIDER_AUTH_REQUIRED");
  const encoded = env[`DAILY_SYNC_CREDENTIAL_KEY_V${version}`];
  if (!encoded || !/^[A-Za-z0-9+/]{43}=$/.test(encoded)) syncError("PROVIDER_AUTH_REQUIRED");
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) syncError("PROVIDER_AUTH_REQUIRED");
  return key;
}

export function activeCredentialKeyVersion(env: NodeJS.ProcessEnv = process.env) {
  const raw = env.DAILY_SYNC_ACTIVE_KEY_VERSION ?? "1";
  if (!/^[1-9]\d?$/.test(raw)) syncError("PROVIDER_AUTH_REQUIRED");
  const version = Number(raw);
  credentialKey(version, env).fill(0);
  return version;
}

export function sealCredential(value: string, connectionId: string, kind: string, version: number): ProtectedCredential {
  if (!value || value.length > 8192) syncError("PROVIDER_AUTH_REQUIRED");
  const key = credentialKey(version);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`${connectionId}:${kind}:${version}`, "utf8"));
  const plaintext = Buffer.from(value, "utf8");
  try {
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { ciphertext, iv, authTag: cipher.getAuthTag(), keyVersion: version };
  } finally {
    plaintext.fill(0);
    key.fill(0);
  }
}

export function openCredential(value: ProtectedCredential, connectionId: string, kind: string): string {
  const key = credentialKey(value.keyVersion);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, value.iv);
    decipher.setAAD(Buffer.from(`${connectionId}:${kind}:${value.keyVersion}`, "utf8"));
    decipher.setAuthTag(value.authTag);
    return Buffer.concat([decipher.update(value.ciphertext), decipher.final()]).toString("utf8");
  } catch {
    syncError("PROVIDER_AUTH_REQUIRED");
  } finally {
    key.fill(0);
  }
}

@Injectable()
export class CredentialVault {
  constructor(private readonly prisma: PrismaService) {}

  /** Persist the one-use refresh token and its access token in one transaction. */
  async storeCafe24Pair(input: {
    connectionId: string; refresh: string; access: string;
    refreshExpiresAt: Date; accessExpiresAt: Date;
    expectedRefreshRevision: number | null; actorUserId: string | null;
    refreshOwner?: string;
  }) {
    const version = activeCredentialKeyVersion();
    const sealedRefresh = sealCredential(input.refresh, input.connectionId, "CAFE24_REFRESH", version);
    const sealedAccess = sealCredential(input.access, input.connectionId, "CAFE24_ACCESS", version);
    try {
      await this.prisma.$transaction(async (tx) => {
        await assertCafe24Connection(tx, input.connectionId);
        if (input.expectedRefreshRevision === null) {
          if (input.refreshOwner) syncError("PROVIDER_AUTH_REQUIRED");
          await tx.sourceCredential.create({ data: { connectionId: input.connectionId,
            kind: "CAFE24_REFRESH", ...sealedRefresh, expiresAt: input.refreshExpiresAt } });
        } else {
          const refreshed = await tx.sourceCredential.updateMany({ where: {
            connectionId: input.connectionId, kind: "CAFE24_REFRESH",
            revision: input.expectedRefreshRevision,
            ...(input.refreshOwner ? { refreshOwner: input.refreshOwner,
              refreshUntil: { gt: new Date() } } : { refreshOwner: null })
          }, data: { ...sealedRefresh, expiresAt: input.refreshExpiresAt,
            revision: { increment: 1 }, refreshOwner: null, refreshUntil: null } });
          if (refreshed.count !== 1) syncError("PROVIDER_AUTH_REQUIRED");
        }
        const access = await tx.sourceCredential.findUnique({ where: {
          connectionId_kind: { connectionId: input.connectionId, kind: "CAFE24_ACCESS" }
        }, select: { revision: true } });
        if (access) await tx.sourceCredential.update({ where: {
          connectionId_kind: { connectionId: input.connectionId, kind: "CAFE24_ACCESS" }
        }, data: { ...sealedAccess, expiresAt: input.accessExpiresAt,
          revision: { increment: 1 } } });
        else await tx.sourceCredential.create({ data: { connectionId: input.connectionId,
          kind: "CAFE24_ACCESS", ...sealedAccess, expiresAt: input.accessExpiresAt } });
        await tx.sourceConnection.update({ where: { id: input.connectionId }, data: {
          credentialRef: `source_credentials:${input.connectionId}:CAFE24_REFRESH`,
          credentialExpiresAt: input.refreshExpiresAt, accessState: "READY"
        } });
        await writeSecurityAudit(tx, { actorType: input.actorUserId
          ? SecurityAuditActorType.USER : SecurityAuditActorType.SYSTEM,
        actorUserId: input.actorUserId, action: input.refreshOwner
          ? "CAFE24_CREDENTIAL_ROTATED" : "CAFE24_CREDENTIAL_CONNECTED",
        targetType: "SOURCE_CONNECTION", targetId: input.connectionId,
        result: SecurityAuditResult.SUCCESS,
        afterJson: { connectionId: input.connectionId, scope: "mall.read_order" } });
      }, { timeout: 5_000 });
    } catch { syncError("PROVIDER_AUTH_REQUIRED"); }
  }

  // The protected store creates the opaque reference. Provider verification in
  // later stages must happen before a connection can become READY or enabled.
  async bindStaticCredentialRef(
    connectionId: string, provider: "GOOGLE" | "META", newRef: string,
    expectedRef: string | null, expiresAt: Date | null, actorUserId: string | null = null
  ) {
    if (!validStaticRef(provider, newRef) ||
        (expiresAt && (!Number.isFinite(expiresAt.getTime()) || expiresAt <= new Date()))) {
      syncError("PROVIDER_AUTH_REQUIRED");
    }
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{
        provider: SourceProvider; credential_ref: string | null; access_state: string;
      }>>(Prisma.sql`
        SELECT "provider"::text AS "provider", "credential_ref", "access_state"::text AS "access_state"
        FROM "source_connections" WHERE "id" = ${connectionId}::uuid FOR UPDATE
      `);
      const connection = rows[0];
      if (!connection || connection.provider !== provider || connection.credential_ref !== expectedRef ||
          connection.credential_ref === newRef || connection.access_state === "BLOCKED") {
        syncError("PROVIDER_AUTH_REQUIRED");
      }
      const state = connection.credential_ref === null ? "PENDING" : "REAUTH_REQUIRED";
      await tx.sourceConnection.update({ where: { id: connectionId }, data: {
        credentialRef: newRef, credentialExpiresAt: expiresAt, accessState: state, enabled: false
      } });
      await writeSecurityAudit(tx, {
        actorType: actorUserId ? SecurityAuditActorType.USER : SecurityAuditActorType.SYSTEM,
        actorUserId, action: connection.credential_ref === null
          ? "STATIC_CREDENTIAL_REF_BOUND" : "STATIC_CREDENTIAL_REF_REPLACED",
        targetType: "SOURCE_CONNECTION", targetId: connectionId, result: SecurityAuditResult.SUCCESS,
        afterJson: { connectionId, provider, accessState: state, expiresAt: expiresAt?.toISOString() ?? null }
      });
      return { accessState: state, enabled: false, credentialExpiresAt: expiresAt };
    }, { timeout: 5_000 });
  }

  // Internal only: the provider adapter may resolve a ref for validation.
  // Expired material is disabled durably before an error is returned.
  async staticCredentialRefForVerification(connectionId: string, provider: "GOOGLE" | "META") {
    const result = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{
        provider: SourceProvider; credential_ref: string | null; credential_expires_at: Date | null;
      }>>(Prisma.sql`
        SELECT "provider"::text AS "provider", "credential_ref", "credential_expires_at"
        FROM "source_connections" WHERE "id" = ${connectionId}::uuid FOR UPDATE
      `);
      const connection = rows[0];
      if (!connection || connection.provider !== provider || !connection.credential_ref) {
        return { ref: null, expired: false };
      }
      if ((!connection.credential_expires_at || connection.credential_expires_at > new Date()) &&
          validStaticRef(provider, connection.credential_ref)) {
        return { ref: connection.credential_ref, expired: false };
      }
      await tx.sourceConnection.update({ where: { id: connectionId }, data: {
        accessState: "REAUTH_REQUIRED", enabled: false
      } });
      await writeSecurityAudit(tx, {
        actorType: SecurityAuditActorType.SYSTEM, action: "STATIC_CREDENTIAL_EXPIRED",
        targetType: "SOURCE_CONNECTION", targetId: connectionId, result: SecurityAuditResult.FAILURE,
        afterJson: { connectionId, provider, accessState: "REAUTH_REQUIRED" }
      });
      return { ref: null, expired: true };
    }, { timeout: 5_000 });
    if (!result.ref) syncError("PROVIDER_AUTH_REQUIRED");
    return result.ref;
  }

  // Cafe24 rotating tokens use encrypted rows and revision CAS.
  async storeCafe24Credential(
    connectionId: string, kind: "CAFE24_REFRESH" | "CAFE24_ACCESS",
    token: string, expiresAt: Date | null, expectedRevision: number | null,
    actorUserId: string | null = null
  ) {
    const sealed = sealCredential(token, connectionId, kind, activeCredentialKeyVersion());
    try {
      return await this.prisma.$transaction(async (tx) => {
        await assertCafe24Connection(tx, connectionId);
        let revision: number;
        if (expectedRevision === null) {
          await tx.sourceCredential.create({ data: { connectionId, kind, ...sealed, expiresAt } });
          revision = 1;
        } else {
          const updated = await tx.sourceCredential.updateMany({
            where: { connectionId, kind, revision: expectedRevision,
              OR: [{ refreshOwner: null }, { refreshUntil: { lt: new Date() } }] },
            data: { ...sealed, expiresAt, revision: { increment: 1 },
              refreshOwner: null, refreshUntil: null }
          });
          if (updated.count !== 1) syncError("PROVIDER_AUTH_REQUIRED");
          revision = expectedRevision + 1;
        }
        // Credential availability is independent of collector enablement.
        if (kind === "CAFE24_REFRESH") {
          await tx.sourceConnection.update({ where: { id: connectionId }, data: {
            credentialRef: `source_credentials:${connectionId}:${kind}`,
            credentialExpiresAt: expiresAt, accessState: "READY"
          } });
        }
        await writeSecurityAudit(tx, {
          actorType: actorUserId ? SecurityAuditActorType.USER : SecurityAuditActorType.SYSTEM,
          actorUserId, action: expectedRevision === null ? "CAFE24_CREDENTIAL_STORED" : "CAFE24_CREDENTIAL_RECONNECTED",
          targetType: "SOURCE_CONNECTION", targetId: connectionId, result: SecurityAuditResult.SUCCESS,
          afterJson: { connectionId, kind, revision }
        });
        return { revision };
      }, { timeout: 5_000 });
    } catch {
      syncError("PROVIDER_AUTH_REQUIRED");
    }
  }

  async readCafe24Refresh(connectionId: string) {
    const connection = await this.prisma.sourceConnection.findUnique({ where: { id: connectionId }, select: { provider: true } });
    if (connection?.provider !== "CAFE24") syncError("PROVIDER_AUTH_REQUIRED");
    const credential = await this.prisma.sourceCredential.findUnique({
      where: { connectionId_kind: { connectionId, kind: "CAFE24_REFRESH" } }
    });
    if (!credential) syncError("PROVIDER_AUTH_REQUIRED");
    return { token: openCredential(credential, connectionId, "CAFE24_REFRESH"), revision: credential.revision };
  }

  async readCafe24Access(connectionId: string) {
    const connection = await this.prisma.sourceConnection.findUnique({
      where: { id: connectionId }, select: { provider: true, accessState: true }
    });
    if (connection?.provider !== "CAFE24" || connection.accessState !== "READY")
      syncError("PROVIDER_AUTH_REQUIRED");
    const credential = await this.prisma.sourceCredential.findUnique({
      where: { connectionId_kind: { connectionId, kind: "CAFE24_ACCESS" } }
    });
    // One order-day read can occupy the full ten-minute bounded deadline.
    // Refresh before starting it instead of letting a valid token expire mid-page.
    if (!credential || !credential.expiresAt ||
        credential.expiresAt.getTime() <= Date.now() + 11 * 60_000)
      return null;
    return openCredential(credential, connectionId, "CAFE24_ACCESS");
  }

  async claimCafe24Refresh(connectionId: string) {
    const connection = await this.prisma.sourceConnection.findUnique({ where: { id: connectionId }, select: { provider: true } });
    if (connection?.provider !== "CAFE24") syncError("PROVIDER_AUTH_REQUIRED");
    const owner = randomUUID();
    const rows = await this.prisma.$queryRaw<Array<{
      ciphertext: Buffer; iv: Buffer; auth_tag: Buffer; key_version: number; revision: number;
    }>>(Prisma.sql`
      UPDATE "source_credentials" SET "refresh_owner" = ${owner}::uuid,
        "refresh_until" = clock_timestamp() + interval '90 seconds', "updated_at" = clock_timestamp()
      WHERE "connection_id" = ${connectionId}::uuid AND "kind" = 'CAFE24_REFRESH'
        AND ("refresh_owner" IS NULL OR "refresh_until" IS NULL OR "refresh_until" <= clock_timestamp())
      RETURNING "ciphertext", "iv", "auth_tag", "key_version", "revision"
    `);
    const row = rows[0];
    if (!row) {
      const existing = await this.prisma.sourceCredential.findUnique({
        where: { connectionId_kind: { connectionId, kind: "CAFE24_REFRESH" } },
        select: { id: true }
      });
      if (!existing) syncError("PROVIDER_AUTH_REQUIRED");
      return null; // Another worker owns the refresh; defer without reconnecting.
    }
    try {
      return {
        owner,
        revision: row.revision,
        token: openCredential({ ciphertext: row.ciphertext, iv: row.iv,
          authTag: row.auth_tag, keyVersion: row.key_version }, connectionId, "CAFE24_REFRESH")
      };
    } catch {
      await this.releaseRefreshClaim(connectionId, owner).catch(() => undefined);
      await this.prisma.sourceConnection.updateMany({ where: { id: connectionId },
        data: { accessState: "REAUTH_REQUIRED", enabled: false } }).catch(() => undefined);
      syncError("PROVIDER_AUTH_REQUIRED");
    }
  }

  async rotateCafe24Refresh(
    connectionId: string, owner: string, expectedRevision: number, token: string, expiresAt: Date | null
  ) {
    const sealed = sealCredential(token, connectionId, "CAFE24_REFRESH", activeCredentialKeyVersion());
    try {
      await this.prisma.$transaction(async (tx) => {
        await assertCafe24Connection(tx, connectionId);
        const result = await tx.sourceCredential.updateMany({
          where: { connectionId, kind: "CAFE24_REFRESH", revision: expectedRevision,
            refreshOwner: owner, refreshUntil: { gt: new Date() } },
          data: { ...sealed, expiresAt, revision: { increment: 1 }, refreshOwner: null, refreshUntil: null }
        });
        if (result.count !== 1) syncError("PROVIDER_AUTH_REQUIRED");
        await tx.sourceConnection.update({ where: { id: connectionId },
          data: { credentialExpiresAt: expiresAt, accessState: "READY" } });
        await writeSecurityAudit(tx, {
          actorType: SecurityAuditActorType.SYSTEM, action: "CAFE24_CREDENTIAL_ROTATED",
          targetType: "SOURCE_CONNECTION", targetId: connectionId, result: SecurityAuditResult.SUCCESS,
          afterJson: { connectionId, kind: "CAFE24_REFRESH", revision: expectedRevision + 1 }
        });
      }, { timeout: 5_000 });
      return expectedRevision + 1;
    } catch {
      // A rotated token may have been issued but not durably stored. Stop until
      // the winner's revision or a reconnection has been checked by a human.
      await this.prisma.sourceConnection.updateMany({
        where: { id: connectionId, provider: "CAFE24" },
        data: { accessState: "REAUTH_REQUIRED", enabled: false }
      }).catch(() => undefined);
      syncError("PROVIDER_AUTH_REQUIRED");
    }
  }

  async releaseRefreshClaim(connectionId: string, owner: string) {
    await this.prisma.sourceCredential.updateMany({
      where: { connectionId, kind: "CAFE24_REFRESH", refreshOwner: owner },
      data: { refreshOwner: null, refreshUntil: null }
    });
  }

  async markCafe24ReauthIfRevision(connectionId: string, expectedRevision: number) {
    await this.prisma.$transaction(async (tx) => {
      await assertCafe24Connection(tx, connectionId);
      const current = await tx.sourceCredential.findUnique({ where: {
        connectionId_kind: { connectionId, kind: "CAFE24_REFRESH" }
      }, select: { revision: true } });
      if (current?.revision === expectedRevision) {
        await tx.sourceConnection.update({ where: { id: connectionId }, data: {
          accessState: "REAUTH_REQUIRED", enabled: false
        } });
      }
    }, { timeout: 5_000 });
  }
}

async function assertCafe24Connection(tx: Prisma.TransactionClient, connectionId: string) {
  const rows = await tx.$queryRaw<Array<{ provider: string; access_state: string }>>(Prisma.sql`
    SELECT "provider"::text AS "provider", "access_state"::text AS "access_state" FROM "source_connections"
    WHERE "id" = ${connectionId}::uuid FOR UPDATE
  `);
  if (rows[0]?.provider !== "CAFE24" || rows[0].access_state === "BLOCKED")
    syncError("PROVIDER_AUTH_REQUIRED");
}

function validStaticRef(provider: "GOOGLE" | "META", ref: string) {
  return new RegExp(`^vault://${provider.toLowerCase()}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`).test(ref);
}
