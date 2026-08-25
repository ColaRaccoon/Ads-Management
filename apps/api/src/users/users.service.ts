import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import {
  AppRole,
  InviteStatus,
  Prisma,
  SecurityAuditActorType,
  SecurityAuditResult
} from "@prisma/client";
import { AUTH_CONFIG, AuthConfig } from "../auth/auth.config";
import { normalizeEmail, normalizeEmailOrNull } from "../auth/email-normalizer";
import {
  IDENTITY_PROVIDER,
  IdentityProvider,
  ProviderIdentityConflictError,
  ProviderUserNotFoundError
} from "../auth/identity-provider";
import { PrismaService } from "../common/prisma.service";
import { userAuditSnapshot, writeSecurityAudit } from "../security-audit/security-audit.types";
import { InviteUserDto } from "./dto/invite-user.dto";
import { ReconcileInvitationAction } from "./dto/reconcile-invitation.dto";
import { UpdateUserDto } from "./dto/update-user.dto";
import { userLifecycleError } from "./user-lifecycle.errors";
import {
  canRestartCancelledInvitation,
  canTransitionInvitation,
  lockInvitationState
} from "./invite-state-machine";

const INVITATION_REQUEST_IN_PROGRESS = "INVITATION_REQUEST_IN_PROGRESS";
const INVITATION_RETRY_IN_PROGRESS = "INVITATION_RETRY_IN_PROGRESS";
const INVITATION_PROVIDER_UNAVAILABLE = "INVITATION_PROVIDER_UNAVAILABLE";
const INVITATION_PROVIDER_COMPENSATION_REQUIRED =
  "INVITATION_PROVIDER_COMPENSATION_REQUIRED";
const INVITATION_PROVIDER_SUBJECT_CONFLICT = "INVITATION_PROVIDER_SUBJECT_CONFLICT";
const INVITATION_IN_PROGRESS_TTL_MS = 2 * 60_000;

const USER_RECORD_SELECT = {
  id: true,
  email: true,
  name: true,
  role: true,
  isActive: true,
  inviteStatus: true,
  lastLoginAt: true,
  invitedAt: true,
  createdAt: true,
  updatedAt: true,
  normalizedEmail: true,
  authUserId: true,
  invitationRequestId: true,
  invitationErrorCode: true
} satisfies Prisma.AppUserSelect;

type UserRecord = Prisma.AppUserGetPayload<{ select: typeof USER_RECORD_SELECT }>;
type ReconciliationAction = "RETRY_INVITATION" | "CANCEL";
type UserSummary = Pick<UserRecord,
  "id" | "email" | "name" | "role" | "isActive" | "inviteStatus" |
  "lastLoginAt" | "invitedAt" | "createdAt" | "updatedAt"
> & { reconciliationActions: ReconciliationAction[] };

