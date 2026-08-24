import { Inject, Injectable } from "@nestjs/common";
import { AuthError, createClient, SupabaseClient } from "@supabase/supabase-js";
import { AUTH_CONFIG, AuthConfig } from "./auth.config";
import {
  IdentityProvider,
  ProviderInvalidCredentialsError,
  ProviderInvalidRefreshTokenError,
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
    if (error || !data.user) throw new ProviderUnavailableError();
    return {
      id: data.user.id,
      email: data.user.email ?? null,
      emailVerified: Boolean(data.user.email_confirmed_at)
    };
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
  user: { id: string; email?: string; email_confirmed_at?: string };
}): ProviderSession {
  return {
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    expiresIn: session.expires_in,
    user: {
      id: session.user.id,
      email: session.user.email ?? null,
      emailVerified: Boolean(session.user.email_confirmed_at)
    }
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
