import { HttpException, HttpStatus } from "@nestjs/common";

export type InvitationErrorCode =
  | "INVITATION_INVALID_OR_EXPIRED"
  | "ACTIVE_SESSION_PRESENT"
  | "ONBOARDING_SESSION_REQUIRED"
  | "PASSWORD_POLICY_INVALID"
  | "PASSWORD_PROVIDER_UNAVAILABLE"
  | "PASSWORD_LOCAL_COMMIT_FAILED";

const values: Record<InvitationErrorCode, { status: HttpStatus; message: string }> = {
  INVITATION_INVALID_OR_EXPIRED: { status: HttpStatus.BAD_REQUEST, message: "The invitation is invalid or expired." },
  ACTIVE_SESSION_PRESENT: { status: HttpStatus.CONFLICT, message: "Sign out of the active account before accepting an invitation." },
  ONBOARDING_SESSION_REQUIRED: { status: HttpStatus.FORBIDDEN, message: "A valid onboarding session is required." },
  PASSWORD_POLICY_INVALID: { status: HttpStatus.UNPROCESSABLE_ENTITY, message: "The password does not satisfy the password policy." },
  PASSWORD_PROVIDER_UNAVAILABLE: { status: HttpStatus.SERVICE_UNAVAILABLE, message: "The authentication provider is temporarily unavailable." },
  PASSWORD_LOCAL_COMMIT_FAILED: { status: HttpStatus.INTERNAL_SERVER_ERROR, message: "The password was updated but activation could not be committed." }
};

export class InvitationHttpException extends HttpException {
  constructor(readonly code: InvitationErrorCode) {
    const value = values[code];
    super({ code, message: value.message, details: null }, value.status);
    this.name = code;
  }
}

export const invitationError = (code: InvitationErrorCode) => new InvitationHttpException(code);
