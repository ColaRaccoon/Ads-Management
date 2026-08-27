import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import {
  AppRole,
  InviteStatus,
  Prisma,
  SecurityAuditActorType,
  SecurityAuditResult
} from "@prisma/client";
import { PrismaService } from "../common/prisma.service";
import { AUTH_CONFIG, AuthConfig } from "./auth.config";
import { authError } from "./auth.errors";
import { AuthenticatedUser, AuthUserResponse } from "./auth.types";
import { AuthCookieService } from "./cookie.service";
import {
  createCredential,
  dummyCredential,
  normalizeUsername,
  ScryptWorkLimiter,
  verifyCredential
} from "./local-credentials";
import { permissionsForRole } from "./role-permissions";
import { writeSecurityAudit } from "../security-audit/security-audit.types";

type TouchedSession = { id: string; appUserId: string; onboardingOnly: boolean; rotationDue: boolean };

@Injectable()
export class LocalAuthService {
  private readonly limiter: ScryptWorkLimiter;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
    private readonly cookies: AuthCookieService
  ) {
    this.limiter = new ScryptWorkLimiter(
      config.localScryptConcurrency,
      config.localScryptQueueLimit
    );
  }

  async login(username: string, password: string) {
    const normalized = safeUsername(username);
    const user = normalized
      ? await this.prisma.appUser.findUnique({
          where: { normalizedUsername: normalized },
          include: { localCredential: true }
        })
      : null;
    const credential = user?.localCredential ?? dummyCredential();
    let verified = false;
    try {
      verified = await verifyCredential(password, credential, this.limiter);
    } catch {
      if (credential !== user?.localCredential) throw authError("INVALID_CREDENTIALS");
      await verifyCredential(password, dummyCredential(), this.limiter).catch(() => false);
    }
    const currentCredential = user?.localCredential;
    if (
      !verified || !user || !currentCredential || !user.isActive ||
      user.inviteStatus !== InviteStatus.ACTIVE
    ) {
      await this.recordAnonymous("LOCAL_LOGIN_FAILED", SecurityAuditResult.FAILURE);
      throw authError("INVALID_CREDENTIALS");
    }

    const issued = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`
        SELECT credential."app_user_id"
        FROM "local_credentials" AS credential
        JOIN "app_users" AS account ON account."id" = credential."app_user_id"
        WHERE credential."app_user_id" = ${user.id}::uuid
        FOR UPDATE OF credential, account
      `);
      const locked = await tx.appUser.findUnique({
        where: { id: user.id }, include: { localCredential: true }
      });
      if (
        !locked?.isActive || locked.inviteStatus !== InviteStatus.ACTIVE ||
        !sameCredential(locked.localCredential, currentCredential)
      ) throw authError("INVALID_CREDENTIALS");
      const result = await this.issueSession(user.id, false, tx);
      await tx.appUser.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
      await writeSecurityAudit(tx, {
        actorUserId: user.id,
        actorType: SecurityAuditActorType.USER,
        action: "LOCAL_LOGIN_SUCCEEDED",
        targetType: "AUTHENTICATION",
        targetId: user.id,
        result: SecurityAuditResult.SUCCESS
      });
      return result;
    });
    const principal = this.toPrincipal(user, issued.sessionId);
    return { sessionToken: issued.token, response: this.toResponse(principal) };
  }

  async authenticateSession(token: string, allowPreviousForRefresh = false) {
    const tokenHash = this.tokenHash("session", token, this.requireSecret("session"));
    const rows = await this.prisma.$queryRaw<TouchedSession[]>(Prisma.sql`
      UPDATE "app_auth_sessions"
      SET
        "last_seen_at" = clock_timestamp(),
        "idle_expires_at" = LEAST(
          "absolute_expires_at",
          clock_timestamp() + (${this.config.localSessionIdleTtlMs}::text || ' milliseconds')::interval
        ),
        "updated_at" = clock_timestamp()
      WHERE (
          "local_token_hash" = ${tokenHash}
          OR (${allowPreviousForRefresh} = true AND "previous_local_token_hash" = ${tokenHash}
            AND "previous_token_valid_until" > clock_timestamp())
        )
        AND "revoked_at" IS NULL
        AND "idle_expires_at" > clock_timestamp()
        AND "absolute_expires_at" > clock_timestamp()
      RETURNING "id", "app_user_id" AS "appUserId", "onboarding_only" AS "onboardingOnly",
        (COALESCE("refreshed_at", "created_at") +
          (${this.config.localSessionRotationTtlMs}::text || ' milliseconds')::interval <= clock_timestamp()) AS "rotationDue"
    `);
    const session = rows[0];
    if (!session) throw authError("SESSION_INVALID");
    const user = await this.prisma.appUser.findUnique({ where: { id: session.appUserId } });
    if (!user || !user.isActive) {
      await this.revokeSessionById(session.id);
      throw authError("SESSION_INVALID");
    }
    const onboarding = user.inviteStatus === InviteStatus.VERIFIED_PENDING_PASSWORD;
    if (session.onboardingOnly !== onboarding || (!onboarding && user.inviteStatus !== InviteStatus.ACTIVE)) {
      await this.revokeSessionById(session.id);
      throw authError("SESSION_INVALID");
    }
    if (!allowPreviousForRefresh && !onboarding && session.rotationDue) {
      throw authError("ACCESS_TOKEN_EXPIRED");
    }
    return this.toPrincipal(user, session.id);
  }

  async refresh(token: string) {
    let principal: AuthenticatedUser;
    try {
      principal = await this.authenticateSession(token, true);
    } catch (error) {
      const familyId = this.validSessionFamilyId(token);
      if (familyId) await this.revokeSessionById(familyId);
      throw error;
    }
    const nextToken = this.createSessionToken(principal.sessionId);
    const oldHash = this.tokenHash("session", token, this.requireSecret("session"));
    const nextHash = this.tokenHash("session", nextToken, this.requireSecret("session"));
    const changed = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      UPDATE "app_auth_sessions"
      SET "previous_local_token_hash" = "local_token_hash",
          "previous_token_valid_until" = clock_timestamp() + interval '5 seconds',
          "local_token_hash" = ${nextHash},
          "refreshed_at" = clock_timestamp(),
          "updated_at" = clock_timestamp()
      WHERE "id" = ${principal.sessionId}::uuid
        AND "local_token_hash" = ${oldHash}
        AND "revoked_at" IS NULL
        AND "absolute_expires_at" > clock_timestamp()
      RETURNING "id"
    `);
    if (changed.length !== 1) throw authError("REFRESH_RACE_RETRY");
    return { sessionToken: nextToken, response: this.toResponse(principal) };
  }

  async logout(token: string | undefined) {
    if (!token) return;
    const familyId = this.validSessionFamilyId(token);
    if (familyId) {
      await this.revokeSessionById(familyId);
      return;
    }
    const tokenHash = this.tokenHash("session", token, this.requireSecret("session"));
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "app_auth_sessions"
      SET "revoked_at" = clock_timestamp(), "updated_at" = clock_timestamp()
      WHERE ("local_token_hash" = ${tokenHash}
          OR ("previous_local_token_hash" = ${tokenHash} AND "previous_token_valid_until" > clock_timestamp()))
        AND "revoked_at" IS NULL
    `);
  }

  async hasActiveBrowserSession(token: string | undefined) {
    if (!token) return false;
    try {
      await this.authenticateSession(token, true);
      return true;
    } catch {
      return false;
    }
  }

  async acceptSetupToken(token: string) {
    const tokenHash = this.tokenHash("setup", token, this.requireSecret("setup"));
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ appUserId: string }>>(Prisma.sql`
        SELECT token."app_user_id" AS "appUserId"
        FROM "local_account_setup_tokens" AS token
        JOIN "app_users" AS account ON account."id" = token."app_user_id"
        WHERE token."token_hash" = ${tokenHash}
          AND token."used_at" IS NULL
          AND token."revoked_at" IS NULL
          AND token."expires_at" > clock_timestamp()
          AND account."is_active" = true
          AND account."invite_status" IN ('INVITED', 'VERIFIED_PENDING_PASSWORD')
        FOR UPDATE OF token, account
      `);
      const appUserId = rows[0]?.appUserId;
      if (!appUserId) throw authError("INVALID_CREDENTIALS");
      await tx.$executeRaw(Prisma.sql`
        UPDATE "local_account_setup_tokens"
        SET "used_at" = clock_timestamp()
        WHERE "token_hash" = ${tokenHash} AND "used_at" IS NULL AND "revoked_at" IS NULL
      `);
      const user = await tx.appUser.update({
        where: { id: appUserId },
        data: { inviteStatus: InviteStatus.VERIFIED_PENDING_PASSWORD }
      });
      const issued = await this.issueSession(user.id, true, tx);
      await writeSecurityAudit(tx, {
        actorUserId: user.id,
        actorType: SecurityAuditActorType.USER,
        action: "LOCAL_SETUP_ACCEPTED",
        targetType: "AUTHENTICATION",
        targetId: user.id,
        result: SecurityAuditResult.SUCCESS
      });
      return {
        sessionToken: issued.token,
        response: this.toResponse(this.toPrincipal(user, issued.sessionId))
      };
    });
  }

  async completeInitialPassword(principal: AuthenticatedUser, password: string) {
    const credential = await createCredential(password, this.limiter);
    const completed = await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ appUserId: string }>>(Prisma.sql`
        SELECT session."app_user_id" AS "appUserId"
        FROM "app_auth_sessions" AS session
        JOIN "app_users" AS account ON account."id" = session."app_user_id"
        WHERE session."id" = ${principal.sessionId}::uuid
          AND session."app_user_id" = ${principal.id}::uuid
          AND session."onboarding_only" = true
          AND session."revoked_at" IS NULL
          AND session."idle_expires_at" > clock_timestamp()
          AND session."absolute_expires_at" > clock_timestamp()
          AND account."is_active" = true
          AND account."invite_status" = 'VERIFIED_PENDING_PASSWORD'
        FOR UPDATE OF session, account
      `);
      if (!locked[0]) {
        throw authError("SESSION_INVALID");
      }
      const user = await tx.appUser.findUniqueOrThrow({ where: { id: principal.id } });
      await tx.localCredential.upsert({
        where: { appUserId: user.id },
        create: { appUserId: user.id, ...credential },
        update: { ...credential, passwordChangedAt: new Date() }
      });
      await tx.appUser.update({
        where: { id: user.id },
        data: { inviteStatus: InviteStatus.ACTIVE, authzVersion: { increment: 1 } }
      });
      await tx.$executeRaw(Prisma.sql`
        UPDATE "app_auth_sessions"
        SET "revoked_at" = clock_timestamp(), "updated_at" = clock_timestamp()
        WHERE "app_user_id" = ${user.id}::uuid AND "revoked_at" IS NULL
      `);
      const updated = await tx.appUser.findUniqueOrThrow({ where: { id: user.id } });
      const issued = await this.issueSession(user.id, false, tx);
      await writeSecurityAudit(tx, {
        actorUserId: user.id,
        actorType: SecurityAuditActorType.USER,
        action: "LOCAL_PASSWORD_SET",
        targetType: "AUTHENTICATION",
        targetId: user.id,
        result: SecurityAuditResult.SUCCESS
      });
      return { updated, issued };
    });
    return {
      sessionToken: completed.issued.token,
      response: this.toResponse(this.toPrincipal(completed.updated, completed.issued.sessionId))
    };
  }

  me(principal: AuthenticatedUser) { return this.toResponse(principal); }

  hashSetupToken(token: string) {
    return this.tokenHash("setup", token, this.requireSecret("setup"));
  }

  private async issueSession(
    appUserId: string,
    onboardingOnly: boolean,
    client: PrismaService | Prisma.TransactionClient = this.prisma
  ) {
    const sessionId = randomUUID();
    const token = this.createSessionToken(sessionId);
    await client.$executeRaw(Prisma.sql`
      INSERT INTO "app_auth_sessions" (
        "id", "app_user_id", "local_token_hash", "idle_expires_at",
        "absolute_expires_at", "onboarding_only", "last_seen_at", "created_at", "updated_at"
      ) VALUES (
        ${sessionId}::uuid,
        ${appUserId}::uuid,
        ${this.tokenHash("session", token, this.requireSecret("session"))},
        clock_timestamp() + (${this.config.localSessionIdleTtlMs}::text || ' milliseconds')::interval,
        clock_timestamp() + (${this.config.localSessionAbsoluteTtlMs}::text || ' milliseconds')::interval,
        ${onboardingOnly}, clock_timestamp(), clock_timestamp(), clock_timestamp()
      )
    `);
    return { token, sessionId };
  }

  private async revokeSessionById(id: string) {
    await this.prisma.appAuthSession.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: new Date() }
    });
  }

  private toPrincipal(user: {
    id: string; username: string | null; email: string | null; name: string; role: AppRole;
    inviteStatus: InviteStatus; isActive: boolean; authzVersion: number;
  }, sessionId: string): AuthenticatedUser {
    return {
      id: user.id,
      authUserId: user.id,
      username: user.username,
      email: user.email,
      name: user.name,
      role: user.role,
      inviteStatus: user.inviteStatus,
      isActive: user.isActive,
      authzVersion: user.authzVersion,
      permissions: user.inviteStatus === InviteStatus.ACTIVE ? permissionsForRole(user.role) : [],
      sessionId
    };
  }

  private toResponse(principal: AuthenticatedUser): AuthUserResponse {
    return {
      user: {
        id: principal.id,
        username: principal.username ?? null,
        email: principal.email,
        name: principal.name,
        role: principal.role,
        isActive: principal.isActive,
        inviteStatus: principal.inviteStatus
      },
      permissions: [...principal.permissions],
      authorizationVersion: this.cookies.authorizationVersion(principal.id, principal.authzVersion)
    };
  }

  private requireSecret(purpose: "session" | "setup") {
    const secret = purpose === "session"
      ? this.config.localSessionTokenSecret
      : this.config.localSetupTokenSecret;
    if (this.config.provider !== "local" || !secret) throw new Error("Local authentication is not configured.");
    return secret;
  }

  private tokenHash(purpose: string, token: string, secret: string) {
    const pattern = purpose === "session"
      ? /^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/i
      : /^[A-Za-z0-9_-]{32,128}$/;
    if (!pattern.test(token)) return "0".repeat(64);
    return createHmac("sha256", secret).update(`${purpose}\0${token}`, "utf8").digest("hex");
  }

  private createSessionToken(sessionId: string) {
    return `${sessionId}.${this.sessionFamilyProof(sessionId)}.${randomBytes(32).toString("base64url")}`;
  }

  private validSessionFamilyId(token: string) {
    const [sessionId, proof, nonce, extra] = token.split(".");
    if (extra || !sessionId || !proof || !nonce ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId) ||
        !/^[A-Za-z0-9_-]{43}$/.test(proof) || !/^[A-Za-z0-9_-]{43}$/.test(nonce)) return null;
    const expected = this.sessionFamilyProof(sessionId);
    const left = Buffer.from(proof);
    const right = Buffer.from(expected);
    return left.length === right.length && timingSafeEqual(left, right) ? sessionId : null;
  }

  private sessionFamilyProof(sessionId: string) {
    return createHmac("sha256", this.requireSecret("session"))
      .update(`session-family\0${sessionId}`, "utf8").digest("base64url");
  }

  private async recordAnonymous(action: string, result: SecurityAuditResult) {
    await this.prisma.securityAuditEvent.create({
      data: {
        actorType: SecurityAuditActorType.ANONYMOUS,
        action,
        targetType: "AUTHENTICATION",
        result
      }
    }).catch(() => undefined);
  }
}

function safeUsername(value: string) {
  try { return normalizeUsername(value); } catch { return null; }
}

function sameCredential(
  left: {
    algorithm: string; version: number; costN: number; blockSizeR: number;
    parallelizationP: number; keyLength: number; salt: string; passwordHash: string;
  } | null,
  right: {
    algorithm: string; version: number; costN: number; blockSizeR: number;
    parallelizationP: number; keyLength: number; salt: string; passwordHash: string;
  }
) {
  return Boolean(left) && left!.algorithm === right.algorithm && left!.version === right.version &&
    left!.costN === right.costN && left!.blockSizeR === right.blockSizeR &&
    left!.parallelizationP === right.parallelizationP && left!.keyLength === right.keyLength &&
    left!.salt === right.salt && left!.passwordHash === right.passwordHash;
}
