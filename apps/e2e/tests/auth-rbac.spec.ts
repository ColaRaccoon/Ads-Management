import { expect, test } from "@playwright/test";
import { appendCleanupEntry, canonicalDigest, createScenarioEvidence } from "../src/evidence";
import {
  apiPath,
  IDENTITY_ALIASES,
  IdentityAlias,
  identityStorageState,
  loadE2eTargetContract,
  newApiContext,
  readProtectedJson
} from "../src/target-contract";

const target = loadE2eTargetContract();
const activeRoles = ["GUEST", "USER", "ADMIN", "SUPER_ADMIN"] as const;
const matrixIdentities = ["ANONYMOUS", ...IDENTITY_ALIASES] as const;

test.describe.serial("actual Auth/RBAC/CSRF/Origin seven-state contract", () => {
  test("binds the browser target and security headers to the frozen release", async ({ page }) => {
    const response = await page.goto(target.baseUrl, { waitUntil: "domcontentloaded" });
    expect(response).not.toBeNull();
    expect(response!.status()).toBe(200);
    expect(response!.headers()["content-security-policy"]).toBeTruthy();
    expect(response!.headers()["x-content-type-options"]).toBe("nosniff");
    expect(response!.headers()["referrer-policy"]).toBeTruthy();
  });

  test("proves anonymous, inactive, setup-pending and four active identities", async ({ playwright }) => {
    const observations: Array<{ identity: string; status: number; role?: string; code?: string }> = [];
    const anonymous = await newApiContext(playwright, target);
    try {
      const response = await anonymous.get(apiPath(target, "/api/auth/me"));
      expect(response.status()).toBe(401);
      const code = await errorCode(response);
      expect(code).toBe("AUTHENTICATION_REQUIRED");
      observations.push({ identity: "ANONYMOUS", status: response.status(), code });
    } finally { await anonymous.dispose(); }

    for (const alias of IDENTITY_ALIASES) {
      const context = await newApiContext(playwright, target, alias);
      try {
        const response = await context.get(apiPath(target, "/api/auth/me"));
        if (alias === "INACTIVE" || alias === "SETUP_PENDING") {
          expect(response.status()).toBe(403);
          const code = await errorCode(response);
          expect(code).toBe(alias === "INACTIVE" ? "ACCOUNT_INACTIVE" : "ACCOUNT_ONBOARDING_REQUIRED");
          observations.push({ identity: alias, status: response.status(), code });
        } else {
          expect(response.status()).toBe(200);
          const body = await response.json() as { role?: string; user?: { role?: string } };
          const role = body.role ?? body.user?.role;
          expect(role).toBe(alias);
          observations.push({ identity: alias, status: response.status(), role });
        }
      } finally { await context.dispose(); }
    }
    expect(observations).toHaveLength(7);
    const evidence = createScenarioEvidence({
      target, scenario: "auth.seven-state", result: "PASS", assertionCount: observations.length,
      counts: { identities: observations.length }, digests: { identity_matrix: canonicalDigest(observations) }
    });
    expect(evidence.result).toBe("PASS");
  });

  test("checks an actual route permission matrix without committing valid mutations", async ({ playwright }) => {
    const routes = [
      { method: "GET", path: "/api/uploads", allowed: activeRoles, allowedStatus: 200, allowedShape: "array" },
      { method: "POST", path: "/api/reports/export", body: {}, allowed: ["USER", "ADMIN", "SUPER_ADMIN"], allowedStatus: 400, allowedCode: "VALIDATION_FAILED" },
      { method: "POST", path: "/api/products", body: {}, allowed: ["ADMIN", "SUPER_ADMIN"], allowedStatus: 400, allowedCode: "VALIDATION_FAILED" },
      { method: "GET", path: "/api/users", allowed: ["SUPER_ADMIN"], allowedStatus: 200, allowedShape: "items" },
      { method: "GET", path: "/api/security-audit", allowed: ["SUPER_ADMIN"], allowedStatus: 200, allowedShape: "audit" }
    ] as const;
    const rows: string[] = [];
    for (const identity of matrixIdentities) {
      const alias = identity === "ANONYMOUS" ? undefined : identity as IdentityAlias;
      const context = await newApiContext(playwright, target, alias);
      try {
        for (const route of routes) {
          const response = await context.fetch(apiPath(target, route.path), {
            method: route.method,
            data: "body" in route ? route.body : undefined,
            headers: { "content-type": "application/json" }
          });
          expect(response.status()).not.toBe(404);
          expect(response.status()).toBeLessThan(500);
          const allowed = activeRoles.includes(identity as never) && route.allowed.includes(identity as never);
          const expected = allowed
            ? { status: route.allowedStatus, code: "allowedCode" in route ? route.allowedCode : undefined }
            : identity === "ANONYMOUS"
              ? { status: 401, code: "AUTHENTICATION_REQUIRED" }
              : identity === "INACTIVE"
                ? { status: 403, code: "ACCOUNT_INACTIVE" }
                : identity === "SETUP_PENDING"
                  ? { status: 403, code: "ACCOUNT_ONBOARDING_REQUIRED" }
                  : { status: 403, code: "PERMISSION_DENIED" };
          expect(response.status()).toBe(expected.status);
          const code = expected.code ? await errorCode(response) : "SUCCESS";
          if (expected.code) expect(code).toBe(expected.code);
          else {
            const body = await response.json();
            assertAllowedResponse(body, "allowedShape" in route ? route.allowedShape : "none");
          }
          rows.push(`${identity}|${route.method}|${route.path}|${response.status()}|${code}`);
        }
      } finally { await context.dispose(); }
    }
    const digest = canonicalDigest(rows);
    expect(digest).toBe(target.expected.routeMatrixDigestSha256);
    expect(createScenarioEvidence({
      target, scenario: "auth.rbac-matrix", result: "PASS", assertionCount: rows.length,
      counts: { identities: matrixIdentities.length, routes: routes.length, observations: rows.length },
      digests: { route_matrix: digest }
    }).result).toBe("PASS");
  });

  test("rejects missing CSRF and an unapproved Origin before business mutation", async ({ playwright }) => {
    const withoutCsrf = await newApiContext(playwright, target, "USER", { csrf: false });
    try {
      const response = await withoutCsrf.post(apiPath(target, "/api/reports/export"), { data: {} });
      expect(response.status()).toBe(403);
      expect(await errorCode(response)).toBe("CSRF_INVALID");
    } finally { await withoutCsrf.dispose(); }

    const wrongOrigin = await newApiContext(playwright, target, "USER", { origin: "https://origin-denied.invalid" });
    try {
      const response = await wrongOrigin.post(apiPath(target, "/api/reports/export"), { data: {} });
      expect(response.status()).toBe(403);
      expect(await errorCode(response)).toBe("ORIGIN_NOT_ALLOWED");
    } finally { await wrongOrigin.dispose(); }
  });

  test("exercises cloud login, me, refresh and logout without exposing credentials", async ({ playwright }) => {
    const flow = authFlow();
    const context = await playwright.request.newContext({ baseURL: target.baseUrl, extraHTTPHeaders: { origin: target.baseUrl } });
    try {
      const login = await context.post(apiPath(target, "/api/auth/login"), { data: flow.login });
      expect(login.status()).toBe(200);
      expect((await context.get(apiPath(target, "/api/auth/me"))).status()).toBe(200);
      const refresh = await context.post(apiPath(target, "/api/auth/refresh"), {
        headers: { "x-csrf-token": await csrfFromContext(context) }
      });
      expect(refresh.status()).toBe(200);
      const logout = await context.post(apiPath(target, "/api/auth/logout"), {
        headers: { "x-csrf-token": await csrfFromContext(context) }
      });
      expect(logout.status()).toBe(204);
      expect((await context.get(apiPath(target, "/api/auth/me"))).status()).toBe(401);
    } finally { await context.dispose(); }
  });

  test("logs in through the actual browser UI and exposes only role-authorized navigation", async ({ page, browser }) => {
    const flow = authFlow();
    await page.goto(`${target.baseUrl}/login?next=/dashboard`);
    await page.getByLabel("이메일").fill(flow.login.email);
    await page.getByLabel("비밀번호").fill(flow.login.password);
    await page.getByRole("button", { name: "로그인", exact: true }).click();
    await expect(page).toHaveURL(`${target.baseUrl}/dashboard`);
    await expect(page.getByRole("button", { name: /로그아웃/ })).toBeVisible();

    for (const alias of activeRoles) {
      const context = await browser.newContext({ baseURL: target.baseUrl, storageState: identityStorageState(alias) });
      try {
        const rolePage = await context.newPage();
        await rolePage.goto("/dashboard");
        await expect(rolePage.getByRole("link", { name: "Meta Dashboard", exact: true })).toBeVisible();
        const managementVisible = alias === "SUPER_ADMIN";
        if (managementVisible) {
          await expect(rolePage.getByRole("link", { name: "사용자 관리", exact: true })).toBeVisible();
          await expect(rolePage.getByRole("link", { name: "보안 감사", exact: true })).toBeVisible();
        } else {
          await expect(rolePage.getByRole("link", { name: "사용자 관리", exact: true })).toHaveCount(0);
          await expect(rolePage.getByRole("link", { name: "보안 감사", exact: true })).toHaveCount(0);
        }
      } finally { await context.close(); }
    }
  });

  test("accepts and completes one separately approved onboarding identity through the browser UI", async ({ page }) => {
    const flow = authFlow();
    await page.goto(`${target.baseUrl}/invite/accept#token_hash=${encodeURIComponent(flow.invitation.tokenHash)}`);
    await page.getByRole("button", { name: "초대 수락", exact: true }).click();
    await expect(page).toHaveURL(`${target.baseUrl}/complete-invitation`);
    await page.getByLabel("새 비밀번호", { exact: true }).fill(flow.invitation.password);
    await page.getByLabel("새 비밀번호 확인", { exact: true }).fill(flow.invitation.password);
    await page.getByRole("button", { name: "비밀번호 설정 완료", exact: true }).click();
    await expect(page).toHaveURL(`${target.baseUrl}/dashboard`);
    const me = await page.context().request.get(apiPath(target, "/api/auth/me"));
    expect(me.status()).toBe(200);
    const body = await me.json() as { id?: unknown; user?: { id?: unknown } };
    const id = body.id ?? body.user?.id;
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    appendCleanupEntry(required("E2E_CLEANUP_MANIFEST_FILE"), cleanupBase(), {
      kind: "AUTH_IDENTITY", opaqueId: id as string, cleanupOwner: "SUPABASE_MAINTENANCE"
    });
  });
});

