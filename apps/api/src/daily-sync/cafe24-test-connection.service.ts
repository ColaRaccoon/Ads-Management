import { PrismaClient, SecurityAuditActorType, SecurityAuditResult, SourceProvider } from "@prisma/client";
import { syncError } from "./sync-contract";
import { writeSecurityAudit } from "../security-audit/security-audit.types";

export function cafe24TestAccount(env: NodeJS.ProcessEnv = process.env) {
  const mallId = env.DAILY_SYNC_CAFE24_MALL_ID ?? "";
  const shopKey = env.DAILY_SYNC_CAFE24_SHOP_KEY ?? "";
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(mallId) || !/^shop[1-9]\d*$/.test(shopKey))
    syncError("ACCOUNT_SCOPE_MISMATCH", 400);
  let allowed: unknown;
  try { allowed = JSON.parse(env.DAILY_SYNC_ALLOWED_ACCOUNTS ?? "[]"); }
  catch { syncError("ACCOUNT_SCOPE_MISMATCH", 400); }
  const key = `CAFE24/${mallId}/${shopKey}`;
  if (!Array.isArray(allowed) || allowed.length !== 1 || allowed[0] !== key)
    syncError("ACCOUNT_SCOPE_MISMATCH", 400);
  return { mallId, shopKey, key };
}

export function cafe24TestAllowed(mallId: string, shopKey: string,
  env: NodeJS.ProcessEnv = process.env) {
  if (env.DAILY_SYNC_FEATURE_ENABLED === "true" || env.DAILY_SYNC_SOURCE_ADMIN_ENABLED === "true") {
    let allowed: unknown;
    try { allowed = JSON.parse(env.DAILY_SYNC_ALLOWED_ACCOUNTS ?? "[]"); }
    catch { return false; }
    return Array.isArray(allowed) && allowed.length <= 100 &&
      allowed.every((value) => typeof value === "string" && value.length <= 530) &&
      allowed.includes(`CAFE24/${mallId}/${shopKey}`);
  }
  const account = cafe24TestAccount(env);
  return account.mallId === mallId && account.shopKey === shopKey;
}

/** A system-audited, one-account seed for the dedicated 06 test database. */
export class Cafe24TestConnectionService {
  constructor(private readonly prisma: PrismaClient) {}

  async createCafe24Test() {
    if (process.env.DAILY_SYNC_FEATURE_ENABLED === "true" ||
        process.env.DAILY_SYNC_CAFE24_TEST_ENABLED !== "true")
      syncError("PROVIDER_UNAVAILABLE", 503);
    const { mallId, shopKey } = cafe24TestAccount();
    return this.prisma.$transaction(async (tx) => {
      const key = { provider: SourceProvider.CAFE24, externalAccountId: mallId, shopKey };
      const inserted = await tx.sourceConnection.createMany({ data: {
        ...key, displayName: "Cafe24 06 test", currencyCode: "KRW",
        timeZone: "Asia/Seoul", enabled: false, accessState: "PENDING"
      }, skipDuplicates: true });
      const connection = await tx.sourceConnection.findUnique({ where: {
        provider_externalAccountId_shopKey: key
      } });
      if (!connection || connection.currencyCode !== "KRW" ||
          connection.timeZone !== "Asia/Seoul" || connection.enabled ||
          connection.accessState === "BLOCKED") syncError("ACCOUNT_SCOPE_MISMATCH");
      if (inserted.count === 1) await writeSecurityAudit(tx, {
        actorType: SecurityAuditActorType.SYSTEM,
        action: "SOURCE_CONNECTION_CREATED", targetType: "SOURCE_CONNECTION",
        targetId: connection.id, result: SecurityAuditResult.SUCCESS,
        afterJson: { provider: SourceProvider.CAFE24, externalAccountId: mallId,
          shopKey, enabled: false, purpose: "CAFE24_06_TEST" }
      });
      return { id: connection.id };
    }, { timeout: 5_000 });
  }
}
