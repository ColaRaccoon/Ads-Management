import { HttpException, HttpStatus } from "@nestjs/common";

export type UserLifecycleErrorCode =
  | "USER_NOT_FOUND"
  | "USER_EMAIL_EXISTS"
  | "USER_EMAIL_INVALID"
  | "IDEMPOTENCY_KEY_INVALID"
  | "IDEMPOTENCY_KEY_CONFLICT"
  | "USER_UPDATE_EMPTY"
  | "SELF_LOCKOUT"
  | "LAST_ACTIVE_SUPER_ADMIN"
  | "INVALID_USER_TRANSITION"
  | "INVITATION_NOT_RECONCILABLE"
  | "INVITATION_PROVIDER_UNAVAILABLE"
  | "INVITATION_LOCAL_COMMIT_FAILED";

const contract: Record<UserLifecycleErrorCode, { status: HttpStatus; message: string }> = {
  USER_NOT_FOUND: { status: HttpStatus.NOT_FOUND, message: "The user was not found." },
  USER_EMAIL_EXISTS: { status: HttpStatus.CONFLICT, message: "A user with that email already exists." },
  USER_EMAIL_INVALID: { status: HttpStatus.BAD_REQUEST, message: "The email address is invalid." },
  IDEMPOTENCY_KEY_INVALID: { status: HttpStatus.BAD_REQUEST, message: "Idempotency-Key must be a UUID." },
  IDEMPOTENCY_KEY_CONFLICT: { status: HttpStatus.CONFLICT, message: "The idempotency key was used for another request." },
  USER_UPDATE_EMPTY: { status: HttpStatus.BAD_REQUEST, message: "At least one user field must be provided." },
  SELF_LOCKOUT: { status: HttpStatus.CONFLICT, message: "You cannot remove your own access." },
  LAST_ACTIVE_SUPER_ADMIN: { status: HttpStatus.CONFLICT, message: "The last active super administrator must be preserved." },
  INVALID_USER_TRANSITION: { status: HttpStatus.CONFLICT, message: "The requested user state transition is not allowed." },
  INVITATION_NOT_RECONCILABLE: { status: HttpStatus.CONFLICT, message: "The invitation cannot be reconciled with that action." },
  INVITATION_PROVIDER_UNAVAILABLE: { status: HttpStatus.SERVICE_UNAVAILABLE, message: "The invitation provider is temporarily unavailable." },
  INVITATION_LOCAL_COMMIT_FAILED: { status: HttpStatus.INTERNAL_SERVER_ERROR, message: "The invitation could not be committed locally." }
};

export class UserLifecycleException extends HttpException {
  constructor(readonly code: UserLifecycleErrorCode) {
    const value = contract[code];
    super({ code, message: value.message, details: null }, value.status);
    this.name = code;
  }
}

export const userLifecycleError = (code: UserLifecycleErrorCode) => new UserLifecycleException(code);
