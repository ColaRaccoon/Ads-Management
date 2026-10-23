import { Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import { Prisma, SecurityAuditActorType, SecurityAuditResult, SourceDataKind, SourceKind } from "@prisma/client";
import { formatInTimeZone } from "date-fns-tz";
import { PrismaService } from "../common/prisma.service";
import { writeSecurityAudit } from "../security-audit/security-audit.types";
import { MetaDayReader } from "./meta-day-reader";
import { assertMetaOperatingGate, assertMetaSnapshotTransport } from "./meta-operating-gate";
import { MetaCredentialResolver, resolveMetaCredential, configuredMetaTransport } from "./meta-credential-resolver";
import { configuredMetaSettings } from "./meta-sync-runner.service";
import { META_UNAVAILABLE_REASONS } from "../domain/meta-conditional-metrics";
import type { MetaApiAd, MetaApiAdset } from "./canonical-api-writer.service";
import { accountAllowlist, accountKey } from "./source-connections.service";
import { assertEnabled, parseIsoDate, syncError } from "./sync-contract";

/** Explicit API-only readiness gate; verification reads do not publish metrics. */
@Injectable()
export class MetaConnectionVerifierService {
  constructor(private readonly prisma: PrismaService, private readonly resolver: MetaCredentialResolver,
    private readonly client: MetaDayReader) {}

  async verifyAndActivate(input: { connectionId: string; verificationDay: string; fromDate: string;
    observedAccountSpendUsd: string; conditionalReviewDecision: "REQUIRE_VERIFIED_CONDITIONALS" | "ALLOW_UNAVAILABLE_WITH_REASONS";
    actorUserId: string }) {
    assertEnabled();
    const transport = configuredMetaTransport();
    if ((this.client.transport ?? "GRAPH") !== transport) syncError("PROVIDER_AUTH_REQUIRED");
    if (!["REQUIRE_VERIFIED_CONDITIONALS", "ALLOW_UNAVAILABLE_WITH_REASONS"].includes(input.conditionalReviewDecision)) syncError("FIELD_UNSUPPORTED");
    const fromDate = parseIsoDate(input.fromDate);
    parseIsoDate(input.verificationDay);
    if (input.fromDate > input.verificationDay || input.verificationDay >= formatInTimeZone(new Date(), "Asia/Seoul", "yyyy-MM-dd") ||
        typeof input.observedAccountSpendUsd !== "string" || !/^(0|[1-9]\d{0,9})(\.\d{1,4})?$/.test(input.observedAccountSpendUsd))
      syncError("RUN_LIMIT_EXCEEDED", 400);
    const assertTier = () => assertMetaOperatingGate(transport);
    assertTier();
    const connection = await this.prisma.sourceConnection.findUnique({ where: { id: input.connectionId } });
    if (!connection || connection.provider !== "META" || connection.shopKey !== "default" ||
        !accountAllowlist().has(accountKey(connection.provider, connection.externalAccountId, connection.shopKey)))
      syncError("ACCOUNT_SCOPE_MISMATCH");
    if (connection.currencyCode !== "USD") syncError("CURRENCY_MISMATCH");
    if (connection.timeZone !== "Asia/Seoul") syncError("TIMEZONE_MISMATCH");
    if (connection.accessState === "BLOCKED" || !connection.credentialRef ||
        connection.credentialRef !== process.env.DAILY_SYNC_META_CREDENTIAL_REF || !this.resolver)
      syncError("PROVIDER_AUTH_REQUIRED");
    const credential = await resolveMetaCredential(this.resolver, { credentialRef: connection.credentialRef,
      connectionId: connection.id, accountId: connection.externalAccountId, transport });
    if (connection.credentialExpiresAt?.getTime() !== credential.expiresAt.getTime()) syncError("PROVIDER_AUTH_REQUIRED");
    const settings = configuredMetaSettings();
    const snapshot = await this.client.fetchDay({ accountId: connection.externalAccountId, day: input.verificationDay,
      deadlineAt: Date.now() + 60_000, settings, accessToken: credential.token });
    assertMetaOperatingGate(transport); assertMetaSnapshotTransport(snapshot, transport);
    if (snapshot.currencyCode !== "USD") syncError("CURRENCY_MISMATCH");
    if (snapshot.timeZone !== "Asia/Seoul") syncError("TIMEZONE_MISMATCH");
    if (!new Prisma.Decimal(snapshot.accountSpendUsd).eq(input.observedAccountSpendUsd)) syncError("RECONCILIATION_FAILED");
    for (const row of snapshot.ads) validateMetaVerificationMetrics(row, true, input.conditionalReviewDecision);
    for (const row of snapshot.adsets) validateMetaVerificationMetrics(row, false, input.conditionalReviewDecision);
    const verificationFingerprint = createHash("sha256").update(JSON.stringify({ day: input.verificationDay,
      settings, transport, protocolVersion: snapshot.protocolVersion ?? null, accountSpendUsd: snapshot.accountSpendUsd,
      ads: snapshot.ads.map((row) => [row.adId, row.sourceRevision]).sort(),
      adsets: snapshot.adsets.map((row) => [row.adsetId, row.sourceRevision]).sort() })).digest("hex");
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM source_connections WHERE id = ${connection.id}::uuid FOR UPDATE`);
      const current = await tx.sourceConnection.findUnique({ where: { id: connection.id } });
      assertEnabled(); assertTier();
      if (!current || current.provider !== "META" || current.externalAccountId !== connection.externalAccountId ||
          current.shopKey !== connection.shopKey || current.updatedAt.getTime() !== connection.updatedAt.getTime() ||
          current.accessState === "BLOCKED" || current.credentialRef !== credential.credentialRef ||
          process.env.DAILY_SYNC_META_CREDENTIAL_REF !== credential.credentialRef ||
          current.credentialExpiresAt?.getTime() !== credential.expiresAt.getTime() ||
          credential.expiresAt.getTime() <= Date.now() + 7 * 86_400_000 ||
          !accountAllowlist().has(accountKey(current.provider, current.externalAccountId, current.shopKey)))
        syncError("PROVIDER_AUTH_REQUIRED");
      if (current.currencyCode !== "USD") syncError("CURRENCY_MISMATCH");
      if (current.timeZone !== "Asia/Seoul") syncError("TIMEZONE_MISMATCH");
      const lease = await tx.syncLease.findUnique({ where: { connectionId: connection.id } });
      if (lease && lease.expiresAt > new Date()) syncError("LEASE_LOST");
      const kinds = [SourceDataKind.META_AD, SourceDataKind.META_ADSET];
      const policies = await tx.sourcePolicy.findMany({ where: { connectionId: connection.id, dataKind: { in: kinds } } });
      // Initial activation starts on the verified day. Reconnection preserves
      // the original policy start and verifies a fresh completed day instead.
      if (!policies.length && input.fromDate !== input.verificationDay) syncError("SOURCE_SELECTION_REQUIRED");
      if (policies.length && (policies.length !== 2 || kinds.some((kind) => {
        const matching = policies.filter((policy) => policy.dataKind === kind);
        return matching.length !== 1 || matching[0].primarySource !== SourceKind.API ||
          matching[0].fromDate.getTime() !== fromDate.getTime() || matching[0].toDate !== null;
      }))) syncError("SOURCE_SELECTION_REQUIRED");
      const where = { source: SourceKind.CSV, isCurrent: true, metricDate: { gte: fromDate },
        OR: [{ connectionId: null }, { connectionId: connection.id }] };
      const [adCsv, setCsv] = await Promise.all([
        tx.metaAdDailyMetric.findFirst({ where, select: { id: true } }),
        tx.metaAdsetDailyMetric.findFirst({ where, select: { id: true } })
      ]);
      if (adCsv || setCsv) syncError("SOURCE_SELECTION_REQUIRED");
      if (!policies.length) for (const dataKind of kinds) await tx.sourcePolicy.create({ data: {
        connectionId: connection.id, dataKind, fromDate, primarySource: SourceKind.API,
        version: 1, changedByUserId: input.actorUserId, reason: "META_API_ONLY_READ_VERIFIED"
      } });
      await tx.sourceConnection.update({ where: { id: connection.id }, data: { accessState: "READY", enabled: true } });
      await writeSecurityAudit(tx, { actorType: SecurityAuditActorType.USER, actorUserId: input.actorUserId,
        action: "META_CONNECTION_VERIFIED", targetType: "SOURCE_CONNECTION", targetId: connection.id,
        result: SecurityAuditResult.SUCCESS, afterJson: { verificationDay: input.verificationDay,
          fromDate: input.fromDate, accountSpendUsd: snapshot.accountSpendUsd,
          currencyCode: snapshot.currencyCode, timeZone: snapshot.timeZone, adCount: snapshot.ads.length,
          adsetCount: snapshot.adsets.length, conditionalReviewDecision: input.conditionalReviewDecision,
          verificationFingerprint, actionReportTime: settings.actionReportTime,
          transport, protocolVersion: snapshot.protocolVersion ?? null,
          attributionWindows: [...settings.attributionWindows] } });
      return { accessState: "READY", enabled: true, verifiedDay: input.verificationDay,
        accountSpendUsd: snapshot.accountSpendUsd, adCount: snapshot.ads.length, adsetCount: snapshot.adsets.length };
    }, { timeout: 5_000, maxWait: 2_000 });
  }
}

/** Unknown is permitted only as an explicit null paired with a safe typed reason. */
export function validateMetaVerificationMetrics(row: MetaApiAd | MetaApiAdset, isAd: boolean,
  decision: "REQUIRE_VERIFIED_CONDITIONALS" | "ALLOW_UNAVAILABLE_WITH_REASONS") {
  if (!["REQUIRE_VERIFIED_CONDITIONALS", "ALLOW_UNAVAILABLE_WITH_REASONS"].includes(decision)) syncError("FIELD_UNSUPPORTED");
  if(row.actionReportTime==="MCP_PROVIDER_DEFAULT_UNVERIFIED"&&(!row.currentMetadata?.sourceContext?.purchaseMeasurement||row.purchaseCount==null||row.purchaseValueUsd==null))syncError("FIELD_UNSUPPORTED");
  if (row.attributionSetting !== null && (typeof row.attributionSetting !== "string" ||
      !row.attributionSetting.trim() || row.attributionSetting.length > 128)) syncError("ATTRIBUTION_MISMATCH");
  const fields = ["resultCount", "landingPageViews", "shopClicks", ...(isAd
    ? ["purchaseCount", "addToCartCount", "videoPlay3sCount", "videoPlay25Count", "videoPlay50Count", "videoPlay75Count", "videoPlay100Count"] : [])];
  const reasons = row.metricUnavailableReasons;
  if (!reasons || typeof reasons !== "object" || Array.isArray(reasons) ||
      Object.entries(reasons).some(([field, reason]) => !fields.includes(field) || !META_UNAVAILABLE_REASONS.includes(reason)))
    syncError("FIELD_UNSUPPORTED");
  for (const field of fields) {
    const value = (row as unknown as Record<string, unknown>)[field];
    const reason = reasons[field];
    if (value === null) {
      if (!reason) syncError("FIELD_UNSUPPORTED");
      if (decision === "REQUIRE_VERIFIED_CONDITIONALS" &&
          !(field === "shopClicks" && reason === "NOT_APPLICABLE") &&
          !(field === "resultCount" && reason === "NOT_APPLICABLE")) syncError("FIELD_UNSUPPORTED");
    } else if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 2_147_483_647 || reason)
      syncError("FIELD_UNSUPPORTED");
  }
  if (row.shopClicks !== null || reasons.shopClicks !== "NOT_APPLICABLE") syncError("FIELD_UNSUPPORTED");
  const providerPurchase=row.actionReportTime==="MCP_PROVIDER_DEFAULT_UNVERIFIED"&&row.currentMetadata?.sourceContext?.purchaseMeasurement;
  if(providerPurchase&&(row.purchaseCount==null||row.purchaseValueUsd==null))syncError("FIELD_UNSUPPORTED");
  if (row.attributionSetting === null && fields.some((field) => field !== "shopClicks" && !(providerPurchase&&field==="purchaseCount") &&
      (row as unknown as Record<string, unknown>)[field] !== null)) syncError("ATTRIBUTION_MISMATCH");
}
