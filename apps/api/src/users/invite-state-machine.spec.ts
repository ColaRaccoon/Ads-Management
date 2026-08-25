import { InviteStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { canRestartCancelledInvitation, canTransitionInvitation } from "./invite-state-machine";

describe("invitation state machine", () => {
  it("allows only the normal onboarding path", () => {
    expect(canTransitionInvitation(InviteStatus.PENDING_PROVIDER, InviteStatus.INVITED)).toBe(true);
    expect(canTransitionInvitation(InviteStatus.INVITED, InviteStatus.VERIFIED_PENDING_PASSWORD)).toBe(true);
    expect(canTransitionInvitation(InviteStatus.VERIFIED_PENDING_PASSWORD, InviteStatus.ACTIVE)).toBe(true);
  });

  it("keeps ACTIVE and CANCELLED terminal", () => {
    expect(canTransitionInvitation(InviteStatus.ACTIVE, InviteStatus.INVITED)).toBe(false);
    expect(canTransitionInvitation(InviteStatus.CANCELLED, InviteStatus.PENDING_PROVIDER)).toBe(false);
  });

  it("starts a new saga from CANCELLED only after provider compensation completed", () => {
    expect(canRestartCancelledInvitation({
      inviteStatus: InviteStatus.CANCELLED,
      authUserId: null,
      invitationErrorCode: null
    })).toBe(true);
    expect(canRestartCancelledInvitation({
      inviteStatus: InviteStatus.CANCELLED,
      authUserId: "11111111-1111-4111-8111-111111111111",
      invitationErrorCode: "INVITATION_PROVIDER_COMPENSATION_REQUIRED"
    })).toBe(false);
    expect(canRestartCancelledInvitation({
      inviteStatus: InviteStatus.INVITED,
      authUserId: null,
      invitationErrorCode: null
    })).toBe(false);
  });
});
