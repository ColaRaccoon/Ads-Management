import { randomBytes, randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import {
  AppRole,
  InviteStatus,
  Prisma,
  SecurityAuditActorType,
  SecurityAuditResult
} from "@prisma/client";
import { AUTH_CONFIG, AuthConfig } from "../auth/auth.config";
import { LocalAuthService } from "../auth/local-auth.service";
import { normalizeUsername } from "../auth/local-credentials";
import { PrismaService } from "../common/prisma.service";
import { writeSecurityAudit } from "../security-audit/security-audit.types";
import { InviteUserDto } from "./dto/invite-user.dto";
import { UpdateUserDto } from "./dto/update-user.dto";
import { userLifecycleError } from "./user-lifecycle.errors";

const LOCAL_USER_SELECT = {
  id: true,
  username: true,
  email: true,
  name: true,
  role: true,
  isActive: true,
  inviteStatus: true,
  lastLoginAt: true,
  invitedAt: true,
  createdAt: true,
  updatedAt: true
} satisfies Prisma.AppUserSelect;

@Injectable()
export class LocalUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly localAuth: LocalAuthService,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig
  ) {}

  async list() {
    return {
      items: await this.prisma.appUser.findMany({
        where: { normalizedUsername: { not: null } },
        select: LOCAL_USER_SELECT,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }]
      })
    };
  }

  async invite(body: InviteUserDto, actorId: string, suppliedRequestId?: string) {
    if (!body.username) throw userLifecycleError("USERNAME_INVALID");
    let username: string;
    try { username = normalizeUsername(body.username); }
    catch { throw userLifecycleError("USERNAME_INVALID"); }
    const name = body.name.trim();
    const requestId = suppliedRequestId?.trim() || randomUUID();
    if (!isUuid(requestId)) throw userLifecycleError("IDEMPOTENCY_KEY_INVALID");
    const setupToken = randomBytes(32).toString("base64url");

    try {
      const user = await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`local-user:${username}`}, 0))`;
        const byRequest = await tx.appUser.findUnique({
          where: { invitationRequestId: requestId }, select: LOCAL_USER_SELECT
        });
        if (byRequest) {
          if (byRequest.username !== username || byRequest.name !== name || byRequest.role !== body.role) {
            throw userLifecycleError("IDEMPOTENCY_KEY_CONFLICT");
          }
          if (!byRequest.isActive || byRequest.inviteStatus !== InviteStatus.INVITED) {
            throw userLifecycleError("IDEMPOTENCY_KEY_CONFLICT");
          }
          // A setup token is intentionally non-recoverable. Reissuing it from an
          // idempotent replay would revoke a token already returned to another
          // concurrent caller. The administrator must use the explicit password
          // reset action when the original response was lost.
          throw userLifecycleError("IDEMPOTENCY_REPLAY");
        }
        if (await tx.appUser.findUnique({ where: { normalizedUsername: username } })) {
          throw userLifecycleError("USERNAME_EXISTS");
        }
        const created = await tx.appUser.create({
          data: {
            username,
            normalizedUsername: username,
            name,
            role: body.role,
            inviteStatus: InviteStatus.INVITED,
            invitedAt: new Date(),
            invitedBy: actorId,
            invitationRequestId: requestId
          },
          select: LOCAL_USER_SELECT
        });
        await this.createSetupToken(tx, created.id, setupToken, actorId);
        await writeSecurityAudit(tx, {
          actorUserId: actorId,
          actorType: SecurityAuditActorType.USER,
          action: "LOCAL_USER_CREATED",
          targetType: "APP_USER",
          targetId: created.id,
          result: SecurityAuditResult.SUCCESS,
          afterJson: { id: created.id, role: body.role, isActive: true, inviteStatus: InviteStatus.INVITED },
          requestId
        });
        return created;
      });
      return { ...user, setupToken };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw userLifecycleError("IDEMPOTENCY_KEY_CONFLICT");
      }
      throw error;
    }
  }

  async update(id: string, body: UpdateUserDto, actorId: string) {
    if (body.name === undefined && body.role === undefined && body.isActive === undefined) {
      throw userLifecycleError("USER_UPDATE_EMPTY");
    }
    return this.prisma.$transaction(async (tx) => {
      await lockSuperAdminInvariant(tx);
      const before = await tx.appUser.findUnique({ where: { id }, select: LOCAL_USER_SELECT });
      if (!before) throw userLifecycleError("USER_NOT_FOUND");
      if (!before.username) throw userLifecycleError("USER_NOT_FOUND");
      if (id === actorId && (body.isActive === false || (body.role && body.role !== AppRole.SUPER_ADMIN))) {
        throw userLifecycleError("SELF_LOCKOUT");
      }
      if (
        before.role === AppRole.SUPER_ADMIN && before.isActive && before.inviteStatus === InviteStatus.ACTIVE &&
        (body.isActive === false || (body.role && body.role !== AppRole.SUPER_ADMIN)) &&
        await tx.appUser.count({
          where: {
            normalizedUsername: { not: null }, role: AppRole.SUPER_ADMIN,
            isActive: true, inviteStatus: InviteStatus.ACTIVE
          }
        }) <= 1
      ) throw userLifecycleError("LAST_ACTIVE_SUPER_ADMIN");

      const changed = await tx.appUser.update({
        where: { id },
        data: {
          ...(body.name === undefined ? {} : { name: body.name.trim() }),
          ...(body.role === undefined ? {} : { role: body.role }),
          ...(body.isActive === undefined ? {} : {
            isActive: body.isActive,
            deactivatedAt: body.isActive ? null : new Date()
          }),
          authzVersion: { increment: 1 }
        },
        select: LOCAL_USER_SELECT
      });
      if (body.role !== undefined || body.isActive !== undefined) {
        await tx.$executeRaw(Prisma.sql`
          UPDATE "app_auth_sessions" SET "revoked_at" = clock_timestamp(), "updated_at" = clock_timestamp()
          WHERE "app_user_id" = ${id}::uuid AND "revoked_at" IS NULL
        `);
      }
      if (body.isActive === false) {
        await tx.$executeRaw(Prisma.sql`
          UPDATE "local_account_setup_tokens" SET "revoked_at" = clock_timestamp()
          WHERE "app_user_id" = ${id}::uuid AND "used_at" IS NULL AND "revoked_at" IS NULL
        `);
      }
      await writeSecurityAudit(tx, {
        actorUserId: actorId,
        actorType: SecurityAuditActorType.USER,
        action: "LOCAL_USER_UPDATED",
        targetType: "APP_USER",
        targetId: id,
        result: SecurityAuditResult.SUCCESS,
        beforeJson: summaryAudit(before),
        afterJson: summaryAudit(changed)
      });
      return changed;
    });
  }

  async resetPassword(id: string, actorId: string) {
    if (id === actorId) throw userLifecycleError("SELF_LOCKOUT");
    const setupToken = randomBytes(32).toString("base64url");
    const user = await this.prisma.$transaction(async (tx) => {
      await lockSuperAdminInvariant(tx);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`local-reset:${id}`}, 0))`;
      const current = await tx.appUser.findUnique({ where: { id }, select: LOCAL_USER_SELECT });
      if (!current) throw userLifecycleError("USER_NOT_FOUND");
      if (!current.username) throw userLifecycleError("USER_NOT_FOUND");
      if (!current.isActive) throw userLifecycleError("INVALID_USER_TRANSITION");
      if (
        current.role === AppRole.SUPER_ADMIN && current.inviteStatus === InviteStatus.ACTIVE &&
        await tx.appUser.count({
          where: {
            normalizedUsername: { not: null }, role: AppRole.SUPER_ADMIN,
            isActive: true, inviteStatus: InviteStatus.ACTIVE
          }
        }) <= 1
      ) throw userLifecycleError("LAST_ACTIVE_SUPER_ADMIN");
      await tx.$executeRaw(Prisma.sql`
        UPDATE "local_account_setup_tokens" SET "revoked_at" = clock_timestamp()
        WHERE "app_user_id" = ${id}::uuid AND "used_at" IS NULL AND "revoked_at" IS NULL
      `);
      await tx.$executeRaw(Prisma.sql`
        UPDATE "app_auth_sessions" SET "revoked_at" = clock_timestamp(), "updated_at" = clock_timestamp()
        WHERE "app_user_id" = ${id}::uuid AND "revoked_at" IS NULL
      `);
      await this.createSetupToken(tx, id, setupToken, actorId);
      const changed = await tx.appUser.update({
        where: { id },
        data: { inviteStatus: InviteStatus.INVITED, authzVersion: { increment: 1 } },
        select: LOCAL_USER_SELECT
      });
      await writeSecurityAudit(tx, {
        actorUserId: actorId,
        actorType: SecurityAuditActorType.USER,
        action: "LOCAL_PASSWORD_RESET_REQUESTED",
        targetType: "APP_USER",
        targetId: id,
        result: SecurityAuditResult.SUCCESS,
        beforeJson: summaryAudit(current),
        afterJson: summaryAudit(changed)
      });
      return changed;
    });
    return { ...user, setupToken };
  }

  private async createSetupToken(
    tx: Prisma.TransactionClient,
    appUserId: string,
    token: string,
    actorId: string
  ) {
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "local_account_setup_tokens" (
        "id", "app_user_id", "token_hash", "expires_at", "created_by", "created_at"
      ) VALUES (
        ${randomUUID()}::uuid,
        ${appUserId}::uuid,
        ${this.localAuth.hashSetupToken(token)},
        clock_timestamp() + (${this.config.localSetupTokenTtlMs}::text || ' milliseconds')::interval,
        ${actorId}::uuid,
        clock_timestamp()
      )
    `);
  }
}

function summaryAudit(user: {
  id: string; username: string | null; name: string; role: AppRole;
  isActive: boolean; inviteStatus: InviteStatus;
}) {
  return {
    id: user.id,
    role: user.role,
    isActive: user.isActive,
    inviteStatus: user.inviteStatus
  } satisfies Prisma.InputJsonObject;
}

async function lockSuperAdminInvariant(tx: Prisma.TransactionClient) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('app-user-super-admin-invariant', 0))`;
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