type InvitationStart = { user: UserRecord; shouldSend: boolean };

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(IDENTITY_PROVIDER) private readonly provider: IdentityProvider,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig
  ) {}

  async list() {
    return {
      items: (await this.prisma.appUser.findMany({
        select: USER_RECORD_SELECT,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }]
      })).map(toSummary)
    };
  }

  async invite(body: InviteUserDto, actorId: string, suppliedRequestId?: string) {
    const requestId = suppliedRequestId?.trim() || randomUUID();
    if (!isUuid(requestId)) throw userLifecycleError("IDEMPOTENCY_KEY_INVALID");
    let normalizedEmail: string;
    try {
      normalizedEmail = normalizeEmail(body.email);
    } catch {
      throw userLifecycleError("USER_EMAIL_INVALID");
    }
    const name = body.name.trim();

    const existingRequest = await this.prisma.appUser.findUnique({
      where: { invitationRequestId: requestId },
      select: USER_RECORD_SELECT
    });
    if (existingRequest) {
      if (
        existingRequest.normalizedEmail !== normalizedEmail ||
        existingRequest.name !== name ||
        existingRequest.role !== body.role
      ) throw userLifecycleError("IDEMPOTENCY_KEY_CONFLICT");
      return toSummary(existingRequest);
    }

    let start: InvitationStart;
    try {
      start = await this.beginInvitation(
        normalizedEmail,
        name,
        body.role,
        actorId,
        requestId
      );
    } catch (error) {
      if (isUniqueViolation(error, "invitation_request_id")) {
        const raced = await this.prisma.appUser.findUnique({
          where: { invitationRequestId: requestId },
          select: USER_RECORD_SELECT
        });
        if (
          raced && raced.normalizedEmail === normalizedEmail &&
          raced.name === name && raced.role === body.role
        ) return toSummary(raced);
        throw userLifecycleError("IDEMPOTENCY_KEY_CONFLICT");
      }
      if (isUniqueViolation(error, "email") || isUniqueViolation(error, "normalized_email")) {
        throw userLifecycleError("USER_EMAIL_EXISTS");
      }
      throw error;
    }
    if (!start.shouldSend) return toSummary(start.user);
    const pending = start.user;

    let providerUser;
    try {
      providerUser = await this.provider.inviteUserByEmail(
        normalizedEmail,
        this.inviteRedirectUrl(),
        requestId
      );
      if (
        normalizeEmailOrNull(providerUser.email) !== normalizedEmail ||
        providerUser.invitationRequestId !== requestId
      ) throw new ProviderIdentityConflictError();
    } catch (error) {
      await this.markInvitationFailure(
        pending.id,
        actorId,
        requestId,
        error instanceof ProviderIdentityConflictError
          ? "INVITATION_PROVIDER_IDENTITY_MISMATCH"
          : "INVITATION_PROVIDER_UNAVAILABLE"
      );
      throw userLifecycleError("INVITATION_PROVIDER_UNAVAILABLE");
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        await lockInvitationState(tx, pending.id);
        const current = await tx.appUser.findUnique({ where: { id: pending.id } });
        if (
          !current || current.inviteStatus !== InviteStatus.PENDING_PROVIDER ||
          current.invitationRequestId !== requestId ||
          current.invitationErrorCode !== INVITATION_REQUEST_IN_PROGRESS
        ) {
          throw userLifecycleError("INVALID_USER_TRANSITION");
        }
        const conflictingSubject = await tx.appUser.findUnique({
          where: { authUserId: providerUser.id },
          select: { id: true }
        });
        if (conflictingSubject && conflictingSubject.id !== current.id) {
          throw userLifecycleError("INVALID_USER_TRANSITION");
        }
        assertTransition(current.inviteStatus, InviteStatus.INVITED);
        const invitedAt = new Date();
        const updated = await tx.appUser.update({
          where: { id: pending.id },
          data: {
            authUserId: providerUser.id,
            inviteStatus: InviteStatus.INVITED,
            invitedAt,
            invitationErrorCode: null,
            authzVersion: { increment: 1 }
          },
          select: USER_RECORD_SELECT
        });
        await writeSecurityAudit(tx, {
          actorUserId: actorId,
          actorType: SecurityAuditActorType.USER,
          action: "USER_INVITATION_PROVIDER_SUCCEEDED",
          targetType: "APP_USER",
          targetId: updated.id,
          result: SecurityAuditResult.PROVIDER_SUCCEEDED,
          afterJson: { providerSubjectVerified: true },
          requestId
        });
        await writeSecurityAudit(tx, {
          actorUserId: actorId,
          actorType: SecurityAuditActorType.USER,
          action: "USER_INVITATION_COMPLETED",
          targetType: "APP_USER",
          targetId: updated.id,
          result: SecurityAuditResult.SUCCESS,
          beforeJson: userAuditSnapshot(current),
          afterJson: userAuditSnapshot(updated),
          requestId
        });
        return toSummary(updated);
      });
    } catch (error) {
      await this.markProviderSucceededLocalFailure(
        pending.id,
        actorId,
        requestId,
        providerUser.id
      ).catch(() => undefined);
      await this.compensateCancelledProviderIdentity(
        pending.id,
        actorId,
        requestId,
        normalizedEmail,
        providerUser.id
      ).catch(() => undefined);
      throw userLifecycleError("INVITATION_LOCAL_COMMIT_FAILED");
    }
  }

  private async beginInvitation(
    normalizedEmail: string,
    name: string,
    role: AppRole,
    actorId: string,
    requestId: string
  ): Promise<InvitationStart> {
    const emailOwner = await this.prisma.appUser.findUnique({
      where: { normalizedEmail },
      select: USER_RECORD_SELECT
    });
    if (!emailOwner) {
      const pendingUserId = randomUUID();
      return this.prisma.$transaction(async (tx) => {
        await lockInvitationState(tx, pendingUserId);
        const created = await tx.appUser.create({
          data: {
            id: pendingUserId,
            email: normalizedEmail,
            normalizedEmail,
            name,
            role,
            isActive: true,
            inviteStatus: InviteStatus.PENDING_PROVIDER,
            invitationRequestId: requestId,
            invitedBy: actorId,
            invitationErrorCode: INVITATION_REQUEST_IN_PROGRESS
          },
          select: USER_RECORD_SELECT
        });
        await writeSecurityAudit(tx, {
          actorUserId: actorId,
          actorType: SecurityAuditActorType.USER,
          action: "USER_INVITATION_REQUESTED",
          targetType: "APP_USER",
          targetId: created.id,
          result: SecurityAuditResult.REQUESTED,
          afterJson: userAuditSnapshot(created),
          requestId
        });
        return { user: created, shouldSend: true };
      });
    }

    return this.prisma.$transaction(async (tx) => {
      await lockInvitationState(tx, emailOwner.id);
      const locked = await tx.appUser.findUnique({
        where: { id: emailOwner.id },
        select: USER_RECORD_SELECT
      });
      if (!locked) throw userLifecycleError("USER_NOT_FOUND");
      if (locked.invitationRequestId === requestId) {
        if (
          locked.normalizedEmail !== normalizedEmail ||
          locked.name !== name ||
          locked.role !== role
        ) throw userLifecycleError("IDEMPOTENCY_KEY_CONFLICT");
        return { user: locked, shouldSend: false };
      }
      // A cancelled row owns the normalized-email key. It may be reused only
      // after provider compensation was proven complete and the subject was
      // detached locally; no hard delete or email-only provider lookup occurs.
      if (!canRestartCancelledInvitation(locked)) throw userLifecycleError("USER_EMAIL_EXISTS");

      const restarted = await tx.appUser.update({
        where: { id: locked.id },
        data: {
          email: normalizedEmail,
          name,
          role,
          isActive: true,
          inviteStatus: InviteStatus.PENDING_PROVIDER,
          invitationRequestId: requestId,
          invitedBy: actorId,
          invitedAt: null,
          deactivatedAt: null,
          invitationErrorCode: INVITATION_REQUEST_IN_PROGRESS,
          authzVersion: { increment: 1 }
        },
        select: USER_RECORD_SELECT
      });
      await writeSecurityAudit(tx, {
        actorUserId: actorId,
        actorType: SecurityAuditActorType.USER,
        action: "USER_INVITATION_RESTARTED",
        targetType: "APP_USER",
        targetId: restarted.id,
        result: SecurityAuditResult.REQUESTED,
        beforeJson: userAuditSnapshot(locked),
        afterJson: userAuditSnapshot(restarted),
        requestId
      });
      return { user: restarted, shouldSend: true };
    });
  }

  async update(id: string, body: UpdateUserDto, actorId: string) {
    if (body.name === undefined && body.role === undefined && body.isActive === undefined) {
      throw userLifecycleError("USER_UPDATE_EMPTY");
    }
    if (body.name !== undefined) body.name = body.name.trim();

    return this.prisma.$transaction(async (tx) => {
      await lockSuperAdminInvariant(tx);
      const current = await tx.appUser.findUnique({ where: { id } });
      if (!current) throw userLifecycleError("USER_NOT_FOUND");
      const nextRole = body.role ?? current.role;
      const nextActive = body.isActive ?? current.isActive;

      if (id === actorId && (!nextActive || nextRole !== current.role)) {
        throw userLifecycleError("SELF_LOCKOUT");
      }
      if (body.isActive === true && current.inviteStatus !== InviteStatus.ACTIVE) {
        throw userLifecycleError("INVALID_USER_TRANSITION");
      }
      if (
        current.role === AppRole.SUPER_ADMIN && current.isActive &&
        current.inviteStatus === InviteStatus.ACTIVE &&
        (nextRole !== AppRole.SUPER_ADMIN || !nextActive)
      ) {
        const activeSuperAdmins = await tx.appUser.count({
          where: {
            role: AppRole.SUPER_ADMIN,
            isActive: true,
            inviteStatus: InviteStatus.ACTIVE
          }
        });
        if (activeSuperAdmins <= 1) throw userLifecycleError("LAST_ACTIVE_SUPER_ADMIN");
      }

      const authorizationChanged = nextRole !== current.role || nextActive !== current.isActive;
      if (authorizationChanged) {
        await tx.appAuthSession.updateMany({
          where: { appUserId: id, revokedAt: null },
          data: { revokedAt: new Date() }
        });
      }
      const updated = await tx.appUser.update({
        where: { id },
        data: {
          name: body.name,
          role: body.role,
          isActive: body.isActive,
          deactivatedAt: body.isActive === false
            ? new Date()
            : body.isActive === true ? null : undefined,
          authzVersion: authorizationChanged ? { increment: 1 } : undefined
        },
        select: USER_RECORD_SELECT
      });
      await writeSecurityAudit(tx, {
        actorUserId: actorId,
        actorType: SecurityAuditActorType.USER,
        action: authorizationChanged ? "USER_AUTHORIZATION_CHANGED" : "USER_PROFILE_CHANGED",
        targetType: "APP_USER",
        targetId: id,
        result: SecurityAuditResult.SUCCESS,
        beforeJson: userAuditSnapshot(current),
        afterJson: userAuditSnapshot(updated)
      });
      if (authorizationChanged) {
        await writeSecurityAudit(tx, {
          actorUserId: actorId,
          actorType: SecurityAuditActorType.USER,
          action: "USER_SESSIONS_REVOKED",
          targetType: "APP_USER",
          targetId: id,
          result: SecurityAuditResult.SUCCESS,
          afterJson: { localSessionsRevoked: true, providerRevocation: "NOT_AVAILABLE_WITHOUT_SESSION_TOKEN" }
        });
      }
      return toSummary(updated);
    });
  }

  async reconcile(id: string, action: ReconcileInvitationAction, actorId: string) {
    const current = await this.prisma.appUser.findUnique({
      where: { id },
      select: USER_RECORD_SELECT
    });
    if (!current) throw userLifecycleError("USER_NOT_FOUND");

    if (action === "CANCEL") {
      if (
        current.inviteStatus === InviteStatus.CANCELLED &&
        current.invitationErrorCode === INVITATION_PROVIDER_COMPENSATION_REQUIRED
      ) return this.compensateCancelledInvitation(id, actorId);
      if (
        current.inviteStatus === InviteStatus.CANCELLED &&
        current.invitationErrorCode === null
      ) return toSummary(current);

      const cancelled = await this.prisma.$transaction(async (tx) => {
        await lockInvitationState(tx, id);
        const locked = await tx.appUser.findUnique({
          where: { id },
          select: USER_RECORD_SELECT
        });
        if (
          locked?.inviteStatus === InviteStatus.CANCELLED &&
          locked.invitationErrorCode === INVITATION_PROVIDER_COMPENSATION_REQUIRED
        ) return locked;
        if (locked?.inviteStatus === InviteStatus.CANCELLED && locked.invitationErrorCode === null) {
          return locked;
        }
        if (
          !locked || !isCancellableInvitationStatus(locked.inviteStatus) ||
          !locked.invitationRequestId || !locked.normalizedEmail ||
          (isInvitationInProgress(locked.invitationErrorCode) &&
            isFreshInvitationClaim(locked.updatedAt))
        ) {
          throw userLifecycleError("INVITATION_NOT_RECONCILABLE");
        }
        assertTransition(locked.inviteStatus, InviteStatus.CANCELLED);
        await tx.appAuthSession.updateMany({
          where: { appUserId: id, revokedAt: null },
          data: { revokedAt: new Date() }
        });
        const cancelled = await tx.appUser.update({
          where: { id },
          data: {
            inviteStatus: InviteStatus.CANCELLED,
            isActive: false,
            deactivatedAt: new Date(),
            authzVersion: { increment: 1 },
            invitationErrorCode: locked.authUserId
              ? INVITATION_PROVIDER_COMPENSATION_REQUIRED
              : null
          },
          select: USER_RECORD_SELECT
        });
        await writeSecurityAudit(tx, {
          actorUserId: actorId,
          actorType: SecurityAuditActorType.USER,
          action: "USER_INVITATION_CANCELLED",
          targetType: "APP_USER",
          targetId: id,
          result: SecurityAuditResult.SUCCESS,
          beforeJson: userAuditSnapshot(locked),
          afterJson: userAuditSnapshot(cancelled),
          requestId: locked.invitationRequestId
        });
        return cancelled;
      });
      if (cancelled.invitationErrorCode === INVITATION_PROVIDER_COMPENSATION_REQUIRED) {
        return this.compensateCancelledInvitation(id, actorId);
      }
      return toSummary(cancelled);
    }

    if (
      current.inviteStatus !== InviteStatus.RECONCILE_REQUIRED ||
      current.invitationErrorCode !== INVITATION_PROVIDER_UNAVAILABLE ||
      current.authUserId || !current.invitationRequestId || !current.normalizedEmail
    ) throw userLifecycleError("INVITATION_NOT_RECONCILABLE");
    const requestId = current.invitationRequestId;

    const retryClaim = await this.prisma.$transaction(async (tx) => {
      await lockInvitationState(tx, id);
      const locked = await tx.appUser.findUnique({ where: { id } });
      // Supabase's supported invite API does not promise that an existing
      // identity can be safely re-invited. Retry only a row with no subject.
      if (
        !locked || locked.authUserId ||
        locked.inviteStatus !== InviteStatus.RECONCILE_REQUIRED ||
        !isRetryableInvitationFailure(locked.inviteStatus, locked.invitationErrorCode)
      ) throw userLifecycleError("INVITATION_NOT_RECONCILABLE");
      assertTransition(locked.inviteStatus, InviteStatus.PENDING_PROVIDER);
      const claimed = await tx.appUser.update({
        where: { id },
        data: {
          inviteStatus: InviteStatus.PENDING_PROVIDER,
          invitationErrorCode: INVITATION_RETRY_IN_PROGRESS
        }
      });
      await writeSecurityAudit(tx, {
        actorUserId: actorId,
        actorType: SecurityAuditActorType.USER,
        action: "USER_INVITATION_RETRY_REQUESTED",
        targetType: "APP_USER",
        targetId: id,
        result: SecurityAuditResult.REQUESTED,
        beforeJson: userAuditSnapshot(locked),
        afterJson: userAuditSnapshot(claimed),
        requestId
      });
      return claimed;
    });
    let providerUser;
    try {
      providerUser = await this.provider.inviteUserByEmail(
        retryClaim.normalizedEmail!,
        this.inviteRedirectUrl(),
        requestId
      );
    } catch {
      await this.markInvitationFailure(id, actorId, requestId, "INVITATION_PROVIDER_UNAVAILABLE");
      throw userLifecycleError("INVITATION_PROVIDER_UNAVAILABLE");
    }
    if (
      normalizeEmailOrNull(providerUser.email) !== retryClaim.normalizedEmail ||
      providerUser.invitationRequestId !== requestId
    ) {
      await this.markInvitationFailure(id, actorId, requestId, "INVITATION_PROVIDER_IDENTITY_MISMATCH");
      throw userLifecycleError("INVITATION_PROVIDER_UNAVAILABLE");
    }
    try {
      return await this.prisma.$transaction(async (tx) => {
      await lockInvitationState(tx, id);
      const before = await tx.appUser.findUnique({ where: { id } });
      if (
        !before || before.inviteStatus !== InviteStatus.PENDING_PROVIDER ||
        before.invitationRequestId !== requestId ||
        before.invitationErrorCode !== INVITATION_RETRY_IN_PROGRESS
      ) {
        throw userLifecycleError("INVITATION_NOT_RECONCILABLE");
      }
      const conflictingSubject = await tx.appUser.findUnique({
        where: { authUserId: providerUser.id },
        select: { id: true }
      });
      if (conflictingSubject && conflictingSubject.id !== before.id) {
        throw userLifecycleError("INVALID_USER_TRANSITION");
      }
      assertTransition(before.inviteStatus, InviteStatus.INVITED);
      const updated = await tx.appUser.update({
        where: { id },
        data: {
          authUserId: providerUser.id,
          inviteStatus: InviteStatus.INVITED,
          invitedAt: new Date(),
          invitationErrorCode: null,
          isActive: true,
          deactivatedAt: null,
          authzVersion: { increment: 1 }
        },
        select: USER_RECORD_SELECT
      });
      await writeSecurityAudit(tx, {
        actorUserId: actorId,
        actorType: SecurityAuditActorType.USER,
        action: "USER_INVITATION_PROVIDER_SUCCEEDED",
        targetType: "APP_USER",
        targetId: id,
        result: SecurityAuditResult.PROVIDER_SUCCEEDED,
        afterJson: { providerSubjectVerified: true },
        requestId
      });
      await writeSecurityAudit(tx, {
        actorUserId: actorId,
        actorType: SecurityAuditActorType.USER,
        action: "USER_INVITATION_RETRIED",
        targetType: "APP_USER",
        targetId: id,
        result: SecurityAuditResult.SUCCESS,
        beforeJson: userAuditSnapshot(before),
        afterJson: userAuditSnapshot(updated),
        requestId
      });
        return toSummary(updated);
      });
    } catch {
      await this.markProviderSucceededLocalFailure(
        id,
        actorId,
        requestId,
        providerUser.id
      ).catch(() => undefined);
      await this.compensateCancelledProviderIdentity(
        id,
        actorId,
        requestId,
        retryClaim.normalizedEmail!,
        providerUser.id
      ).catch(() => undefined);
      throw userLifecycleError("INVITATION_LOCAL_COMMIT_FAILED");
    }
  }

  private async markInvitationFailure(
    id: string,
    actorId: string,
    requestId: string,
    errorCode: string
  ) {
    await this.prisma.$transaction(async (tx) => {
      await lockInvitationState(tx, id);
      const before = await tx.appUser.findUnique({ where: { id } });
      if (
        !before || before.inviteStatus !== InviteStatus.PENDING_PROVIDER ||
        before.invitationRequestId !== requestId ||
        (before.invitationErrorCode !== "INVITATION_REQUEST_IN_PROGRESS" &&
          before.invitationErrorCode !== "INVITATION_RETRY_IN_PROGRESS")
      ) return;
      assertTransition(before.inviteStatus, InviteStatus.RECONCILE_REQUIRED);
      const updated = await tx.appUser.update({
        where: { id },
        data: {
          inviteStatus: InviteStatus.RECONCILE_REQUIRED,
          invitationErrorCode: errorCode,
          authzVersion: { increment: 1 }
        }
      });
      await writeSecurityAudit(tx, {
        actorUserId: actorId,
        actorType: SecurityAuditActorType.USER,
        action: "USER_INVITATION_FAILED",
        targetType: "APP_USER",
        targetId: id,
        result: SecurityAuditResult.FAILURE,
        beforeJson: userAuditSnapshot(before),
        afterJson: {
          ...userAuditSnapshot(updated),
          errorCode
        },
        requestId
      });
    });
  }

  private async markProviderSucceededLocalFailure(
    id: string,
    actorId: string,
    requestId: string,
    authUserId: string
  ) {
    await this.prisma.$transaction(async (tx) => {
      await lockInvitationState(tx, id);
      const before = await tx.appUser.findUnique({ where: { id } });
      // If the final transaction committed but its result was lost, never
      // downgrade INVITED to a reconciliation state.
      if (
        !before || before.inviteStatus !== InviteStatus.PENDING_PROVIDER ||
        before.invitationRequestId !== requestId
      ) return;
      assertTransition(before.inviteStatus, InviteStatus.RECONCILE_REQUIRED);
      const subjectOwner = await tx.appUser.findUnique({
        where: { authUserId },
        select: { id: true }
      });
      const subjectConflict = Boolean(subjectOwner && subjectOwner.id !== before.id);
      const updated = await tx.appUser.update({
        where: { id },
        data: {
          ...(subjectConflict ? {} : { authUserId }),
          inviteStatus: InviteStatus.RECONCILE_REQUIRED,
          invitationErrorCode: subjectConflict
            ? INVITATION_PROVIDER_SUBJECT_CONFLICT
            : "INVITATION_LOCAL_COMMIT_FAILED",
          authzVersion: { increment: 1 }
        }
      });
      await writeSecurityAudit(tx, {
        actorUserId: actorId,
        actorType: SecurityAuditActorType.USER,
        action: "USER_INVITATION_PROVIDER_SUCCEEDED",
        targetType: "APP_USER",
        targetId: id,
        result: SecurityAuditResult.PROVIDER_SUCCEEDED,
        beforeJson: userAuditSnapshot(before),
        afterJson: {
          ...userAuditSnapshot(updated),
          providerSubjectConflict: subjectConflict
        },
        requestId
      });
    });
  }

  private async compensateCancelledProviderIdentity(
    id: string,
    actorId: string,
    requestId: string,
    normalizedEmail: string,
    providerUserId: string
  ) {
    const attached = await this.prisma.$transaction(async (tx) => {
      await lockInvitationState(tx, id);
      const cancelled = await tx.appUser.findUnique({
        where: { id },
        select: USER_RECORD_SELECT
      });
      if (
        !cancelled || cancelled.inviteStatus !== InviteStatus.CANCELLED ||
        cancelled.invitationRequestId !== requestId ||
        cancelled.normalizedEmail !== normalizedEmail
      ) return false;
      if (cancelled.authUserId && cancelled.authUserId !== providerUserId) {
        await writeSecurityAudit(tx, {
          actorUserId: actorId,
          actorType: SecurityAuditActorType.USER,
          action: "USER_INVITATION_CANCEL_RACE_COMPENSATED",
          targetType: "APP_USER",
          targetId: id,
          result: SecurityAuditResult.PARTIAL,
          afterJson: { providerIdentityCompensation: "SUBJECT_MISMATCH" },
          requestId
        });
        return false;
      }
      const subjectOwner = await tx.appUser.findUnique({
        where: { authUserId: providerUserId },
        select: { id: true }
      });
      if (subjectOwner && subjectOwner.id !== cancelled.id) {
        await writeSecurityAudit(tx, {
          actorUserId: actorId,
          actorType: SecurityAuditActorType.USER,
          action: "USER_INVITATION_CANCEL_RACE_COMPENSATED",
          targetType: "APP_USER",
          targetId: id,
          result: SecurityAuditResult.PARTIAL,
          afterJson: { providerIdentityCompensation: "SUBJECT_OWNERSHIP_CONFLICT" },
          requestId
        });
        return false;
      }
      await tx.appUser.update({
        where: { id },
        data: {
          authUserId: providerUserId,
          invitationErrorCode: INVITATION_PROVIDER_COMPENSATION_REQUIRED
        }
      });
      return true;
    });
    if (attached) await this.compensateCancelledInvitation(id, actorId);
  }

  private async compensateCancelledInvitation(id: string, actorId: string): Promise<UserSummary> {
    const pending = await this.prisma.appUser.findUnique({
      where: { id },
      select: USER_RECORD_SELECT
    });
    if (
      !pending || pending.inviteStatus !== InviteStatus.CANCELLED ||
      pending.invitationErrorCode !== INVITATION_PROVIDER_COMPENSATION_REQUIRED ||
      !pending.authUserId || !pending.invitationRequestId || !pending.normalizedEmail
    ) {
      if (pending?.inviteStatus === InviteStatus.CANCELLED) return toSummary(pending);
      throw userLifecycleError("INVITATION_NOT_RECONCILABLE");
    }

    let compensation: "DELETED" | "ALREADY_ABSENT" | "OWNERSHIP_MISMATCH" | "RETRY_REQUIRED";
    try {
      const providerUser = await this.provider.getUserById(pending.authUserId);
      if (
        providerUser.id !== pending.authUserId ||
        normalizeEmailOrNull(providerUser.email) !== pending.normalizedEmail ||
        providerUser.invitationRequestId !== pending.invitationRequestId
      ) {
        compensation = "OWNERSHIP_MISMATCH";
      } else {
        await this.provider.deleteInvitationUser(providerUser.id);
        compensation = "DELETED";
      }
    } catch (error) {
      compensation = error instanceof ProviderUserNotFoundError
        ? "ALREADY_ABSENT"
        : "RETRY_REQUIRED";
    }

    return this.prisma.$transaction(async (tx) => {
      await lockInvitationState(tx, id);
      const locked = await tx.appUser.findUnique({
        where: { id },
        select: USER_RECORD_SELECT
      });
      if (!locked) throw userLifecycleError("USER_NOT_FOUND");
      if (
        locked.inviteStatus !== InviteStatus.CANCELLED ||
        locked.authUserId !== pending.authUserId ||
        locked.invitationRequestId !== pending.invitationRequestId
      ) return toSummary(locked);
      const succeeded = compensation === "DELETED" || compensation === "ALREADY_ABSENT";
      const updated = await tx.appUser.update({
        where: { id },
        data: succeeded ? {
          authUserId: null,
          invitationErrorCode: null
        } : {
          invitationErrorCode: INVITATION_PROVIDER_COMPENSATION_REQUIRED
        },
        select: USER_RECORD_SELECT
      });
      await writeSecurityAudit(tx, {
        actorUserId: actorId,
        actorType: SecurityAuditActorType.USER,
        action: "USER_INVITATION_PROVIDER_COMPENSATION",
        targetType: "APP_USER",
        targetId: id,
        result: succeeded ? SecurityAuditResult.SUCCESS : SecurityAuditResult.PARTIAL,
        beforeJson: userAuditSnapshot(locked),
        afterJson: {
          ...userAuditSnapshot(updated),
          providerIdentityCompensation: compensation
        },
        requestId: locked.invitationRequestId
      });
      return toSummary(updated);
    });
  }

  private inviteRedirectUrl() {
    const origin = [...this.config.allowedOrigins][0];
    return new URL("/invite/accept", origin).toString();
  }
}

