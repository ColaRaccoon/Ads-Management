import { InviteStatus, Prisma } from "@prisma/client";

const TRANSITIONS: Readonly<Record<InviteStatus, ReadonlySet<InviteStatus>>> = {
  [InviteStatus.PENDING_PROVIDER]: new Set([
    InviteStatus.INVITED,
    InviteStatus.RECONCILE_REQUIRED,
    InviteStatus.CANCELLED
  ]),
  [InviteStatus.INVITED]: new Set([
    InviteStatus.VERIFIED_PENDING_PASSWORD,
    InviteStatus.RECONCILE_REQUIRED,
    InviteStatus.CANCELLED
  ]),
  [InviteStatus.VERIFIED_PENDING_PASSWORD]: new Set([
    InviteStatus.ACTIVE,
    InviteStatus.RECONCILE_REQUIRED,
    InviteStatus.CANCELLED
  ]),
  [InviteStatus.RECONCILE_REQUIRED]: new Set([
    InviteStatus.PENDING_PROVIDER,
    InviteStatus.CANCELLED
  ]),
  [InviteStatus.ACTIVE]: new Set(),
  [InviteStatus.CANCELLED]: new Set()
};

export function canTransitionInvitation(from: InviteStatus, to: InviteStatus) {
  return from === to || TRANSITIONS[from].has(to);
}

export function canRestartCancelledInvitation(user: {
  inviteStatus: InviteStatus;
  authUserId: string | null;
  invitationErrorCode: string | null;
}) {
  return user.inviteStatus === InviteStatus.CANCELLED &&
    user.authUserId === null && user.invitationErrorCode === null;
}

/**
 * Every invitation state writer must take this exact per-AppUser lock before it
 * re-reads and changes the row. The stable AppUser id deliberately remains the
 * lock key even while a provider subject is being attached or removed.
 */
export async function lockInvitationState(tx: Prisma.TransactionClient, appUserId: string) {
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`app-user-invitation:${appUserId}`}, 0)
    )
  `;
}
