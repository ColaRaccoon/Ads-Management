"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import {
  apiErrorCode,
  apiGet,
  apiPost,
  invalidateApiSession,
  subscribeAuthLifecycle
} from "@/lib/api";
import { authCoordinator } from "./auth-coordination";
import { clearUserQueries } from "./auth-cache";
import { authLoginPayload } from "./auth-provider";
import { AuthMe, AuthStatus, parseAuthMe, Permission } from "./auth-types";

export const AUTH_ME_QUERY_KEY = ["auth", "me"] as const;
const AUTH_STALE_MS = 30_000;
const AUTH_VISIBLE_REFETCH_MS = 45_000;

export type AuthContextValue = {
  user: AuthMe["user"] | null;
  permissions: readonly Permission[];
  isLoading: boolean;
  isAuthenticated: boolean;
  status: AuthStatus;
  login(identifier: string, password: string): Promise<AuthMe>;
  acceptInvitation(tokenHash: string): Promise<AuthMe>;
  completeInvitation(password: string): Promise<AuthMe>;
  logout(): Promise<void>;
  can(permission: Permission): boolean;
  refreshAuth(): Promise<AuthMe | null>;
};

export const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [forcedStatus, setForcedStatus] = useState<AuthStatus | null>(null);
  const [acceptingInvitation, setAcceptingInvitation] = useState(false);
  const permissionRefresh = useRef<Promise<unknown> | null>(null);
  const previousIdentity = useRef<string | null>(null);
  const previousAuthorizationVersion = useRef<string | null>(null);

  const authQuery = useQuery({
    queryKey: AUTH_ME_QUERY_KEY,
    queryFn: fetchAuthMe,
    // Clearing an anonymous query must not immediately start another 401 loop.
    enabled: forcedStatus !== "anonymous" && forcedStatus !== "not-provisioned" && !acceptingInvitation,
    staleTime: AUTH_STALE_MS,
    retry: false,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchInterval: AUTH_VISIBLE_REFETCH_MS,
    refetchIntervalInBackground: false
  });

  const clearSession = useCallback((status: AuthStatus) => {
    invalidateApiSession();
    setForcedStatus(status);
    queryClient.cancelQueries();
    queryClient.clear();
  }, [queryClient]);

  const refreshAuth = useCallback(async () => {
    try {
      const me = await queryClient.fetchQuery({
        queryKey: AUTH_ME_QUERY_KEY,
        queryFn: fetchAuthMe,
        staleTime: 0
      });
      setForcedStatus(null);
      return me;
    } catch {
      return null;
    }
  }, [queryClient]);

  useEffect(() => subscribeAuthLifecycle((event) => {
    if (event.type === "permission-denied") {
      if (!permissionRefresh.current) {
        permissionRefresh.current = refreshAuth().finally(() => {
          permissionRefresh.current = null;
        });
      }
      return;
    }
    if (event.type === "account-not-provisioned") {
      clearSession("not-provisioned");
      return;
    }
    if (event.type === "onboarding-required") {
      invalidateApiSession();
      clearUserQueries(queryClient);
      setForcedStatus("onboarding");
      return;
    }
    clearSession("anonymous");
  }), [clearSession, queryClient, refreshAuth]);

  useEffect(() => authCoordinator.subscribe((event) => {
    if (event.type === "logout") {
      clearSession("anonymous");
      return;
    }
    if (event.type === "account-changed") {
      clearSession("loading");
      void refreshAuth();
      return;
    }
    if (event.type === "authorization-changed") {
      invalidateApiSession();
      setForcedStatus("loading");
      void queryClient.cancelQueries();
      clearUserQueries(queryClient);
      void refreshAuth();
    }
  }), [clearSession, queryClient, refreshAuth]);

  useEffect(() => {
    const me = authQuery.data;
    if (!me) return;
    // A remote authorization/account change or a bfcache restore deliberately
    // hides the authenticated tree until /auth/me succeeds. The immediate
    // refresh may fail transiently; a later focus/reconnect/interval success
    // must release that fail-closed loading state as well.
    setForcedStatus((current) => current === "loading" ? null : current);
    const previousUserId = previousIdentity.current;
    const previousVersion = previousAuthorizationVersion.current;
    previousIdentity.current = me.user.id;
    previousAuthorizationVersion.current = me.authorizationVersion;

    if (previousUserId && previousUserId !== me.user.id) {
      invalidateApiSession();
      clearUserQueries(queryClient);
      authCoordinator.broadcastAccountChanged();
      return;
    }
    if (previousVersion && previousVersion !== me.authorizationVersion) {
      invalidateApiSession();
      clearUserQueries(queryClient);
      authCoordinator.broadcastAuthorizationChanged(me.authorizationVersion);
    }
  }, [authQuery.data, authQuery.dataUpdatedAt, queryClient]);

  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      invalidateApiSession();
      setForcedStatus("loading");
      void queryClient.cancelQueries();
      clearUserQueries(queryClient);
      void refreshAuth();
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, [queryClient, refreshAuth]);

  const login = useCallback(async (identifier: string, password: string) => {
    await queryClient.cancelQueries();
    invalidateApiSession();
    queryClient.clear();
    setForcedStatus("loading");
    try {
      const me = await authCoordinator.runExclusive(async () =>
        parseAuthMe(await apiPost<unknown>("/auth/login", authLoginPayload(identifier, password)))
      );
      queryClient.setQueryData(AUTH_ME_QUERY_KEY, me);
      previousIdentity.current = me.user.id;
      previousAuthorizationVersion.current = me.authorizationVersion;
      setForcedStatus(null);
      authCoordinator.broadcastAccountChanged();
      return me;
    } catch (error) {
      if (!isAccountStateError(error)) setForcedStatus("anonymous");
      throw error;
    }
  }, [queryClient]);

  const replaceSession = useCallback(async (me: AuthMe, status: AuthStatus | null) => {
    await queryClient.cancelQueries();
    invalidateApiSession();
    queryClient.clear();
    queryClient.setQueryData(AUTH_ME_QUERY_KEY, me);
    previousIdentity.current = me.user.id;
    previousAuthorizationVersion.current = me.authorizationVersion;
    setForcedStatus(status);
    authCoordinator.broadcastAccountChanged();
    return me;
  }, [queryClient]);

  const acceptInvitation = useCallback(async (tokenHash: string) => {
    setAcceptingInvitation(true);
    await queryClient.cancelQueries({ queryKey: AUTH_ME_QUERY_KEY });
    // Discard older anonymous reads before sending the one-use invitation.
    invalidateApiSession();
    try {
      const me = parseAuthMe(await apiPost<unknown>("/auth/invitations/accept", { tokenHash }));
      if (!me.user.isActive || me.user.inviteStatus !== "VERIFIED_PENDING_PASSWORD") {
        throw new Error("Invalid invitation acceptance response.");
      }
      return await replaceSession(me, "onboarding");
    } finally {
      setAcceptingInvitation(false);
    }
  }, [queryClient, replaceSession]);

  const completeInvitation = useCallback(async (password: string) => {
    const me = parseAuthMe(await apiPost<unknown>("/auth/password", { password }));
    if (!me.user.isActive || me.user.inviteStatus !== "ACTIVE") {
      throw new Error("Invalid invitation completion response.");
    }
    return replaceSession(me, null);
  }, [replaceSession]);

  const logout = useCallback(async () => {
    // Local logout is fail-closed and immediate. A peer refresh holding the
    // coordination lock or an unavailable server must never leave the old
    // authenticated tree and user-scoped query cache visible.
    previousIdentity.current = null;
    previousAuthorizationVersion.current = null;
    clearSession("anonymous");
    authCoordinator.broadcastLogout();
    try {
      await authCoordinator.runExclusive(() => apiPost<void>("/auth/logout"));
    } catch {
      // The cookies are HttpOnly and server-owned. The next protected request
      // will still enforce the server session if this best-effort revoke fails.
    }
  }, [clearSession]);

  const status = forcedStatus ?? statusFromQuery(authQuery);
  const me = status === "authenticated" ? authQuery.data ?? null : null;
  const permissionSet = useMemo(() => new Set(me?.permissions ?? []), [me?.permissions]);
  const can = useCallback((permission: Permission) => permissionSet.has(permission), [permissionSet]);

  const value = useMemo<AuthContextValue>(() => ({
    user: me?.user ?? null,
    permissions: me?.permissions ?? [],
    isLoading: status === "loading",
    isAuthenticated: status === "authenticated",
    status,
    login,
    acceptInvitation,
    completeInvitation,
    logout,
    can,
    refreshAuth
  }), [acceptInvitation, can, completeInvitation, login, logout, me, refreshAuth, status]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

async function fetchAuthMe() {
  return parseAuthMe(await apiGet<unknown>("/auth/me"));
}

function statusFromQuery(query: {
  data?: AuthMe;
  isPending: boolean;
  error: unknown;
}): AuthStatus {
  if (query.isPending) return "loading";
  if (query.data?.user.inviteStatus === "ACTIVE" && query.data.user.isActive) return "authenticated";
  if (query.data?.user.inviteStatus === "VERIFIED_PENDING_PASSWORD" && query.data.user.isActive) return "onboarding";
  if (query.data) return "not-provisioned";
  const code = apiErrorCode(query.error);
  if (code === "ACCOUNT_ONBOARDING_REQUIRED") return "onboarding";
  if (code === "ACCOUNT_NOT_PROVISIONED") return "not-provisioned";
  return "anonymous";
}

function isAccountStateError(error: unknown) {
  const code = apiErrorCode(error);
  return code === "ACCOUNT_NOT_PROVISIONED" || code === "ACCOUNT_ONBOARDING_REQUIRED";
}
