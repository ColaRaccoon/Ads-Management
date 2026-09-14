import { Inject, Injectable } from "@nestjs/common";
import { AuthError, createClient, SupabaseClient } from "@supabase/supabase-js";
import { AUTH_CONFIG, AuthConfig } from "./auth.config";
import {
  IdentityProvider,
  ProviderInvalidCredentialsError,
  ProviderInvalidInvitationError,
  ProviderInvalidRefreshTokenError,
  ProviderPasswordPolicyError,
  ProviderUserNotFoundError,
  ProviderUnavailableError
} from "./identity-provider";
import { ProviderSession, ProviderUser } from "./auth.types";

const PROVIDER_TIMEOUT_MS = 10_000;

@Injectable()
export class SupabaseAuthAdapter implements IdentityProvider {
  constructor(@Inject(AUTH_CONFIG) private readonly config: AuthConfig) {}

  async signInWithPassword(email: string, password: string): Promise<ProviderSession> {
    const client = this.createPublicClient();
    let result: Awaited<ReturnType<typeof client.auth.signInWithPassword>>;
    try {
      result = await client.auth.signInWithPassword({ email, password });
    } catch {
      throw new ProviderUnavailableError();
    }
    const { data, error } = result;
    if (error) throw classifySignInError(error);
    if (!data.session || !data.user) throw new ProviderUnavailableError();
    return toProviderSession(data.session);
  }

  async refreshSession(refreshToken: string): Promise<ProviderSession> {
    const client = this.createPublicClient();
    let result: Awaited<ReturnType<typeof client.auth.refreshSession>>;
    try {
      result = await client.auth.refreshSession({ refresh_token: refreshToken });
    } catch {
      throw new ProviderUnavailableError();
    }
    const { data, error } = result;
    if (error) throw classifyRefreshError(error);
    if (!data.session || !data.user) throw new ProviderInvalidRefreshTokenError();
    return toProviderSession(data.session);
  }

  async revokeSession(accessToken: string): Promise<void> {
    let response: Response;
    try {
      response = await fetch(`${this.config.supabaseUrl}/auth/v1/logout?scope=local`, {
        method: "POST",
        headers: {
          apikey: this.config.supabasePublishableKey,
          authorization: `Bearer ${accessToken}`
        },
        signal: AbortSignal.timeout(10_000)
      });
    } catch {
      throw new ProviderUnavailableError();
    }
    if (!response.ok && response.status !== 401) throw new ProviderUnavailableError();
  }

  async getUserById(authUserId: string): Promise<ProviderUser> {
    const client = this.createAdminClient();
    let result: Awaited<ReturnType<typeof client.auth.admin.getUserById>>;
    try {
      result = await client.auth.admin.getUserById(authUserId);
    } catch {
      throw new ProviderUnavailableError();
    }
    const { data, error } = result;
    if (error) {
      if (error.status === 404) throw new ProviderUserNotFoundError();
      throw new ProviderUnavailableError();
    }
    if (!data.user) throw new ProviderUserNotFoundError();
    return toProviderUser(data.user);
  }

  async inviteUserByEmail(email: string, redirectTo: string, requestId: string) {
    const client = this.createAdminClient();
    let result: Awaited<ReturnType<typeof client.auth.admin.inviteUserByEmail>>;
    try {
      result = await client.auth.admin.inviteUserByEmail(email, {
        redirectTo,
        data: { invitation_request_id: requestId }
      });
    } catch {
      throw new ProviderUnavailableError();
    }
    if (result.error || !result.data.user) throw new ProviderUnavailableError();
    return toProviderUser(result.data.user);
  }

  async verifyInvitationToken(tokenHash: string, tokenType: "invite" | "recovery" = "invite"): Promise<ProviderSession> {
    const client = this.createPublicClient();
    let result: Awaited<ReturnType<typeof client.auth.verifyOtp>>;
    try {
      result = await client.auth.verifyOtp({ token_hash: tokenHash, type: tokenType });
    } catch {
      throw new ProviderUnavailableError();
    }
    if (result.error) {
      if (result.error.status === 400 || result.error.status === 401 || result.error.status === 403) {
        throw new ProviderInvalidInvitationError();
      }
      throw new ProviderUnavailableError();
    }
    if (!result.data.session || !result.data.user) throw new ProviderInvalidInvitationError();
    return toProviderSession(result.data.session);
  }

  async updatePassword(accessToken: string, password: string): Promise<ProviderUser> {
    let response: Response;
    try {
      response = await fetch(`${this.config.supabaseUrl}/auth/v1/user`, {
        method: "PUT",
        headers: {
          apikey: this.config.supabasePublishableKey,
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ password }),
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS)
      });
    } catch {
      throw new ProviderUnavailableError();
    }
    if (!response.ok) {
      if (response.status === 400 || response.status === 422) throw new ProviderPasswordPolicyError();
      if (response.status === 401 || response.status === 403) throw new ProviderInvalidInvitationError();
      throw new ProviderUnavailableError();
    }
    let user: Parameters<typeof toProviderUser>[0];
    try {
      user = await response.json() as Parameters<typeof toProviderUser>[0];
    } catch {
      throw new ProviderUnavailableError();
    }
    return toProviderUser(user);
  }

  async deleteInvitationUser(authUserId: string) {
    const client = this.createAdminClient();
    let result: Awaited<ReturnType<typeof client.auth.admin.deleteUser>>;
    try {
      result = await client.auth.admin.deleteUser(authUserId, false);
    } catch {
      throw new ProviderUnavailableError();
    }
    if (result.error) throw new ProviderUnavailableError();
  }

  private createPublicClient() {
    return createStatelessClient(this.config.supabaseUrl, this.config.supabasePublishableKey);
  }

  private createAdminClient() {
    return createStatelessClient(this.config.supabaseUrl, this.config.supabaseSecretKey);
  }
}

function createStatelessClient(url: string, key: string): SupabaseClient {
  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false
    },
    global: { fetch: fetchWithProviderTimeout }
  });
}

const fetchWithProviderTimeout: typeof fetch = (input, init) =>
  providerFetch(input, init);

export async function providerFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  timeoutMs = PROVIDER_TIMEOUT_MS
) {
  const signals = [
    init?.signal,
    input instanceof Request ? input.signal : undefined,
    AbortSignal.timeout(timeoutMs)
  ].filter((signal): signal is AbortSignal => Boolean(signal));
  return fetch(input, { ...init, signal: AbortSignal.any(signals) });
}

function toProviderSession(session: {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user: {
    id: string;
    email?: string;
    email_confirmed_at?: string;
    user_metadata?: Record<string, unknown>;
  };
}): ProviderSession {
  return {
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    expiresIn: session.expires_in,
    user: toProviderUser(session.user)
  };
}

function toProviderUser(user: {
  id: string;
  email?: string;
  email_confirmed_at?: string;
  user_metadata?: Record<string, unknown>;
}): ProviderUser {
  const requestId = user.user_metadata?.invitation_request_id;
  return {
    id: user.id,
    email: user.email ?? null,
    emailVerified: Boolean(user.email_confirmed_at),
    invitationRequestId: typeof requestId === "string" ? requestId : null
  };
}

function classifySignInError(error: AuthError) {
  if (error.status === 400 || error.status === 401 || error.status === 422) {
    return new ProviderInvalidCredentialsError();
  }
  return new ProviderUnavailableError();
}

function classifyRefreshError(error: AuthError) {
  if (error.status === 400 || error.status === 401 || error.status === 422) {
    return new ProviderInvalidRefreshTokenError();
  }
  return new ProviderUnavailableError();
}
