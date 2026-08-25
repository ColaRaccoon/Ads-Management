// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, AUTH_ME_QUERY_KEY } from "./auth-context";
import { useAuth } from "./use-auth";

const apiMocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  invalidate: vi.fn()
}));
const coordinatorMocks = vi.hoisted(() => ({
  listener: null as null | ((event: { type: string; authorizationVersion?: string }) => void),
  runExclusive: vi.fn((task: () => Promise<unknown>) => task()),
  broadcastAccountChanged: vi.fn(),
  broadcastAuthorizationChanged: vi.fn(),
  broadcastLogout: vi.fn()
}));

vi.mock("@/lib/api", () => ({
  apiGet: apiMocks.get,
  apiPost: apiMocks.post,
  apiErrorCode: (error: unknown) => error && typeof error === "object" && "code" in error
    ? String((error as { code: unknown }).code)
    : null,
  invalidateApiSession: apiMocks.invalidate,
  subscribeAuthLifecycle: () => () => undefined
}));

vi.mock("./auth-coordination", () => ({
  authCoordinator: {
    subscribe: (listener: (event: { type: string; authorizationVersion?: string }) => void) => {
      coordinatorMocks.listener = listener;
      return () => { coordinatorMocks.listener = null; };
    },
    runExclusive: coordinatorMocks.runExclusive,
    broadcastAccountChanged: coordinatorMocks.broadcastAccountChanged,
    broadcastAuthorizationChanged: coordinatorMocks.broadcastAuthorizationChanged,
    broadcastLogout: coordinatorMocks.broadcastLogout
  }
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  coordinatorMocks.listener = null;
  coordinatorMocks.runExclusive.mockImplementation((task: () => Promise<unknown>) => task());
});

describe("AuthProvider cache and revalidation integration", () => {
  it("recovers from a transient bfcache /auth/me failure on a later refetch", async () => {
    const queryClient = createQueryClient();
    apiMocks.get.mockResolvedValueOnce(authMe("v1", ["data.read"]));
    renderProvider(queryClient);
    expect(await screen.findByText("authenticated:user-1:data.read")).toBeTruthy();

    apiMocks.get.mockRejectedValueOnce(new Error("temporary network failure"));
    const pageShow = new Event("pageshow");
    Object.defineProperty(pageShow, "persisted", { value: true });
    act(() => window.dispatchEvent(pageShow));
    expect(await screen.findByText("loading:none:")).toBeTruthy();
    await waitFor(() => expect(apiMocks.get).toHaveBeenCalledTimes(2));

    // The server may legitimately return an identical payload. React Query
    // structurally shares that object, so recovery must key off successful
    // fetch freshness rather than only a changed data reference.
    apiMocks.get.mockResolvedValueOnce(authMe("v1", ["data.read"]));
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: AUTH_ME_QUERY_KEY });
    });

    expect(await screen.findByText("authenticated:user-1:data.read")).toBeTruthy();
  });

  it("hides the old UI and clears user cache until a remote authorization change is revalidated", async () => {
    const queryClient = createQueryClient();
    apiMocks.get.mockResolvedValueOnce(authMe("v1", ["data.read"]));
    renderProvider(queryClient);
    expect(await screen.findByText("authenticated:user-1:data.read")).toBeTruthy();
    queryClient.setQueryData(["sensitive-products"], [{ id: "product-1" }]);

    let resolveRefresh!: (value: unknown) => void;
    apiMocks.get.mockImplementationOnce(() => new Promise((resolve) => { resolveRefresh = resolve; }));
    act(() => coordinatorMocks.listener?.({ type: "authorization-changed", authorizationVersion: "v2" }));

    expect(await screen.findByText("loading:none:")).toBeTruthy();
    expect(queryClient.getQueryData(["sensitive-products"])).toBeUndefined();

    resolveRefresh(authMe("v2", ["data.read", "operations.run"]));
    expect(await screen.findByText("authenticated:user-1:data.read,operations.run")).toBeTruthy();
  });

  it("makes logout local and cache-clearing before a held coordination lock settles", async () => {
    const queryClient = createQueryClient();
    apiMocks.get.mockResolvedValueOnce(authMe("v1", ["data.read"]));
    renderProvider(queryClient);
    expect(await screen.findByText("authenticated:user-1:data.read")).toBeTruthy();
    queryClient.setQueryData(["sensitive-products"], [{ id: "product-1" }]);
    coordinatorMocks.runExclusive.mockImplementationOnce(() => new Promise(() => undefined));

    fireEvent.click(screen.getByRole("button", { name: "logout" }));

    expect(await screen.findByText("anonymous:none:")).toBeTruthy();
    expect(queryClient.getQueryData(["sensitive-products"])).toBeUndefined();
    expect(queryClient.getQueryData(AUTH_ME_QUERY_KEY)).toBeUndefined();
    expect(coordinatorMocks.broadcastLogout).toHaveBeenCalledTimes(1);
  });

  it("keeps a verified invitation in onboarding across /auth/me reloads", async () => {
    const queryClient = createQueryClient();
    apiMocks.get.mockResolvedValueOnce(authMe("v1", [], "VERIFIED_PENDING_PASSWORD"));
    renderProvider(queryClient);

    expect(await screen.findByText("onboarding:none:")).toBeTruthy();
    expect(queryClient.getQueryData(AUTH_ME_QUERY_KEY)).toEqual(authMe("v1", [], "VERIFIED_PENDING_PASSWORD"));
  });

  it("owns cache replacement and account broadcast for accept and password completion", async () => {
    const queryClient = createQueryClient();
    apiMocks.get.mockRejectedValueOnce({ code: "AUTHENTICATION_REQUIRED" });
    renderProvider(queryClient);
    expect(await screen.findByText("anonymous:none:")).toBeTruthy();
    queryClient.setQueryData(["sensitive-before-invite"], { secret: "cached" });

    apiMocks.post.mockResolvedValueOnce(authMe("v2", [], "VERIFIED_PENDING_PASSWORD"));
    fireEvent.click(screen.getByRole("button", { name: "accept" }));
    expect(await screen.findByText("onboarding:none:")).toBeTruthy();
    expect(queryClient.getQueryData(["sensitive-before-invite"])).toBeUndefined();
    expect(coordinatorMocks.broadcastAccountChanged).toHaveBeenCalledTimes(1);

    queryClient.setQueryData(["onboarding-cache"], { private: true });
    apiMocks.post.mockResolvedValueOnce(authMe("v3", ["data.read"], "ACTIVE"));
    fireEvent.click(screen.getByRole("button", { name: "complete" }));
    expect(await screen.findByText("authenticated:user-1:data.read")).toBeTruthy();
    expect(queryClient.getQueryData(["onboarding-cache"])).toBeUndefined();
    expect(coordinatorMocks.broadcastAccountChanged).toHaveBeenCalledTimes(2);
  });
});

function AuthProbe() {
  const auth = useAuth();
  return <div>
    <span>{`${auth.status}:${auth.user?.id ?? "none"}:${auth.permissions.join(",")}`}</span>
    <button type="button" onClick={() => void auth.acceptInvitation("opaque-hash")}>accept</button>
    <button type="button" onClick={() => void auth.completeInvitation("a-strong-password")}>complete</button>
    <button type="button" onClick={() => void auth.logout()}>logout</button>
  </div>;
}

function renderProvider(queryClient: QueryClient) {
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider><AuthProbe /></AuthProvider>
    </QueryClientProvider>
  );
}

function createQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function authMe(
  authorizationVersion: string,
  permissions: string[],
  inviteStatus: "ACTIVE" | "VERIFIED_PENDING_PASSWORD" = "ACTIVE"
) {
  return {
    user: { id: "user-1", email: "user@example.test", name: "Role User", role: "USER", isActive: true, inviteStatus },
    permissions,
    authorizationVersion
  };
}
