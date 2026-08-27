import { createHmac } from "node:crypto";
import { AppRole, InviteStatus, Prisma, SecurityAuditActorType, SecurityAuditResult } from "@prisma/client";
import { AuthConfig } from "./auth.config";
import { normalizeUsername } from "./local-credentials";
import { PrismaService } from "../common/prisma.service";
import { writeSecurityAudit } from "../security-audit/security-audit.types";

export class BootstrapLocalSuperAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AuthConfig
  ) {}

  async inspect(usernameInput: string) {
    const username = normalizeUsername(usernameInput);
    const count = await this.prisma.appUser.count({ where: localIdentityWhere() });
    return { canApply: count === 0, plannedUsers: 1, username };
  }

  async inspectRecovery(usernameInput: string) {
    const username = normalizeUsername(usernameInput);
    const users = await this.prisma.appUser.findMany({
      where: localIdentityWhere(),
      select: { username: true, role: true, isActive: true, inviteStatus: true, localCredential: { select: { appUserId: true } } }
    });
    const user = users.find((candidate) => candidate.username === username);
    const activeSuperAdmins = users.filter((candidate) =>
      candidate.role === AppRole.SUPER_ADMIN && candidate.isActive && candidate.inviteStatus === InviteStatus.ACTIVE
    );
    const unfinishedBootstrap = activeSuperAdmins.length === 0 && user?.localCredential === null &&
      (user?.inviteStatus === InviteStatus.INVITED || user?.inviteStatus === InviteStatus.VERIFIED_PENDING_PASSWORD);
    const activeBreakGlass = activeSuperAdmins.length === 1 && activeSuperAdmins[0]?.username === username &&
      user?.localCredential !== null;
    return {
      canRecover: Boolean(user && user.role === AppRole.SUPER_ADMIN && user.isActive && (unfinishedBootstrap || activeBreakGlass)),
      recoveryKind: activeBreakGlass ? "ACTIVE_BREAK_GLASS" as const : unfinishedBootstrap ? "UNFINISHED_BOOTSTRAP" as const : null,
      plannedUsers: 0,
      username
    };
  }

  async apply(usernameInput: string, setupToken: string) {
    const username = normalizeUsername(usernameInput);
    if (!/^[A-Za-z0-9_-]{43}$/.test(setupToken)) throw new Error("BOOTSTRAP_SETUP_TOKEN_INVALID");
    const secret = this.config.localSetupTokenSecret;
    if (this.config.provider !== "local" || !secret) {
      throw new Error("Local authentication setup secret is unavailable.");
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('local-bootstrap-super-admin', 0))`;
      if (await tx.appUser.count({ where: localIdentityWhere() }) !== 0) {
        throw new Error("BOOTSTRAP_REQUIRES_EMPTY_LOCAL_IDENTITY_SET");
      }
      const user = await tx.appUser.create({
        data: {
          username,
          normalizedUsername: username,
          name: "Local super administrator",
          role: AppRole.SUPER_ADMIN,
          inviteStatus: InviteStatus.INVITED,
          invitedAt: new Date()
        }
      });
      const tokenHash = createHmac("sha256", secret)
        .update(`setup\0${setupToken}`, "utf8")
        .digest("hex");
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "local_account_setup_tokens" (
          "id", "app_user_id", "token_hash", "expires_at", "created_at"
        ) VALUES (
          gen_random_uuid(), ${user.id}::uuid, ${tokenHash},
          clock_timestamp() + (${this.config.localSetupTokenTtlMs}::text || ' milliseconds')::interval,
          clock_timestamp()
        )
      `);
      await writeSecurityAudit(tx, {
        actorType: SecurityAuditActorType.SYSTEM,
        action: "LOCAL_SUPER_ADMIN_BOOTSTRAPPED",
        targetType: "APP_USER",
        targetId: user.id,
        result: SecurityAuditResult.SUCCESS,
        afterJson: {
          id: user.id,
          role: AppRole.SUPER_ADMIN,
          isActive: true,
          inviteStatus: InviteStatus.INVITED
        }
      });
    });
    return { usersCreated: 1 };
  }

  async recover(usernameInput: string, setupToken: string) {
    const username = normalizeUsername(usernameInput);
    if (!/^[A-Za-z0-9_-]{43}$/.test(setupToken)) throw new Error("BOOTSTRAP_SETUP_TOKEN_INVALID");
    const secret = this.config.localSetupTokenSecret;
    if (this.config.provider !== "local" || !secret) throw new Error("Local authentication setup secret is unavailable.");
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('local-bootstrap-super-admin', 0))`;
      const users = await tx.appUser.findMany({
        where: localIdentityWhere(),
        select: { id: true, username: true, role: true, isActive: true, inviteStatus: true, localCredential: { select: { appUserId: true } } }
      });
      const user = users.find((candidate) => candidate.username === username);
      const activeSuperAdmins = users.filter((candidate) =>
        candidate.role === AppRole.SUPER_ADMIN && candidate.isActive && candidate.inviteStatus === InviteStatus.ACTIVE
      );
      const unfinishedBootstrap = activeSuperAdmins.length === 0 && user?.localCredential === null &&
        (user?.inviteStatus === InviteStatus.INVITED || user?.inviteStatus === InviteStatus.VERIFIED_PENDING_PASSWORD);
      const activeBreakGlass = activeSuperAdmins.length === 1 && activeSuperAdmins[0]?.username === username &&
        user?.localCredential !== null;
      if (!user || user.role !== AppRole.SUPER_ADMIN || !user.isActive || (!unfinishedBootstrap && !activeBreakGlass)) {
        throw new Error("BOOTSTRAP_RECOVERY_STATE_REJECTED");
      }
      await tx.$executeRaw(Prisma.sql`
        UPDATE "local_account_setup_tokens" SET "revoked_at" = clock_timestamp()
        WHERE "app_user_id" = ${user.id}::uuid AND "used_at" IS NULL AND "revoked_at" IS NULL
      `);
      await tx.$executeRaw(Prisma.sql`
        UPDATE "app_auth_sessions" SET "revoked_at" = clock_timestamp(), "updated_at" = clock_timestamp()
        WHERE "app_user_id" = ${user.id}::uuid AND "revoked_at" IS NULL
      `);
      if (activeBreakGlass) {
        await tx.localCredential.delete({ where: { appUserId: user.id } });
      }
      await tx.appUser.update({
        where: { id: user.id },
        data: { inviteStatus: InviteStatus.INVITED, authzVersion: { increment: 1 } }
      });
      const tokenHash = createHmac("sha256", secret).update(`setup\0${setupToken}`, "utf8").digest("hex");
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "local_account_setup_tokens" ("id", "app_user_id", "token_hash", "expires_at", "created_at")
        VALUES (gen_random_uuid(), ${user.id}::uuid, ${tokenHash},
          clock_timestamp() + (${this.config.localSetupTokenTtlMs}::text || ' milliseconds')::interval,
          clock_timestamp())
      `);
      await writeSecurityAudit(tx, {
        actorType: SecurityAuditActorType.SYSTEM,
        action: activeBreakGlass ? "LOCAL_SUPER_ADMIN_BREAK_GLASS_RECOVERY" : "LOCAL_SUPER_ADMIN_SETUP_RECOVERED",
        targetType: "APP_USER",
        targetId: user.id,
        result: SecurityAuditResult.SUCCESS,
        afterJson: { id: user.id, role: AppRole.SUPER_ADMIN, isActive: true, inviteStatus: InviteStatus.INVITED }
      });
    });
    return { usersCreated: 0, setupTokensReissued: 1 };
  }
}

function localIdentityWhere(): Prisma.AppUserWhereInput {
  return {
    OR: [
      { normalizedUsername: { not: null } },
      { localCredential: { isNot: null } }
    ]
  };
}
