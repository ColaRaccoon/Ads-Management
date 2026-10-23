import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { CredentialVault } from "./credential-vault";
import { Cafe24OauthService } from "./cafe24-oauth.service";
import { Cafe24OrdersClient } from "./cafe24-orders.client";
import { accountAllowlist, accountKey } from "./source-connections.service";

const callbackPath = "/backend-api/integrations/cafe24/oauth/callback";
const basePath = "/backend-api/integrations/cafe24/oauth";

export function isolatedDatabaseUrl(value: string | undefined) {
  if (!value) throw new Error("ISOLATED_DATABASE_REQUIRED");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("ISOLATED_DATABASE_REQUIRED"); }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:")
    throw new Error("ISOLATED_DATABASE_REQUIRED");
  if (url.hostname !== "127.0.0.1" || url.port !== "55433" ||
      url.pathname !== "/phase03" || url.searchParams.get("schema") !== "meta_ads" ||
      url.searchParams.size !== 1) throw new Error("ISOLATED_DATABASE_REQUIRED");
  return value;
}

async function main() {
  const mode = process.argv[2];
  if (!mode || !["serve", "authorize", "summary", "probe", "statuses"].includes(mode))
    throw new Error("Use serve, authorize, summary, probe, or statuses.");
  const databaseUrl = isolatedDatabaseUrl(process.env.DAILY_SYNC_INTEGRATION_DATABASE_URL);
  process.env.DATABASE_URL = databaseUrl; // Overrides any package .env loaded by Prisma.
  if (process.env.DAILY_SYNC_FEATURE_ENABLED !== "true" &&
      process.env.DAILY_SYNC_CAFE24_TEST_ENABLED !== "true") throw new Error("FEATURE_OFF");
  const mallId = process.env.DAILY_SYNC_CAFE24_MALL_ID ?? "";
  const shopKey = process.env.DAILY_SYNC_CAFE24_SHOP_KEY ?? "";
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(mallId) || !/^shop[1-9]\d*$/.test(shopKey) ||
      !accountAllowlist().has(accountKey("CAFE24", mallId, shopKey)))
    throw new Error("ACCOUNT_SCOPE_MISMATCH");
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    const vault = new CredentialVault(prisma as never);
    const oauth = new Cafe24OauthService(prisma as never, vault);
    const orders = new Cafe24OrdersClient(prisma as never, oauth);
    if (mode === "serve") {
      const port = 4100;
      const expectedHost = new URL(process.env.DAILY_SYNC_CAFE24_REDIRECT_URI ?? "").host;
      let windowStart = Date.now();
      let callbackAttempts = 0;
      const server = createServer(async (request, response) => {
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("Referrer-Policy", "no-referrer");
        if ((request.url?.length ?? 0) > 2_048) { response.writeHead(414).end(); return; }
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        if (request.method !== "GET") { response.writeHead(405).end(); return; }
        if (url.pathname === "/") {
          response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" })
            .end("Cafe24 isolated test receiver is ready. Start authorization from the local console.");
          return;
        }
        if (url.pathname === `${basePath}/complete` || url.pathname === `${basePath}/failed`) {
          const complete = url.pathname.endsWith("complete");
          response.writeHead(complete ? 200 : 400, { "Content-Type": "text/plain; charset=utf-8" })
            .end(complete ? "Cafe24 connection completed. Return to the application." :
              "Cafe24 connection failed. Start a new authorization attempt.");
          return;
        }
        if (url.pathname !== callbackPath) { response.writeHead(404).end(); return; }
        if (request.headers.host !== expectedHost) { response.writeHead(421).end(); return; }
        if (Date.now() - windowStart >= 60_000) { windowStart = Date.now(); callbackAttempts = 0; }
        callbackAttempts += 1;
        if (callbackAttempts > 30) { response.writeHead(429).end(); return; }
        const state = url.searchParams.get("state") ?? undefined;
        const code = url.searchParams.get("code") ?? undefined;
        const error = url.searchParams.get("error") ?? undefined;
        let result = "failed";
        try { await oauth.callback({ state, code, error }); result = "complete"; }
        catch { /* Never log authorization code, state, or provider payload. */ }
        response.writeHead(303, { Location: `${basePath}/${result}` }).end();
      });
      await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
      process.stdout.write("Cafe24 isolated callback listening on loopback port 4100.\n");
      await new Promise<void>((resolve) => {
        process.once("SIGINT", () => server.close(() => resolve()));
        process.once("SIGTERM", () => server.close(() => resolve()));
      });
      return;
    }
    let connection = await prisma.sourceConnection.findUnique({ where: {
      provider_externalAccountId_shopKey: { provider: "CAFE24", externalAccountId: mallId, shopKey }
    } });
    if (!connection && mode === "authorize") connection = await prisma.sourceConnection.create({ data: {
      provider: "CAFE24", externalAccountId: mallId, shopKey,
      displayName: "Cafe24 isolated test", currencyCode: "KRW", timeZone: "Asia/Seoul",
      enabled: false, accessState: "PENDING"
    } });
    if (!connection || connection.currencyCode !== "KRW" || connection.timeZone !== "Asia/Seoul")
      throw new Error("ACCOUNT_SCOPE_MISMATCH");
    if (mode === "authorize") {
      const { authorizeUrl } = await oauth.begin(connection.id, null);
      if (process.platform !== "win32") throw new Error("BROWSER_LAUNCH_UNSUPPORTED");
      const child = spawn("rundll32.exe", ["url.dll,FileProtocolHandler", authorizeUrl],
        { detached: true, stdio: "ignore", windowsHide: true });
      child.unref();
      process.stdout.write("Cafe24 authorization opened in browser.\n");
      return;
    }
    const day = process.argv[3];
    if (!day) throw new Error("DAY_REQUIRED");
    const result = mode === "probe" ? await orders.probeDayShape(connection.id, day)
      : mode === "statuses" ? await orders.probeDayStatuses(connection.id, day)
        : await orders.readDaySummary(connection.id, day);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally { await prisma.$disconnect(); }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    // The category is fixed; no provider text, URL, token, or PII reaches stdout/stderr.
    const category = error instanceof Error &&
      ["ISOLATED_DATABASE_REQUIRED", "FEATURE_OFF", "ACCOUNT_SCOPE_MISMATCH",
        "BROWSER_LAUNCH_UNSUPPORTED", "DAY_REQUIRED"].includes(error.message)
      ? error.message : "CAFE24_ISOLATED_FAILED";
    process.stderr.write(`${category}\n`);
    process.exitCode = 1;
  });
}
