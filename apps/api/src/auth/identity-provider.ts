import { ProviderSession, ProviderUser } from "./auth.types";

export const IDENTITY_PROVIDER = Symbol("IDENTITY_PROVIDER");

export interface IdentityProvider {
  signInWithPassword(email: string, password: string): Promise<ProviderSession>;
  refreshSession(refreshToken: string): Promise<ProviderSession>;
  revokeSession(accessToken: string): Promise<void>;
  getUserById(authUserId: string): Promise<ProviderUser>;
}

export class ProviderInvalidCredentialsError extends Error {}
export class ProviderInvalidRefreshTokenError extends Error {}
export class ProviderUnavailableError extends Error {}
