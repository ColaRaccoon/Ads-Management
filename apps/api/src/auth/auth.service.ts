import { Inject, Injectable } from "@nestjs/common";
import {
  AppRole,
  AppUser,
  InviteStatus,
  Prisma,
  SecurityAuditActorType,
  SecurityAuditResult
} from "@prisma/client";
import { PrismaService } from "../common/prisma.service";
import { AuthCookieService } from "./cookie.service";
import { authError, AuthHttpException } from "./auth.errors";
import { AuthenticatedUser, AuthUserResponse, ProviderSession } from "./auth.types";
import {
  IDENTITY_PROVIDER,
  IdentityProvider,
  ProviderInvalidCredentialsError,
  ProviderInvalidInvitationError,
  ProviderInvalidRefreshTokenError,
  ProviderPasswordPolicyError,
  ProviderUnavailableError
} from "./identity-provider";
import { normalizeEmail, normalizeEmailOrNull } from "./email-normalizer";
import { permissionsForRole } from "./role-permissions";
import { SupabaseJwtVerifier } from "./supabase-jwt.verifier";
import { invitationError, InvitationHttpException } from "./invitation.errors";
import { securityAuditData, userAuditSnapshot, writeSecurityAudit } from "../security-audit/security-audit.types";
import { canTransitionInvitation, lockInvitationState } from "../users/invite-state-machine";

type AuthTokens = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  sessionId: string;
};