async function errorCode(response: { json(): Promise<unknown> }) {
  const body = await response.json() as { code?: unknown };
  return typeof body.code === "string" ? body.code : "ERROR_CODE_MISSING";
}

type AuthFlow = {
  login: { email: string; password: string };
  invitation: { tokenHash: string; password: string };
};

function authFlow(): AuthFlow {
  const value = readProtectedJson(required("E2E_AUTH_FLOW_FILE")) as Partial<AuthFlow>;
  if (!value.login || !value.invitation || Object.keys(value).sort().join(",") !== "invitation,login" ||
      Object.keys(value.login).sort().join(",") !== "email,password" ||
      Object.keys(value.invitation).sort().join(",") !== "password,tokenHash" ||
      typeof value.login.email !== "string" || typeof value.login.password !== "string" ||
      typeof value.invitation.tokenHash !== "string" || typeof value.invitation.password !== "string") {
    throw new Error("E2E_AUTH_FLOW_INVALID");
  }
  return value as AuthFlow;
}

async function csrfFromContext(context: { storageState(): Promise<{ cookies: Array<{ name: string; value: string }> }> }) {
  const state = await context.storageState();
  const value = state.cookies.find((cookie) => cookie.name.endsWith("meta_csrf"))?.value;
  if (!value) throw new Error("E2E_AUTH_FLOW_CSRF_MISSING");
  return value;
}

function cleanupBase() {
  const runId = required("E2E_RUN_ID");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)) {
    throw new Error("E2E_RUN_ID_INVALID");
  }
  return {
    version: "e2e-cleanup/v1" as const,
    runId,
    environmentId: target.environmentId,
    projectRef: target.projectRef,
    releaseGitSha: target.releaseGitSha
  };
}

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

function assertAllowedResponse(value: unknown, shape: "array" | "items" | "audit" | "none") {
  if (shape === "array") {
    expect(Array.isArray(value)).toBe(true);
    return;
  }
  expect(value).not.toBeNull();
  expect(typeof value).toBe("object");
  const keys = Object.keys(value as object).sort();
  if (shape === "items") expect(keys).toEqual(["items"]);
  else if (shape === "audit") expect(keys).toEqual(["items", "nextCursor"]);
  else throw new Error("E2E_ROUTE_RESPONSE_SHAPE_UNDECLARED");
  expect(Array.isArray((value as { items?: unknown }).items)).toBe(true);
}
