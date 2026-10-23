import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { configureApiPrefix, isMachineSyncPost } from "../../../apps/api/src/common/api-routing";
import { HttpSecurityGuard } from "../../../apps/api/src/auth/http-security.guard";
import { AuthenticatedMutationRateGuard } from "../../../apps/api/src/auth/authenticated-mutation-rate.guard";

test("bootstrap prefix retains Cafe24 callbacks and uses the generic Next target for both machine routes", () => {
  let prefix: any;
  configureApiPrefix({ setGlobalPrefix: ((...args: any[]) => { prefix = args; }) as any });
  assert.equal(prefix[0], "api");
  assert.equal(prefix[1].exclude.some((item: any) => item.path.startsWith("internal/")), false);
  assert.deepEqual(prefix[1].exclude.map((item: any) => item.path), ["integrations/cafe24/oauth/callback",
    "integrations/cafe24/oauth/complete", "integrations/cafe24/oauth/failed"]);
});
test("machine mutation exceptions reject unprefixed, suffix, alternate method and sibling route", () => {
  for (const path of ["/api/internal/daily-sync", "/api/internal/daily-sync/status"]) assert.equal(isMachineSyncPost("POST", path), true);
  for (const [method, path] of [["POST", "/internal/daily-sync"], ["POST", "/api/internal/daily-sync/other"],
    ["GET", "/api/internal/daily-sync"], ["POST", "/api/internal/daily-sync/status/"]]) assert.equal(isMachineSyncPost(method, path), false);
});
test("both scheduled routes use general transport throttling while other mutations retain browser checks", async () => {
  let general = 0, mutation = 0, authenticated = 0, trusted = 0;
  const security: any = { assertTrustedTransport: async () => { trusted++; }, assertGeneralRead: async () => { general++; },
    assertGeneralMutationTransport: async () => { mutation++; }, assertAuthenticatedMutationRate: async () => { authenticated++; } };
  const http = new HttpSecurityGuard(security), rate = new AuthenticatedMutationRateGuard(security);
  const context = (path: string): any => ({ switchToHttp: () => ({ getRequest: () => ({ method: "POST", originalUrl: path }) }) });
  for (const path of ["/api/internal/daily-sync", "/api/internal/daily-sync/status"]) {
    await http.canActivate(context(path)); await rate.canActivate(context(path));
  }
  assert.equal(trusted, 2); assert.equal(general, 2); assert.equal(mutation, 0); assert.equal(authenticated, 0);
  await http.canActivate(context("/api/source-connections")); await rate.canActivate(context("/api/source-connections"));
  assert.equal(mutation, 1); assert.equal(authenticated, 1);
});