export type AuthResult = { response: AuthUserResponse; cookies: AuthTokens };
export type AuthRefreshResult = AuthResult | { recoveryRefreshToken: string };

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(IDENTITY_PROVIDER) private readonly provider: IdentityProvider,
    private readonly jwtVerifier: SupabaseJwtVerifier,
    private readonly cookies: AuthCookieService
  ) {}

  async login(email: string, password: string): Promise<AuthResult> {
    const normalizedEmail = normalizeEmail(email);
    let providerSession: ProviderSession;
    try {
      providerSession = await this.provider.signInWithPassword(normalizedEmail, password);
    } catch (error) {
      await this.recordAnonymousAudit("LOGIN_FAILED", SecurityAuditResult.FAILURE);
      if (error instanceof ProviderInvalidCredentialsError) throw authError("INVALID_CREDENTIALS");
      throw authError("AUTH_PROVIDER_UNAVAILABLE");
    }

    try {
      const token = await this.jwtVerifier.verify(providerSession.accessToken);
      const providerEmail = normalizeEmailOrNull(providerSession.user.email);
      if (
        token.subject !== providerSession.user.id ||
        !providerSession.user.emailVerified ||
        providerEmail !== normalizedEmail
      ) {
        throw authError("SESSION_INVALID");
      }

      const principal = await this.prisma.$transaction(async (tx) => {
        const user = await tx.appUser.findUnique({ where: { authUserId: token.subject } });
        this.assertUsableUser(user);
        if (user.normalizedEmail !== providerEmail) throw authError("ACCOUNT_NOT_PROVISIONED");

        const existing = await tx.appAuthSession.findUnique({
          where: { providerSessionId: token.sessionId }
        });
        if (existing?.appUserId !== undefined && existing.appUserId !== user.id) {
          throw authError("SESSION_INVALID");
        }
        if (existing?.revokedAt) throw authError("SESSION_REVOKED");

        const appSession = existing
          ? await tx.appAuthSession.update({
              where: { id: existing.id },
              data: { lastSeenAt: new Date() }
            })
          : await tx.appAuthSession.create({
              data: {
                appUserId: user.id,
                providerSessionId: token.sessionId,
                lastSeenAt: new Date()
              }
            });
        const updatedUser = await tx.appUser.update({
          where: { id: user.id },
          data: { lastLoginAt: new Date() }
        });
        await writeSecurityAudit(tx, {
          actorUserId: updatedUser.id,
          actorType: SecurityAuditActorType.USER,
          action: "LOGIN_SUCCEEDED",
          targetType: "APP_USER",
          targetId: updatedUser.id,
          result: SecurityAuditResult.SUCCESS,
          afterJson: { id: updatedUser.id, role: updatedUser.role }
        });
        return this.toPrincipal(updatedUser, appSession.id);
      });

      return {
        response: this.toResponse(principal),
        cookies: {
          accessToken: providerSession.accessToken,
          refreshToken: providerSession.refreshToken,
          expiresIn: providerSession.expiresIn,
          sessionId: principal.sessionId
        }
      };
    } catch (error) {
      await this.revokeProviderQuietly(providerSession.accessToken);
      await this.recordAnonymousAudit("LOGIN_FAILED", SecurityAuditResult.FAILURE);
      throw error;
    }
  }

  async authenticateAccessToken(accessToken: string): Promise<AuthenticatedUser> {
    const token = await this.jwtVerifier.verify(accessToken);
    const user = await this.prisma.appUser.findUnique({ where: { authUserId: token.subject } });
    this.assertAuthenticatableUser(user);

    const session = await this.prisma.appAuthSession.findUnique({
      where: { providerSessionId: token.sessionId }
    });
    if (!session || session.appUserId !== user.id) throw authError("SESSION_INVALID");
    if (session.revokedAt) throw authError("SESSION_REVOKED");
    await this.prisma.appAuthSession.update({
      where: { id: session.id },
      data: { lastSeenAt: new Date() }
    });
    return this.toPrincipal(user, session.id);
  }

  async refresh(refreshToken: string, signedHandle: string): Promise<AuthRefreshResult> {
    const appSessionId = this.cookies.verifySessionHandle(signedHandle);
    if (!appSessionId) throw authError("SESSION_INVALID");

    let rotatedRefreshToken: string | undefined;
    let recoveryAllowed = false;
    let result: Awaited<ReturnType<typeof this.runRefreshTransaction>>;
    try {
      result = await this.runRefreshTransaction(appSessionId, refreshToken, (token, allowed) => {
        rotatedRefreshToken = token;
        recoveryAllowed = allowed;
      });
    } catch (error) {
      const recoveryToken = rotatedRefreshToken;
      if (recoveryAllowed && recoveryToken) {
        return { recoveryRefreshToken: recoveryToken };
      }
      throw error;
    }

    if ("recovery" in result && typeof result.recovery === "string") {
      return { recoveryRefreshToken: result.recovery };
    }
    if ("error" in result) throw result.error;
    return result.value;
  }

  private async runRefreshTransaction(
    appSessionId: string,
    refreshToken: string,
    recordRotation: (refreshToken: string, recoveryAllowed: boolean) => void
  ) {
    return this.prisma.$transaction(async (tx) => {
      const [requestClock] = await tx.$queryRaw<Array<{ observedAt: Date }>>
        `SELECT clock_timestamp() AS "observedAt"`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${appSessionId}, 0))`;
      const appSession = await tx.appAuthSession.findUnique({
        where: { id: appSessionId },
        include: { appUser: true }
      });
      if (!appSession) return { error: authError("SESSION_INVALID") } as const;
      if (appSession.revokedAt) return { error: authError("SESSION_REVOKED") } as const;
      if (
        appSession.refreshedAt &&
        appSession.refreshedAt.getTime() >= requestClock.observedAt.getTime()
      ) {
        return { error: authError("REFRESH_RACE_RETRY") } as const;
      }

      try {
        this.assertAuthenticatableUser(appSession.appUser);
      } catch (error) {
        await tx.appAuthSession.update({
          where: { id: appSession.id },
          data: { revokedAt: new Date() }
        });
        return { error: asAuthError(error) } as const;
      }

      let providerSession: ProviderSession;
      try {
        providerSession = await this.provider.refreshSession(refreshToken);
        recordRotation(providerSession.refreshToken, false);
      } catch (error) {
        if (error instanceof ProviderUnavailableError) throw authError("AUTH_PROVIDER_UNAVAILABLE");
        if (error instanceof ProviderInvalidRefreshTokenError) {
          await tx.appAuthSession.update({
            where: { id: appSession.id },
            data: { revokedAt: new Date() }
          });
          return { error: authError("SESSION_REVOKED") } as const;
        }
        throw authError("AUTH_PROVIDER_UNAVAILABLE");
      }

      try {
        const token = await this.jwtVerifier.verify(providerSession.accessToken);
        const email = normalizeEmailOrNull(providerSession.user.email);
        if (
          token.subject !== appSession.appUser.authUserId ||
          token.sessionId !== appSession.providerSessionId ||
          providerSession.user.id !== appSession.appUser.authUserId ||
          !providerSession.user.emailVerified ||
          email !== appSession.appUser.normalizedEmail
        ) {
          await tx.appAuthSession.update({
            where: { id: appSession.id },
            data: { revokedAt: new Date() }
          });
          return { error: authError("SESSION_REVOKED") } as const;
        }

        recordRotation(providerSession.refreshToken, true);
        const [refreshClock] = await tx.$queryRaw<Array<{ observedAt: Date }>>
          `SELECT clock_timestamp() AS "observedAt"`;
        const refreshedAt = refreshClock.observedAt;
        await tx.appAuthSession.update({
          where: { id: appSession.id },
          data: { refreshedAt, lastSeenAt: refreshedAt }
        });
        const principal = this.toPrincipal(appSession.appUser, appSession.id);
        return {
          value: {
            response: this.toResponse(principal),
            cookies: {
              accessToken: providerSession.accessToken,
              refreshToken: providerSession.refreshToken,
              expiresIn: providerSession.expiresIn,
              sessionId: appSession.id
            }
          }
        } as const;
      } catch (error) {
        if (
          error instanceof AuthHttpException &&
          error.code === "AUTH_PROVIDER_UNAVAILABLE"
        ) {
          recordRotation(providerSession.refreshToken, true);
          return { recovery: providerSession.refreshToken } as const;
        }
        if (error instanceof AuthHttpException) {
          await tx.appAuthSession.update({
            where: { id: appSession.id },
            data: { revokedAt: new Date() }
          });
          return { error: authError("SESSION_REVOKED") } as const;
        }
        throw error;
      }
    // The transaction can contain one bounded provider refresh (10s) followed
    // by a remote JWKS cache miss (jose defaults to 5s). Keep explicit slack so
    // an upstream outage is returned as the stable 503 without losing cookies.
    }, { timeout: 30_000 });
  }

  async logout(
    signedHandle: string | undefined,
    accessToken: string | undefined,
    refreshToken: string | undefined
  ) {
    const appSessionId = this.cookies.verifySessionHandle(signedHandle);
    let localSession: Prisma.AppAuthSessionGetPayload<{ include: { appUser: true } }> | null = null;
    if (appSessionId) {
      localSession = await this.prisma.$transaction(async (tx) => {
        const session = await tx.appAuthSession.findUnique({
          where: { id: appSessionId },
          include: { appUser: true }
        });
        if (session && !session.revokedAt) {
          await tx.appAuthSession.update({
            where: { id: session.id },
            data: { revokedAt: new Date() }
          });
        }
        return session;
      });
    }
    if (!localSession) return;

    let providerAccessToken: string | undefined;
    if (accessToken) {
      try {
        const verified = await this.jwtVerifier.verify(accessToken);
        if (
          verified.sessionId === localSession.providerSessionId &&
          verified.subject === localSession.appUser.authUserId
        ) {
          providerAccessToken = accessToken;
        }
      } catch {
        // An expired/invalid access token can still be recovered via refresh below.
      }
    }
    if (!providerAccessToken && refreshToken) {
      try {
        const refreshed = await this.provider.refreshSession(refreshToken);
        const verified = await this.jwtVerifier.verify(refreshed.accessToken);
        if (
          verified.sessionId === localSession.providerSessionId &&
          verified.subject === localSession.appUser.authUserId &&
          refreshed.user.id === localSession.appUser.authUserId
        ) {
          providerAccessToken = refreshed.accessToken;
        }
      } catch {
        // Local revocation and cookie clearing remain authoritative.
      }
    }
    if (providerAccessToken) await this.revokeProviderQuietly(providerAccessToken);
  }

  me(principal: AuthenticatedUser) {
    return this.toResponse(principal);
  }

  async hasActiveBrowserSession(signedHandle: string | undefined) {
    const id = this.cookies.verifySessionHandle(signedHandle);
    if (!id) return false;
    const session = await this.prisma.appAuthSession.findUnique({ where: { id } });
    return Boolean(session && !session.revokedAt);
  }

  async acceptInvitation(tokenHash: string, tokenType?: "invite" | "recovery"): Promise<AuthResult> {
    let providerSession: ProviderSession;
    try {
      // Recovery proves mailbox ownership, but the INVITED state, identity and
      // invitation request checks below still apply. This is not a general reset.
      providerSession = tokenType
        ? await this.provider.verifyInvitationToken(tokenHash, tokenType)
        : await this.provider.verifyInvitationToken(tokenHash);
    } catch (error) {
      await this.recordAnonymousAudit("USER_INVITATION_ACCEPT_FAILED", SecurityAuditResult.FAILURE);
      if (error instanceof ProviderUnavailableError) throw authError("AUTH_PROVIDER_UNAVAILABLE");
      throw invitationError("INVITATION_INVALID_OR_EXPIRED");
    }

    try {
      const token = await this.jwtVerifier.verify(providerSession.accessToken);
      const providerEmail = normalizeEmailOrNull(providerSession.user.email);
      if (
        token.subject !== providerSession.user.id ||
        !providerSession.user.emailVerified ||
        !providerEmail ||
        !providerSession.user.invitationRequestId
      ) throw invitationError("INVITATION_INVALID_OR_EXPIRED");

      const candidate = await this.prisma.appUser.findUnique({
        where: { authUserId: token.subject },
        select: { id: true }
      });
      if (!candidate) throw invitationError("INVITATION_INVALID_OR_EXPIRED");
      const principal = await this.prisma.$transaction(async (tx) => {
        await lockInvitationState(tx, candidate.id);
        const user = await tx.appUser.findUnique({ where: { id: candidate.id } });
        if (
          !user || !user.isActive || user.inviteStatus !== InviteStatus.INVITED ||
          user.authUserId !== token.subject ||
          user.normalizedEmail !== providerEmail ||
          user.invitationRequestId !== providerSession.user.invitationRequestId
        ) throw invitationError("INVITATION_INVALID_OR_EXPIRED");
        if (!canTransitionInvitation(user.inviteStatus, InviteStatus.VERIFIED_PENDING_PASSWORD)) {
          throw invitationError("INVITATION_INVALID_OR_EXPIRED");
        }
        const existing = await tx.appAuthSession.findUnique({
          where: { providerSessionId: token.sessionId }
        });
        if (existing && (existing.appUserId !== user.id || existing.revokedAt)) {
          throw invitationError("INVITATION_INVALID_OR_EXPIRED");
        }
        const session = existing ?? await tx.appAuthSession.create({
          data: {
            appUserId: user.id,
            providerSessionId: token.sessionId,
            lastSeenAt: new Date()
          }
        });
        const updated = await tx.appUser.update({
          where: { id: user.id },
          data: {
            inviteStatus: InviteStatus.VERIFIED_PENDING_PASSWORD,
            invitationErrorCode: null,
            authzVersion: { increment: 1 }
          }
        });
        await writeSecurityAudit(tx, {
          actorUserId: updated.id,
          actorType: SecurityAuditActorType.USER,
          action: "USER_INVITATION_ACCEPTED",
          targetType: "APP_USER",
          targetId: updated.id,
          result: SecurityAuditResult.SUCCESS,
          beforeJson: userAuditSnapshot(user),
          afterJson: userAuditSnapshot(updated),
          requestId: updated.invitationRequestId
        });
        return this.toPrincipal(updated, session.id);
      });
      return {
        response: this.toResponse(principal),
        cookies: {
          accessToken: providerSession.accessToken,
          refreshToken: providerSession.refreshToken,
          expiresIn: providerSession.expiresIn,
          sessionId: principal.sessionId
        }
      };
    } catch (error) {
      await this.revokeProviderQuietly(providerSession.accessToken);
      if (!(error instanceof InvitationHttpException) && !(error instanceof AuthHttpException)) {
        await this.markAcceptCommitFailure(providerSession.user.id).catch(() => undefined);
      }
      if (error instanceof AuthHttpException && error.code === "AUTH_PROVIDER_UNAVAILABLE") throw error;
      throw invitationError("INVITATION_INVALID_OR_EXPIRED");
    }
  }

  async completeInitialPassword(principal: AuthenticatedUser, accessToken: string, password: string) {
    if (principal.inviteStatus !== InviteStatus.VERIFIED_PENDING_PASSWORD) {
      throw invitationError("ONBOARDING_SESSION_REQUIRED");
    }
    let providerUser;
    try {
      providerUser = await this.provider.updatePassword(accessToken, password);
    } catch (error) {
      if (error instanceof ProviderPasswordPolicyError) throw invitationError("PASSWORD_POLICY_INVALID");
      if (error instanceof ProviderInvalidInvitationError) throw invitationError("ONBOARDING_SESSION_REQUIRED");
      throw invitationError("PASSWORD_PROVIDER_UNAVAILABLE");
    }
    if (
      providerUser.id !== principal.authUserId ||
      normalizeEmailOrNull(providerUser.email) !== normalizeEmailOrNull(principal.email)
    ) throw invitationError("ONBOARDING_SESSION_REQUIRED");

    try {
      const updatedPrincipal = await this.prisma.$transaction(async (tx) => {
        await lockInvitationState(tx, principal.id);
        const user = await tx.appUser.findUnique({ where: { id: principal.id } });
        const session = await tx.appAuthSession.findUnique({ where: { id: principal.sessionId } });
        if (
          !user || !session || session.revokedAt || session.appUserId !== user.id ||
          user.authUserId !== providerUser.id || !user.isActive ||
          user.inviteStatus !== InviteStatus.VERIFIED_PENDING_PASSWORD
        ) throw invitationError("ONBOARDING_SESSION_REQUIRED");
        if (!canTransitionInvitation(user.inviteStatus, InviteStatus.ACTIVE)) {
          throw invitationError("ONBOARDING_SESSION_REQUIRED");
        }
        const updated = await tx.appUser.update({
          where: { id: user.id },
          data: {
            inviteStatus: InviteStatus.ACTIVE,
            authzVersion: { increment: 1 },
            invitationErrorCode: null
          }
        });
        await writeSecurityAudit(tx, {
          actorUserId: user.id,
          actorType: SecurityAuditActorType.USER,
          action: "USER_INITIAL_PASSWORD_COMPLETED",
          targetType: "APP_USER",
          targetId: user.id,
          result: SecurityAuditResult.SUCCESS,
          beforeJson: userAuditSnapshot(user),
          afterJson: userAuditSnapshot(updated),
          requestId: user.invitationRequestId
        });
        return this.toPrincipal(updated, session.id);
      });
      return this.toResponse(updatedPrincipal);
    } catch (error) {
      await this.prisma.securityAuditEvent.create({
        data: securityAuditData({
          actorUserId: principal.id,
          actorType: SecurityAuditActorType.USER,
          action: "USER_INITIAL_PASSWORD_LOCAL_COMMIT_FAILED",
          targetType: "APP_USER",
          targetId: principal.id,
          result: SecurityAuditResult.PARTIAL,
          afterJson: { identityCredentialUpdated: true }
        })
      }).catch(() => undefined);
      throw invitationError("PASSWORD_LOCAL_COMMIT_FAILED");
    }
  }

  private assertUsableUser(user: AppUser | null): asserts user is AppUser {
    if (!user) throw authError("ACCOUNT_NOT_PROVISIONED");
    if (!user.isActive) throw authError("ACCOUNT_INACTIVE");
    if (user.inviteStatus !== InviteStatus.ACTIVE) {
      throw authError("ACCOUNT_ONBOARDING_REQUIRED");
    }
  }

  private assertAuthenticatableUser(user: AppUser | null): asserts user is AppUser {
    if (!user) throw authError("ACCOUNT_NOT_PROVISIONED");
    if (!user.isActive) throw authError("ACCOUNT_INACTIVE");
    if (
      user.inviteStatus !== InviteStatus.ACTIVE &&
      user.inviteStatus !== InviteStatus.VERIFIED_PENDING_PASSWORD
    ) throw authError("ACCOUNT_ONBOARDING_REQUIRED");
  }

  private toPrincipal(user: AppUser, sessionId: string): AuthenticatedUser {
    return {
      id: user.id,
      authUserId: user.authUserId!,
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
        email: principal.email,
        name: principal.name,
        role: principal.role,
        isActive: principal.isActive,
        inviteStatus: principal.inviteStatus
      },
      permissions: [...principal.permissions],
      authorizationVersion: this.cookies.authorizationVersion(
        principal.id,
        principal.authzVersion
      )
    };
  }

  private async revokeProviderQuietly(accessToken: string) {
    try {
      await this.provider.revokeSession(accessToken);
    } catch {
      // Local session state and cookie clearing remain authoritative.
    }
  }

  private async recordAnonymousAudit(action: string, result: SecurityAuditResult) {
    await this.prisma.securityAuditEvent.create({
      data: securityAuditData({
        actorType: SecurityAuditActorType.ANONYMOUS,
        action,
        targetType: "AUTHENTICATION",
        result
      })
    }).catch(() => undefined);
  }

  private async markAcceptCommitFailure(authUserId: string) {
    const candidate = await this.prisma.appUser.findUnique({
      where: { authUserId },
      select: { id: true }
    });
    if (!candidate) return;
    await this.prisma.$transaction(async (tx) => {
      await lockInvitationState(tx, candidate.id);
      const user = await tx.appUser.findUnique({ where: { id: candidate.id } });
      if (
        !user || user.authUserId !== authUserId ||
        user.inviteStatus !== InviteStatus.INVITED
      ) return;
      if (!canTransitionInvitation(user.inviteStatus, InviteStatus.RECONCILE_REQUIRED)) return;
      const updated = await tx.appUser.update({
        where: { id: user.id },
        data: {
          inviteStatus: InviteStatus.RECONCILE_REQUIRED,
          invitationErrorCode: "INVITATION_ACCEPT_LOCAL_COMMIT_FAILED",
          authzVersion: { increment: 1 }
        }
      });
      await writeSecurityAudit(tx, {
        actorType: SecurityAuditActorType.ANONYMOUS,
        action: "USER_INVITATION_ACCEPT_LOCAL_COMMIT_FAILED",
        targetType: "APP_USER",
        targetId: user.id,
        result: SecurityAuditResult.PARTIAL,
        beforeJson: userAuditSnapshot(user),
        afterJson: userAuditSnapshot(updated),
        requestId: user.invitationRequestId
      });
    });
  }
}

function asAuthError(error: unknown) {
  return error instanceof AuthHttpException ? error : authError("SESSION_INVALID");
}
