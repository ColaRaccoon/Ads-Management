import { Injectable, NotFoundException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { formatInTimeZone } from "date-fns-tz";
import {
  MatchSource, Prisma, SecurityAuditActorType, SecurityAuditResult, SourceCoverageState,
  SourceDataKind, SourceKind, SourceProvider, SyncRunStatus, RowValidationStatus
} from "@prisma/client";
import { PrismaService } from "../common/prisma.service";
import { writeSecurityAudit } from "../security-audit/security-audit.types";
import { hasCafe24CouponPaymentToken } from "../domain/cafe24-coupon-matcher";
import { selectCurrentSourceRows } from "../common/source-read-policy";
import { computeCafe24ActivationEvidence } from "./cafe24-activation-evidence";
import { cafe24ProductPrefixSpaceDifference, cafe24StableItemKey } from "./cafe24-reviewed-parity";
import { Cafe24ProductMatcher } from "../domain/cafe24-matcher";
import { loadCafe24MatcherRules } from "./cafe24-rule-loader";
import { rejectCafe24Activation } from "./cafe24-activation-diagnostic";
import { cafe24ObservationHmac, cafe24ObservationKey } from "./cafe24-observed-revision";
import { ConnectionInput, PolicyInput } from "./daily-sync.dto";
import { assertEnabled, assertSourceAdministrationEnabled, enabledSync, parseIsoDate, syncError, validateAccountKey } from "./sync-contract";

const KINDS_BY_PROVIDER: Record<SourceProvider, readonly SourceDataKind[]> = {
  GOOGLE: [SourceDataKind.GOOGLE_CAMPAIGN],
  META: [SourceDataKind.META_AD, SourceDataKind.META_ADSET],
  CAFE24: [SourceDataKind.CAFE24_ORDER]
};

type UndatedCsvBindingRow = {
  id: string; importVersion: number; orderNo: string; lineOrderNo: string;
  productNo: string; productName: string; optionName: string;
  quantity: Prisma.Decimal; salePriceKrw: Prisma.Decimal;
  totalOrderKrw: Prisma.Decimal | null; totalPaidKrw: Prisma.Decimal;
  paymentMethod: string | null; productId: string | null;
  cafe24ProductRuleId: string | null; matchSource: string;
  validationStatus: RowValidationStatus;
};
type UndatedCsvBindingLink = { id: string; canonicalKeyHash: string; version: number };

/** UUID/link/version and protected content are stored; order identity is not. */
export function cafe24UndatedCsvBinding(connectionId: string,
  row: UndatedCsvBindingRow, link: UndatedCsvBindingLink, keyVersion?: number) {
  if (keyVersion !== undefined && (!Number.isSafeInteger(keyVersion) ||
      keyVersion < 1 || keyVersion > 99)) syncError("SOURCE_SELECTION_REQUIRED");
  const observation = cafe24ObservationKey(keyVersion === undefined ? process.env :
    { ...process.env, DAILY_SYNC_CAFE24_OBSERVATION_KEY_VERSION: String(keyVersion) });
  try {
    const content = JSON.stringify([connectionId, row.id, row.importVersion,
      link.id, link.canonicalKeyHash, link.version,
      row.orderNo, row.lineOrderNo, row.productNo, row.productName,
      row.optionName, row.quantity.toString(), row.salePriceKrw.toString(),
      row.totalOrderKrw?.toString() ?? null, row.totalPaidKrw.toString(),
      row.paymentMethod, row.productId, row.cafe24ProductRuleId,
      row.matchSource, row.validationStatus]);
    return { recordId: row.id, importVersion: row.importVersion,
      linkId: link.id, fingerprintKeyVersion: observation.version,
      fingerprint: cafe24ObservationHmac(observation.key,
        "CSV_UNDATED_REVIEWED_BINDING_V1", content) };
  } finally { observation.key.fill(0); }
}

export function accountAllowlist(env: NodeJS.ProcessEnv = process.env) {
  try {
    const value = JSON.parse(env.DAILY_SYNC_ALLOWED_ACCOUNTS || "[]") as unknown;
    if (!Array.isArray(value) || value.length > 100 ||
        !value.every((item) => typeof item === "string" && item.length <= 530)) return new Set<string>();
    return new Set<string>(value);
  } catch { return new Set<string>(); }
}

export function accountKey(provider: SourceProvider, externalAccountId: string, shopKey: string) {
  return `${provider}/${externalAccountId}/${shopKey}`;
}

@Injectable()
export class SourceConnectionsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Idempotent one-account seed for the read-only Cafe24 installation test. */
  async createCafe24Test(actorUserId: string | null) {
    if (enabledSync() || process.env.DAILY_SYNC_CAFE24_TEST_ENABLED !== "true")
      syncError("PROVIDER_UNAVAILABLE", 503);
    const mallId = process.env.DAILY_SYNC_CAFE24_MALL_ID ?? "";
    const shopKey = process.env.DAILY_SYNC_CAFE24_SHOP_KEY ?? "";
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(mallId) || !/^shop[1-9]\d*$/.test(shopKey))
      syncError("ACCOUNT_SCOPE_MISMATCH", 400);
    const allowed = accountAllowlist();
    if (allowed.size !== 1 || !allowed.has(accountKey(SourceProvider.CAFE24, mallId, shopKey)))
      syncError("ACCOUNT_SCOPE_MISMATCH", 400);
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
          connection.accessState === "BLOCKED")
        syncError("ACCOUNT_SCOPE_MISMATCH");
      if (inserted.count === 1) await writeSecurityAudit(tx, {
        actorType: actorUserId ? SecurityAuditActorType.USER : SecurityAuditActorType.SYSTEM,
        actorUserId,
        action: "SOURCE_CONNECTION_CREATED", targetType: "SOURCE_CONNECTION",
        targetId: connection.id, result: SecurityAuditResult.SUCCESS,
        afterJson: { provider: SourceProvider.CAFE24, externalAccountId: mallId,
          shopKey, enabled: false, purpose: "CAFE24_06_TEST" }
      });
      return publicConnection(connection);
    }, { timeout: 5_000 });
  }

  async create(input: ConnectionInput, actorUserId: string) {
    assertSourceAdministrationEnabled();
    validateAccountKey(input.provider, input.externalAccountId, input.shopKey);
    if (!accountAllowlist().has(accountKey(input.provider, input.externalAccountId, input.shopKey))) {
      syncError("ACCOUNT_SCOPE_MISMATCH", 400);
    }
    if (!/^[A-Za-z][A-Za-z0-9_+\/-]{1,127}$/.test(input.timeZone)) syncError("TIMEZONE_MISMATCH", 400);
    try { new Intl.DateTimeFormat("en-US", { timeZone: input.timeZone }); }
    catch { syncError("TIMEZONE_MISMATCH", 400); }
    if ((input.provider === "CAFE24" || input.provider === "GOOGLE") && input.currencyCode !== "KRW") {
      syncError("CURRENCY_MISMATCH", 400);
    }
    if (input.provider === "META" && input.currencyCode !== "USD") syncError("CURRENCY_MISMATCH", 400);
    return this.prisma.$transaction(async (tx) => {
      const connection = await tx.sourceConnection.create({ data: {
        provider: input.provider, externalAccountId: input.externalAccountId,
        shopKey: input.shopKey, displayName: input.displayName,
        currencyCode: input.currencyCode, timeZone: input.timeZone,
        enabled: false, accessState: "PENDING"
      } });
      await writeSecurityAudit(tx, {
        actorType: SecurityAuditActorType.USER, actorUserId,
        action: "SOURCE_CONNECTION_CREATED", targetType: "SOURCE_CONNECTION", targetId: connection.id,
        result: SecurityAuditResult.SUCCESS,
        afterJson: { provider: input.provider, externalAccountId: input.externalAccountId,
          shopKey: input.shopKey, enabled: false }
      });
      return publicConnection(connection);
    }, { timeout: 5_000 });
  }

  async list(limit = 50, page = 1) {
    assertSourceAdministrationEnabled();
    const rows = await this.prisma.sourceConnection.findMany({
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * limit, take: limit + 1
    });
    return { items: rows.slice(0, limit).map(publicConnection),
      nextPage: rows.length > limit ? page + 1 : null };
  }

  async setPolicy(connectionId: string, input: PolicyInput, actorUserId: string) {
    assertEnabled();
    const fromDate = parseIsoDate(input.fromDate);
    // Provider adapters and shadow reconciliation are later-stage gates.
    // This foundation cannot approve API as primary from an HTTP request.
    if (input.primarySource === SourceKind.API) syncError("SOURCE_SELECTION_REQUIRED");
    if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(input.reason)) syncError("SOURCE_SELECTION_REQUIRED", 400);
    return this.prisma.$transaction(async (tx) => {
      const connection = await tx.sourceConnection.findUnique({ where: { id: connectionId } });
      if (!connection) throw new NotFoundException();
      if (!accountAllowlist().has(accountKey(connection.provider, connection.externalAccountId, connection.shopKey)) ||
          !KINDS_BY_PROVIDER[connection.provider].includes(input.dataKind)) syncError("ACCOUNT_SCOPE_MISMATCH");
      // This parent lock is the same serialization point used by the overlap
      // trigger and publish path. PostgreSQL's default READ COMMITTED is required.
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "source_connections"
        WHERE "id" = ${connectionId}::uuid FOR UPDATE`);
      const current = await tx.sourcePolicy.findFirst({ where: {
        connectionId, dataKind: input.dataKind, toDate: null
      } });
      if ((current?.version ?? 0) !== input.expectedVersion) syncError("SOURCE_SELECTION_REQUIRED");
      if (current && fromDate <= current.fromDate) syncError("SOURCE_SELECTION_REQUIRED", 400);
      // Legacy CSV rows have no account owner. Publishing a policy over their
      // dates would hide them from account-aware reads before reviewed binding.
      const unboundCurrent = input.dataKind === SourceDataKind.CAFE24_ORDER
        ? await tx.cafe24OrderLine.findFirst({ where: {
          connectionId: null, source: SourceKind.CSV, isCurrent: true,
          OR: [{ orderDate: null }, { orderDate: { gte: fromDate } }]
        }, select: { id: true } })
        : input.dataKind === SourceDataKind.META_ADSET
          ? await tx.metaAdsetDailyMetric.findFirst({ where: {
            connectionId: null, source: SourceKind.CSV, isCurrent: true,
            metricDate: { gte: fromDate }
          }, select: { id: true } })
          : input.dataKind === SourceDataKind.META_AD
            ? await tx.metaAdDailyMetric.findFirst({ where: {
              connectionId: null, source: SourceKind.CSV, isCurrent: true,
              metricDate: { gte: fromDate }
            }, select: { id: true } })
            : null;
      if (unboundCurrent) syncError("SOURCE_SELECTION_REQUIRED");
      if (current) await tx.sourcePolicy.update({ where: { id: current.id }, data: { toDate: fromDate } });
      const policy = await tx.sourcePolicy.create({ data: {
        connectionId, dataKind: input.dataKind, fromDate, toDate: null,
        primarySource: input.primarySource, version: input.expectedVersion + 1,
        changedByUserId: actorUserId, reason: input.reason.trim()
      } });
      await writeSecurityAudit(tx, {
        actorType: SecurityAuditActorType.USER, actorUserId,
        action: "SOURCE_POLICY_CHANGED", targetType: "SOURCE_POLICY", targetId: policy.id,
        result: SecurityAuditResult.SUCCESS,
        beforeJson: current ? { version: current.version, primarySource: current.primarySource,
          fromDate: current.fromDate.toISOString().slice(0, 10) } : undefined,
        afterJson: { version: policy.version, primarySource: policy.primarySource,
          fromDate: policy.fromDate.toISOString().slice(0, 10) }
      });
      return policy;
    }, { timeout: 5_000 });
  }

  /** Explicit, reviewed one-day activation after a complete API shadow publish.
   * Not exposed by the HTTP policy route. The connection lock serializes uploads,
   * API writes, and policy changes so a failed transaction leaves CSV primary. */
  async activateCafe24Day(connectionId: string, input: {
    day: string; expectedPolicyVersion: number; expectedSuccessRunId: string;
    reason: string;
    mode?: "CSV_REVIEWED" | "API_ONLY";
    couponInputSource?: "UNKNOWN" | "API_ACTUAL_PRODUCT_PLUS_SHIPPING";
    expectedSnapshotDigest?: string;
    expectedOptionPrefixWhitespaceLines?: number;
    expectedMappingChangeLines?: number;
    expectedInputDifferences?: { totalOrderOrders: number; paidOrders: number;
      paymentMethodOrders: number; couponSignalOrders: number;
      productNameOrders?: number };
  }, actorUserId: string | null) {
    assertEnabled();
    const scheduledActivation = actorUserId === null;
    if (scheduledActivation
      ? process.env.DAILY_SYNC_CAFE24_SCHEDULED_API_ONLY_ACTIVATION_ENABLED !== "true"
      : process.env.DAILY_SYNC_CAFE24_DAY_ACTIVATION_ENABLED !== "true")
      syncError("SOURCE_SELECTION_REQUIRED");
    const day = parseIsoDate(input.day);
    const today = formatInTimeZone(new Date(), "Asia/Seoul", "yyyy-MM-dd");
    if (input.day >= today || !Number.isSafeInteger(input.expectedPolicyVersion) ||
        input.expectedPolicyVersion < 1 ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
          .test(input.expectedSuccessRunId) ||
        (actorUserId !== null && !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
          .test(actorUserId)) ||
        !/^[A-Z][A-Z0-9_]{2,63}$/.test(input.reason))
      syncError("SOURCE_SELECTION_REQUIRED", 400);
    const mode = input.mode ?? "CSV_REVIEWED";
    const couponInputSource = input.couponInputSource ?? "UNKNOWN";
    if ((mode !== "CSV_REVIEWED" && mode !== "API_ONLY") ||
        (couponInputSource !== "UNKNOWN" &&
          couponInputSource !== "API_ACTUAL_PRODUCT_PLUS_SHIPPING"))
      syncError("SOURCE_SELECTION_REQUIRED", 400);
    if (scheduledActivation && (mode !== "API_ONLY" ||
        input.reason !== "CAFE24_SCHEDULED_API_ONLY" ||
        process.env.DAILY_SYNC_CAFE24_SCHEDULED_COUPON_INPUT_SOURCE !== couponInputSource))
      syncError("SOURCE_SELECTION_REQUIRED");
    if (!scheduledActivation && (!/^[a-f0-9]{64}$/.test(input.expectedSnapshotDigest ?? "") ||
        (mode === "CSV_REVIEWED" && !input.expectedInputDifferences)))
      syncError("SOURCE_SELECTION_REQUIRED", 400);
    const expectedSpaces = input.expectedOptionPrefixWhitespaceLines ?? 0;
    const expectedMappingChanges = input.expectedMappingChangeLines ?? 0;
    if (![expectedSpaces, expectedMappingChanges].every((count) =>
        Number.isSafeInteger(count) && count >= 0 && count <= 10_000) ||
        ((expectedSpaces > 0 || expectedMappingChanges > 0) &&
          (scheduledActivation || mode !== "CSV_REVIEWED")))
      syncError("SOURCE_SELECTION_REQUIRED", 400);
    const next = new Date(day); next.setUTCDate(next.getUTCDate() + 1);
    return this.prisma.$transaction(async (tx) => {
      const connection = await tx.sourceConnection.findUnique({ where: { id: connectionId } });
      if (!connection || connection.provider !== SourceProvider.CAFE24 ||
          connection.currencyCode !== "KRW" || connection.timeZone !== "Asia/Seoul" ||
          !accountAllowlist().has(accountKey(connection.provider,
            connection.externalAccountId, connection.shopKey)))
        syncError("ACCOUNT_SCOPE_MISMATCH");
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "source_connections"
        WHERE "id" = ${connectionId}::uuid FOR UPDATE`);
      if (!scheduledActivation && input.expectedSnapshotDigest !==
          await computeCafe24ActivationEvidence(tx, connectionId, input.day,
            { mode, couponInputSource }))
        rejectCafe24Activation("CAFE24_ACTIVATION_SNAPSHOT_CHANGED");
      const policies = await tx.sourcePolicy.findMany({ where: {
        connectionId, dataKind: SourceDataKind.CAFE24_ORDER,
        fromDate: { lte: day }, OR: [{ toDate: null }, { toDate: { gt: day } }]
      } });
      if (policies.length !== 1 || policies[0].primarySource !== SourceKind.CSV ||
          policies[0].version !== input.expectedPolicyVersion)
        rejectCafe24Activation("CAFE24_ACTIVATION_POLICY_STATE");
      const current = policies[0];
      const coverage = await tx.sourceCoverage.findUnique({ where: {
        connectionId_dataKind_metricDate: { connectionId,
          dataKind: SourceDataKind.CAFE24_ORDER, metricDate: day }
      } });
      if (!coverage || coverage.source !== SourceKind.API ||
          (coverage.state !== SourceCoverageState.COMPLETE_ZERO &&
            coverage.state !== SourceCoverageState.COMPLETE_NONZERO) ||
          coverage.lastSuccessRunId !== input.expectedSuccessRunId ||
          coverage.lastAttemptRunId !== input.expectedSuccessRunId ||
          !coverage.lastSuccessAt || !Number.isSafeInteger(coverage.rowCount) ||
          (coverage.rowCount ?? -1) < 0 ||
          !coverage.warningCodes.includes("CAFE24_SHADOW_NOT_PRIMARY"))
        rejectCafe24Activation("CAFE24_ACTIVATION_COVERAGE_STATE");
      const run = await tx.syncRun.findUnique({ where: { id: input.expectedSuccessRunId } });
      const unit = await tx.runUnit.findUnique({ where: { runId_unitKey: {
        runId: input.expectedSuccessRunId, unitKey: input.day }
      } });
      if (!run || run.connectionId !== connectionId || run.status !== SyncRunStatus.SUCCEEDED ||
          run.fromDate.getTime() !== day.getTime() || run.toDate.getTime() !== day.getTime() ||
          unit?.status !== "SUCCEEDED" || unit.publishedCount !== coverage.rowCount)
        rejectCafe24Activation("CAFE24_ACTIVATION_RUN_STATE");
      if (scheduledActivation && run.trigger !== "SCHEDULED")
        rejectCafe24Activation("CAFE24_ACTIVATION_RUN_STATE");
      const where = { connectionId, orderDate: day, isCurrent: true };
      const [apiRows, csvDatedRows, csvUndatedRows, apiVersions, unboundCsv] = await Promise.all([
        tx.cafe24OrderLine.findMany({ where: { ...where, source: SourceKind.API },
          select: { id: true, orderLineKey: true, orderNo: true, lineOrderNo: true,
            productNo: true, productName: true, optionName: true, quantity: true, salePriceKrw: true,
            totalOrderKrw: true, totalPaidKrw: true, totalPaidInputSource: true,
            paymentMethod: true, orderedAt: true,
            providerPaymentCodes: true, providerCouponSignal: true,
            actualOrderPriceKrw: true, actualPaymentKrw: true, actualShippingFeeKrw: true,
            initialOrderPriceKrw: true, initialPaymentKrw: true, initialShippingFeeKrw: true,
            productId: true, cafe24ProductRuleId: true, matchSource: true,
            validationStatus: true, importVersion: true, syncRunId: true } }),
        tx.cafe24OrderLine.findMany({ where: { ...where, source: SourceKind.CSV },
          select: { id: true, importVersion: true, orderLineKey: true, orderNo: true, lineOrderNo: true,
            productNo: true, productName: true, optionName: true, quantity: true, salePriceKrw: true,
            totalOrderKrw: true, totalPaidKrw: true, paymentMethod: true,
            productId: true, cafe24ProductRuleId: true, matchSource: true,
            validationStatus: true } }),
        tx.cafe24OrderLine.findMany({ where: { connectionId, source: SourceKind.CSV,
          orderDate: null, isCurrent: true }, take: 101,
          select: { id: true, importVersion: true, orderLineKey: true, orderNo: true,
            lineOrderNo: true, productNo: true, productName: true, optionName: true,
            quantity: true, salePriceKrw: true, totalOrderKrw: true,
            totalPaidKrw: true, paymentMethod: true,
            productId: true, cafe24ProductRuleId: true, matchSource: true,
            validationStatus: true } }),
        tx.cafe24OrderApiVersion.findMany({ where: { connectionId, orderDate: day,
          isCurrent: true }, select: { canonicalKeyHash: true, version: true,
          orderNo: true, lineOrderNo: true, productNo: true, optionName: true,
          quantity: true, salePriceKrw: true, totalOrderKrw: true,
          totalPaidKrw: true, totalPaidInputSource: true,
          paymentMethod: true, orderedAt: true, fetchedAt: true,
          providerPaymentCodes: true, providerCouponSignal: true,
          actualOrderPriceKrw: true, actualPaymentKrw: true, actualShippingFeeKrw: true,
          initialOrderPriceKrw: true, initialPaymentKrw: true, initialShippingFeeKrw: true,
          contentFingerprint: true, fingerprintKeyVersion: true } }),
        tx.cafe24OrderLine.count({ where: { connectionId: null, source: SourceKind.CSV,
          OR: [{ orderDate: day }, { orderDate: null }], isCurrent: true } })
      ]);
      // CSV stores a colon key while API stores a JSON key including connectionId.
      // Their current source links share this semantic SHA-256 business key.
      const keyParts = (row: typeof apiRows[number] | typeof csvDatedRows[number]) =>
        [connectionId, row.orderNo, row.lineOrderNo, row.productNo, row.optionName]
          .map((part) => part.trim());
      const semanticHash = (row: typeof apiRows[number] | typeof csvDatedRows[number]) =>
        createHash("sha256").update(JSON.stringify(keyParts(row))).digest("hex");
      const apiHashes = apiRows.map(semanticHash);
      const apiHashSet = new Set(apiHashes);
      if (csvUndatedRows.length > 100)
        rejectCafe24Activation("CAFE24_ACTIVATION_ROW_CARDINALITY");
      const currentUndated = csvUndatedRows.filter((row) => apiHashSet.has(semanticHash(row)) ||
        (expectedSpaces > 0 && apiRows.some((api) => cafe24ProductPrefixSpaceDifference(api, row))));
      const unresolvedUndated = csvUndatedRows.filter((row) => !currentUndated.includes(row));
      if (unresolvedUndated.length) {
        // A prior CSV_REVIEWED activation can bind a legacy blank-date CSV
        // line to a complete API day without changing that original CSV date.
        // Its current policy, coverage, line, version and both links must still
        // be sound. An unreviewed blank date continues to block activation.
        const historic = await tx.cafe24OrderLine.findMany({ where: {
          connectionId, source: SourceKind.API, isCurrent: true,
          orderDate: { lt: day },
          orderNo: { in: [...new Set(unresolvedUndated.map((row) => row.orderNo))] }
        }, take: 10_001 });
        const historicByHash = new Map<string, typeof historic>();
        for (const row of historic) {
          const hash = semanticHash(row);
          const bucket = historicByHash.get(hash) ?? [];
          bucket.push(row);
          historicByHash.set(hash, bucket);
        }
        for (const csv of unresolvedUndated) {
          const hash = semanticHash(csv);
          const exactCandidates = historicByHash.get(hash) ?? [];
          const candidates = exactCandidates.length ? exactCandidates :
            historic.filter((api) => cafe24ProductPrefixSpaceDifference(api, csv));
          if (candidates.length !== 1 || !candidates[0].orderDate)
            rejectCafe24Activation("CAFE24_ACTIVATION_UNDATED_CSV_UNREVIEWED");
          const historicDay = candidates[0].orderDate;
          const [visible, historicCoverage, csvLink, apiLink, reviewedAudit] = await Promise.all([
            selectCurrentSourceRows(tx, SourceDataKind.CAFE24_ORDER,
              [candidates[0]], (row) => row.orderDate),
            tx.sourceCoverage.findUnique({ where: { connectionId_dataKind_metricDate: {
              connectionId, dataKind: SourceDataKind.CAFE24_ORDER, metricDate: historicDay
            } } }),
            tx.sourceRecordLink.findFirst({ where: { connectionId,
              dataKind: SourceDataKind.CAFE24_ORDER, source: SourceKind.CSV,
              recordTable: "cafe24_order_lines", recordId: csv.id,
              canonicalKeyHash: hash, version: csv.importVersion, isCurrent: true } }),
            tx.sourceRecordLink.findFirst({ where: { connectionId,
              dataKind: SourceDataKind.CAFE24_ORDER, source: SourceKind.API,
              recordTable: "cafe24_order_lines", recordId: candidates[0].id,
              canonicalKeyHash: semanticHash(candidates[0]), version: candidates[0].importVersion,
              isCurrent: true } }),
            tx.securityAuditEvent.findFirst({ where: {
              action: "SOURCE_POLICY_CHANGED", targetType: "SOURCE_POLICY",
              result: SecurityAuditResult.SUCCESS,
              AND: [
                { afterJson: { path: ["day"], equals: historicDay.toISOString().slice(0, 10) } },
                { afterJson: { path: ["connectionId"], equals: connectionId } }
              ]
            }, orderBy: { createdAt: "desc" }, select: { afterJson: true } })
          ]);
          const after = reviewedAudit?.afterJson && typeof reviewedAudit.afterJson === "object" &&
            !Array.isArray(reviewedAudit.afterJson)
            ? reviewedAudit.afterJson as Record<string, unknown> : null;
          const approved = after?.undatedCsvBindings;
          const approvedBinding = csvLink && Array.isArray(approved) ? approved.find((entry) => {
            if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
            const candidate = entry as Record<string, unknown>;
            if (!Number.isSafeInteger(candidate.fingerprintKeyVersion)) return false;
            try {
              const binding = cafe24UndatedCsvBinding(connectionId, csv, csvLink,
                candidate.fingerprintKeyVersion as number);
              return Object.keys(candidate).length === Object.keys(binding).length &&
                candidate.recordId === binding.recordId &&
                candidate.importVersion === binding.importVersion &&
                candidate.linkId === binding.linkId &&
                candidate.fingerprintKeyVersion === binding.fingerprintKeyVersion &&
                candidate.fingerprint === binding.fingerprint;
            } catch {
              // An unavailable historical observation key cannot approve a CSV binding.
              return false;
            }
          }) : null;
          const prefixBindings = after?.optionPrefixWhitespaceBindings;
          const approvedPrefix = semanticHash(candidates[0]) === hash ||
            (cafe24ProductPrefixSpaceDifference(candidates[0], csv) &&
              Array.isArray(prefixBindings) && prefixBindings.some((entry) => {
                if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
                const binding = entry as Record<string, unknown>;
                return binding.csvRecordId === csv.id && binding.csvLinkId === csvLink?.id &&
                  binding.csvVersion === csv.importVersion &&
                  binding.apiCanonicalKeyHash === semanticHash(candidates[0]);
              }));
          if (visible.length !== 1 || !historicCoverage || !csvLink || !apiLink || !approvedPrefix ||
              historicCoverage.reconciliationStatus !== "CSV_API_INPUTS_REVIEWED" &&
              historicCoverage.reconciliationStatus !== "CSV_API_PARITY_VERIFIED" ||
              after?.sourceChoice !== "CSV_REVIEWED" || !approvedBinding)
            rejectCafe24Activation("CAFE24_ACTIVATION_UNDATED_CSV_UNREVIEWED");
        }
      }
      const csvRows = [...csvDatedRows, ...currentUndated];
      const csvByHash = new Map(csvRows.map((row) => [semanticHash(row), row]));
      const csvByStableKey = new Map(csvRows.map((row) => [cafe24StableItemKey(row), row]));
      if (expectedSpaces > 0 && (csvByStableKey.size !== csvRows.length ||
          new Set(apiRows.map(cafe24StableItemKey)).size !== apiRows.length))
        rejectCafe24Activation("CAFE24_ACTIVATION_ROW_CARDINALITY");
      const csvForApiHash = new Map(apiRows.flatMap((api) => {
        const hash = semanticHash(api);
        const exact = csvByHash.get(hash);
        const candidate = csvByStableKey.get(cafe24StableItemKey(api));
        const csv = exact ?? (expectedSpaces > 0 && candidate &&
          cafe24ProductPrefixSpaceDifference(api, candidate) ? candidate : undefined);
        return csv ? [[hash, csv] as const] : [];
      }));
      const allHashes = [...new Set([...apiHashes, ...csvByHash.keys()])];
      const versionByHash = new Map(apiVersions.map((row) => [row.canonicalKeyHash, row]));
      const [apiLinks, csvLinks] = await Promise.all([SourceKind.API, SourceKind.CSV]
        .map((source) => tx.sourceRecordLink.findMany({ where: { connectionId,
          dataKind: SourceDataKind.CAFE24_ORDER, source,
          isCurrent: true, recordTable: "cafe24_order_lines",
          canonicalKeyHash: { in: allHashes } },
          select: { id: true, recordId: true, canonicalKeyHash: true, version: true } })));
      const apiLinkByRecordId = new Map(apiLinks.map((link) => [link.recordId, link]));
      const csvLinkByRecordId = new Map(csvLinks.map((link) => [link.recordId, link]));
      if (csvUndatedRows.length > 100 ||
          (mode === "API_ONLY" ? csvRows.length !== 0 : csvRows.length === 0) ||
          apiRows.length !== coverage.rowCount || apiVersions.length !== apiRows.length ||
          apiLinks.length !== apiRows.length || csvLinks.length !== csvRows.length ||
          (mode === "CSV_REVIEWED" && csvRows.length !== apiRows.length) ||
          new Set(apiHashes).size !== apiRows.length || csvByHash.size !== csvRows.length ||
          versionByHash.size !== apiVersions.length ||
          apiLinkByRecordId.size !== apiLinks.length || csvLinkByRecordId.size !== csvLinks.length ||
          unboundCsv !== 0 || apiRows.length > 10_000)
        rejectCafe24Activation("CAFE24_ACTIVATION_ROW_CARDINALITY");
      const amountEqual = (left: Prisma.Decimal | null | undefined,
        right: Prisma.Decimal | null | undefined) =>
        left == null || right == null ? left == null && right == null : left.equals(right);
      const validMappingState = (row: Pick<typeof apiRows[number],
        "validationStatus" | "matchSource" | "productId" | "cafe24ProductRuleId">) =>
        (row.validationStatus === RowValidationStatus.VALID &&
          row.matchSource === MatchSource.RULE && !!row.productId && !!row.cafe24ProductRuleId) ||
        (row.validationStatus === RowValidationStatus.UNMATCHED &&
          row.matchSource === MatchSource.UNMATCHED &&
          row.productId === null && row.cafe24ProductRuleId === null);
      const sameRawBusinessIdentity = (left: typeof apiRows[number], right: typeof csvRows[number]) =>
        left.orderNo === right.orderNo && left.lineOrderNo === right.lineOrderNo &&
        left.productNo === right.productNo && (left.optionName === right.optionName ||
          expectedSpaces > 0 && cafe24ProductPrefixSpaceDifference(left, right));
      const sameMappingInput = (left: Pick<typeof apiRows[number],
        "productId" | "cafe24ProductRuleId" | "matchSource" | "validationStatus">,
        right: Pick<typeof apiRows[number], "productId" | "cafe24ProductRuleId" | "matchSource" | "validationStatus">) =>
        left.productId === right.productId &&
        left.cafe24ProductRuleId === right.cafe24ProductRuleId &&
        left.matchSource === right.matchSource &&
        left.validationStatus === right.validationStatus;
      const differences = { totalOrderOrders: new Set<string>(), paidOrders: new Set<string>(),
        paymentMethodOrders: new Set<string>(), couponSignalOrders: new Set<string>(),
        productNameOrders: new Set<string>() };
      const matcherRules = expectedMappingChanges > 0 ? await loadCafe24MatcherRules(tx) : [];
      const matcher = new Cafe24ProductMatcher();
      type Mapping = Pick<typeof apiRows[number], "productId" | "cafe24ProductRuleId" |
        "matchSource" | "validationStatus">;
      const mappingChanges: Array<{ id: string; mapping: Mapping }> = [];
      const optionPrefixWhitespaceBindings: Array<{ csvRecordId: string; csvLinkId: string;
        csvVersion: number; apiCanonicalKeyHash: string }> = [];
      for (const row of apiRows) {
        if (!validMappingState(row) ||
            row.totalPaidInputSource !== "ORDERS_PAYMENT_AMOUNT")
          rejectCafe24Activation("CAFE24_ACTIVATION_API_MAPPING_STATE");
        const hash = semanticHash(row);
        const csv = csvForApiHash.get(hash);
        const version = versionByHash.get(hash);
        const link = apiLinkByRecordId.get(row.id);
        const csvLink = csv && csvLinkByRecordId.get(csv.id);
        if (mode === "CSV_REVIEWED" && !csv)
          rejectCafe24Activation("CAFE24_ACTIVATION_ROW_CARDINALITY");
        if (mode === "CSV_REVIEWED" && csv && !sameRawBusinessIdentity(row, csv))
          rejectCafe24Activation("CAFE24_ACTIVATION_CSV_RAW_INPUT");
        if (mode === "CSV_REVIEWED" && csv && row.productName !== csv.productName)
          differences.productNameOrders.add(row.orderNo);
        if (mode === "CSV_REVIEWED" && csv && !row.quantity.equals(csv.quantity))
          rejectCafe24Activation("CAFE24_ACTIVATION_CSV_QUANTITY");
        if (mode === "CSV_REVIEWED" && csv && !row.salePriceKrw.equals(csv.salePriceKrw))
          rejectCafe24Activation("CAFE24_ACTIVATION_CSV_SALE_PRICE");
        let reviewedMapping: Mapping = row;
        if (expectedMappingChanges > 0) {
          const match = matcher.match({ productNo: row.productNo, productName: row.productName,
            optionName: row.optionName, orderDate: day }, matcherRules);
          reviewedMapping = { productId: match.productId, cafe24ProductRuleId: match.matchRuleId,
            matchSource: match.productId ? MatchSource.RULE : MatchSource.UNMATCHED,
            validationStatus: match.productId ? RowValidationStatus.VALID : RowValidationStatus.UNMATCHED };
          if (!sameMappingInput(reviewedMapping, row))
            mappingChanges.push({ id: row.id, mapping: reviewedMapping });
        }
        if (mode === "CSV_REVIEWED" && csv &&
            (!validMappingState(csv) || !sameMappingInput(reviewedMapping, csv)))
          rejectCafe24Activation("CAFE24_ACTIVATION_CSV_MAPPING_STATE");
        if (mode === "CSV_REVIEWED" && csv &&
            (!csvLink || csvLink.canonicalKeyHash !== semanticHash(csv) ||
              csvLink.version !== csv.importVersion ||
              csv.orderLineKey !== [csv.orderNo, csv.lineOrderNo,
                csv.productNo, csv.optionName].map((part) => part.trim()).join(":")))
          rejectCafe24Activation("CAFE24_ACTIVATION_CSV_LINK");
        if (csv && csvLink && cafe24ProductPrefixSpaceDifference(row, csv))
          optionPrefixWhitespaceBindings.push({ csvRecordId: csv.id, csvLinkId: csvLink.id,
            csvVersion: csv.importVersion, apiCanonicalKeyHash: hash });
        if (!version || !link ||
            row.orderLineKey !== JSON.stringify(keyParts(row)) ||
            link.canonicalKeyHash !== hash || link.version !== version.version ||
            row.importVersion !== version.version ||
            !version.fetchedAt || version.fetchedAt > coverage.lastSuccessAt ||
            !/^[a-f0-9]{64}$/.test(version.contentFingerprint ?? "") ||
            !Number.isSafeInteger(version.fingerprintKeyVersion) ||
            version.fingerprintKeyVersion! < 1 ||
            !version.quantity.equals(row.quantity) ||
            !version.salePriceKrw.equals(row.salePriceKrw) ||
            !amountEqual(version.totalOrderKrw, row.totalOrderKrw) ||
            !version.totalPaidKrw.equals(row.totalPaidKrw) ||
            version.totalPaidInputSource !== row.totalPaidInputSource ||
            version.paymentMethod !== row.paymentMethod ||
            JSON.stringify(version.providerPaymentCodes ?? null) !==
              JSON.stringify(row.providerPaymentCodes ?? null) ||
            version.providerCouponSignal !== row.providerCouponSignal ||
            !amountEqual(version.actualOrderPriceKrw, row.actualOrderPriceKrw) ||
            !amountEqual(version.actualPaymentKrw, row.actualPaymentKrw) ||
            !amountEqual(version.actualShippingFeeKrw, row.actualShippingFeeKrw) ||
            !amountEqual(version.initialOrderPriceKrw, row.initialOrderPriceKrw) ||
            !amountEqual(version.initialPaymentKrw, row.initialPaymentKrw) ||
            !amountEqual(version.initialShippingFeeKrw, row.initialShippingFeeKrw) ||
            row.orderedAt === null || version.orderedAt.getTime() !== row.orderedAt.getTime() ||
            version.orderNo !== row.orderNo || version.lineOrderNo !== row.lineOrderNo ||
            version.productNo !== row.productNo || version.optionName !== row.optionName)
          rejectCafe24Activation("CAFE24_ACTIVATION_API_VERSION_LINK");
        if (csv) {
          if (!amountEqual(row.totalOrderKrw, csv.totalOrderKrw))
            differences.totalOrderOrders.add(row.orderNo);
          if (!row.totalPaidKrw.equals(csv.totalPaidKrw))
            differences.paidOrders.add(row.orderNo);
          if (row.paymentMethod !== csv.paymentMethod)
            differences.paymentMethodOrders.add(row.orderNo);
          if (row.providerCouponSignal !== hasCafe24CouponPaymentToken(csv.paymentMethod))
            differences.couponSignalOrders.add(row.orderNo);
        }
      }
      if (optionPrefixWhitespaceBindings.length !== expectedSpaces ||
          mappingChanges.length !== expectedMappingChanges)
        rejectCafe24Activation("CAFE24_ACTIVATION_INPUT_DIFFERENCE_REVIEW");
      const differenceCounts = Object.fromEntries(Object.entries(differences)
        .map(([kind, orders]) => [kind, orders.size]));
      const undatedCsvBindings = currentUndated.map((row) => {
        const link = csvLinkByRecordId.get(row.id);
        if (!link) rejectCafe24Activation("CAFE24_ACTIVATION_CSV_LINK");
        return cafe24UndatedCsvBinding(connectionId, row, link);
      });
      if (mode === "CSV_REVIEWED" &&
          Object.entries(differenceCounts).some(([kind, count]) =>
            count !== (input.expectedInputDifferences?.[kind as keyof typeof differences] ?? 0)))
        rejectCafe24Activation("CAFE24_ACTIVATION_INPUT_DIFFERENCE_REVIEW");
      if (mode === "API_ONLY" && input.expectedInputDifferences)
        rejectCafe24Activation("CAFE24_ACTIVATION_INPUT_DIFFERENCE_REVIEW");
      // Apply mapping metadata only after every raw input, version/link,
      // protected snapshot and explicit review count has passed. Any failure
      // rolls back both these updates and the one-day source-policy change.
      const mappingGroups = new Map<string, { ids: string[]; mapping: Mapping }>();
      for (const change of mappingChanges) {
        const key = JSON.stringify(change.mapping);
        const group = mappingGroups.get(key) ?? { ids: [], mapping: change.mapping };
        group.ids.push(change.id); mappingGroups.set(key, group);
      }
      for (const group of mappingGroups.values()) {
        const updated = await tx.cafe24OrderLine.updateMany({ where: {
          id: { in: group.ids }, connectionId, source: SourceKind.API, isCurrent: true
        }, data: group.mapping });
        if (updated.count !== group.ids.length)
          rejectCafe24Activation("CAFE24_ACTIVATION_SNAPSHOT_CHANGED");
      }
      if (mappingChanges.length) await writeSecurityAudit(tx, {
        actorType: SecurityAuditActorType.USER, actorUserId,
        action: "CAFE24_MAPPING_REMATCH", targetType: "SOURCE_CONNECTION", targetId: connectionId,
        result: SecurityAuditResult.SUCCESS,
        afterJson: { day: input.day, source: SourceKind.API,
          rematchedLineCount: mappingChanges.length, reason: input.reason }
      });
      const oldTo = current.toDate;
      const newVersion = current.version + 1;
      if (current.fromDate.getTime() < day.getTime()) {
        await tx.sourcePolicy.update({ where: { id: current.id }, data: { toDate: day } });
        await tx.sourcePolicy.create({ data: { connectionId,
          dataKind: SourceDataKind.CAFE24_ORDER, fromDate: day, toDate: next,
          primarySource: SourceKind.API, version: newVersion,
          couponInputSource,
          changedByUserId: actorUserId, reason: input.reason } });
      } else {
        await tx.sourcePolicy.update({ where: { id: current.id }, data: {
          toDate: next, primarySource: SourceKind.API, version: newVersion,
          couponInputSource,
          changedByUserId: actorUserId, reason: input.reason
        } });
      }
      if (!oldTo || oldTo > next) await tx.sourcePolicy.create({ data: {
        connectionId, dataKind: SourceDataKind.CAFE24_ORDER,
        fromDate: next, toDate: oldTo,
        primarySource: SourceKind.CSV, version: newVersion + 1,
        couponInputSource: scheduledActivation ? couponInputSource : current.couponInputSource,
        changedByUserId: actorUserId, reason: "CAFE24_CSV_REMAINS_PRIMARY"
      } });
      await tx.sourceCoverage.update({ where: { connectionId_dataKind_metricDate: {
        connectionId, dataKind: SourceDataKind.CAFE24_ORDER, metricDate: day
      } }, data: { reconciliationStatus: mode === "API_ONLY" ?
        "CAFE24_API_ONLY_VERIFIED" : "CSV_API_INPUTS_REVIEWED",
        warningCodes: coverage.warningCodes.filter((code) =>
          code !== "CAFE24_SHADOW_NOT_PRIMARY" &&
          code !== "CAFE24_SOURCE_ACTIVATION_REQUIRED") } });
      await writeSecurityAudit(tx, {
        actorType: scheduledActivation ? SecurityAuditActorType.SYSTEM : SecurityAuditActorType.USER,
        actorUserId,
        action: "SOURCE_POLICY_CHANGED", targetType: "SOURCE_POLICY",
        targetId: current.id, result: SecurityAuditResult.SUCCESS,
        beforeJson: { version: current.version, primarySource: SourceKind.CSV,
          day: input.day },
        afterJson: { version: newVersion, primarySource: SourceKind.API,
          connectionId, day: input.day, successRunId: input.expectedSuccessRunId,
          sourceChoice: mode, couponInputSource, undatedCsvBindings,
          optionPrefixWhitespaceBindings, rematchedApiLines: mappingChanges.length,
          inputDifferenceOrders: differenceCounts,
          displayFieldDifferenceReview: mode === "CSV_REVIEWED" &&
            differences.productNameOrders.size > 0 ? "DISPLAY_FIELD_DIFFERENCE_REVIEWED" : null }
      });
      return { day: input.day, primarySource: SourceKind.API, policyVersion: newVersion };
    }, { timeout: 15_000, maxWait: 2_000 });
  }
}

function publicConnection<T extends { credentialRef: string | null; [key: string]: unknown }>(connection: T) {
  const { credentialRef: _protectedRef, ...publicFields } = connection;
  return publicFields;
}
