import { ProviderSession, ProviderUser } from "./auth.types";

export const IDENTITY_PROVIDER = Symbol("IDENTITY_PROVIDER");

export interface IdentityProvider {
  signInWithPassword(email: string, password: string): Promise<ProviderSession>;
  refreshSession(refreshToken: string): Promise<ProviderSession>;
  revokeSession(accessToken: string): Promise<void>;
  getUserById(authUserId: string): Promise<ProviderUser>;
  inviteUserByEmail(email: string, redirectTo: string, requestId: string): Promise<ProviderUser>;
  verifyInvitationToken(tokenHash: string, tokenType?: "invite" | "recovery"): Promise<ProviderSession>;
  updatePassword(accessToken: string, password: string): Promise<ProviderUser>;
  deleteInvitationUser(authUserId: string): Promise<void>;
}

export class ProviderInvalidCredentialsError extends Error {}
export class ProviderInvalidRefreshTokenError extends Error {}
export class ProviderUnavailableError extends Error {}
export class ProviderUserNotFoundError extends Error {}
export class ProviderInvalidInvitationError extends Error {}
export class ProviderIdentityConflictError extends Error {}
export class ProviderPasswordPolicyError extends Error {}
