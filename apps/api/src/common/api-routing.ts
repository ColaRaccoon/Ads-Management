import { INestApplication, RequestMethod } from "@nestjs/common";

/** The public Next rewrite appends /api; machine routes use that same prefix. */
export function configureApiPrefix(app: Pick<INestApplication, "setGlobalPrefix">) {
  app.setGlobalPrefix("api", { exclude: [
    { path: "integrations/cafe24/oauth/callback", method: RequestMethod.GET },
    { path: "integrations/cafe24/oauth/complete", method: RequestMethod.GET },
    { path: "integrations/cafe24/oauth/failed", method: RequestMethod.GET }
  ] });
}

export function isMachineSyncPost(method: string, path: string) {
  return method === "POST" && (path === "/api/internal/daily-sync" || path === "/api/internal/daily-sync/status");
}