async function lockSuperAdminInvariant(tx: Prisma.TransactionClient) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('app-user-super-admin-invariant', 0))`;
}

function toSummary(user: UserRecord): UserSummary {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    isActive: user.isActive,
    inviteStatus: user.inviteStatus,
    lastLoginAt: user.lastLoginAt,
    invitedAt: user.invitedAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    reconciliationActions: reconciliationActions(user)
  };
}

function reconciliationActions(user: UserRecord): ReconciliationAction[] {
  if (user.inviteStatus === InviteStatus.CANCELLED) {
    return user.invitationErrorCode === INVITATION_PROVIDER_COMPENSATION_REQUIRED
      ? ["CANCEL"]
      : [];
  }
  if (
    user.inviteStatus === InviteStatus.INVITED ||
    user.inviteStatus === InviteStatus.VERIFIED_PENDING_PASSWORD
  ) return ["CANCEL"];
  if (user.inviteStatus === InviteStatus.RECONCILE_REQUIRED) {
    return !user.authUserId && user.invitationErrorCode === INVITATION_PROVIDER_UNAVAILABLE
      ? ["RETRY_INVITATION", "CANCEL"]
      : ["CANCEL"];
  }
  if (user.inviteStatus === InviteStatus.PENDING_PROVIDER) {
    return isInvitationInProgress(user.invitationErrorCode) && isFreshInvitationClaim(user.updatedAt)
      ? []
      : ["CANCEL"];
  }
  return [];
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isUniqueViolation(error: unknown, field: string) {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") return false;
  const target = error.meta?.target;
  return Array.isArray(target)
    ? target.some((entry) => String(entry).includes(field))
    : String(target ?? "").includes(field);
}

function isInvitationInProgress(code: string | null) {
  return code === INVITATION_REQUEST_IN_PROGRESS || code === INVITATION_RETRY_IN_PROGRESS;
}

function isRetryableInvitationFailure(status: InviteStatus, code: string | null) {
  return status === InviteStatus.RECONCILE_REQUIRED && code === INVITATION_PROVIDER_UNAVAILABLE;
}

function isCancellableInvitationStatus(status: InviteStatus) {
  return status === InviteStatus.PENDING_PROVIDER || status === InviteStatus.INVITED ||
    status === InviteStatus.VERIFIED_PENDING_PASSWORD ||
    status === InviteStatus.RECONCILE_REQUIRED;
}

function isFreshInvitationClaim(updatedAt: Date) {
  return updatedAt.getTime() > Date.now() - INVITATION_IN_PROGRESS_TTL_MS;
}

function assertTransition(from: InviteStatus, to: InviteStatus) {
  if (!canTransitionInvitation(from, to)) throw userLifecycleError("INVALID_USER_TRANSITION");
}
