import { BadRequestException, Injectable } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { formatInTimeZone } from "date-fns-tz";
import { MatchSource, Prisma, RowValidationStatus, SourceDataKind, SourceKind } from "@prisma/client";
import { PrismaService } from "../common/prisma.service";
import { Cafe24ProductMatcher, Cafe24RuleInput, normalizeProductNo } from "../domain/cafe24-matcher";
import { formatDateOnly } from "../domain/date-number";
import { assertNoUnboundCurrentRows } from "./canonical-write-policy";
import { SyncFoundationService } from "./sync-foundation.service";
import { assertCafe24AppVersionEvidence, assertCafe24SellerOptionsEvidence,
  assertCafe24OptionProjectionDayEvidence, assertCafe24RawAllItemsV1Evidence,
  verifiedCafe24V1Statuses, requiresCafe24RawAllItemsEvidence,
  syncError } from "./sync-contract";
import { cafe24ObservationKey } from "./cafe24-observed-revision";
import { cafe24CanonicalFingerprint } from "./cafe24-canonical-fingerprint";
import type { Cafe24ApiOrder } from "./cafe24-api-order";
import { cafe24ProviderCouponSignal } from "./cafe24-order-adapter";
import { cafe24OptionCompositionFits } from "./cafe24-option-projection";

type PublishHeader = {
  connectionId: string; runId: string; generation: bigint; metricDate: Date;
  pageCount: number; policyVersion: number; checkpointValue?: string | null;
};

@Injectable()
export class Cafe24CanonicalWriterService {
  private readonly cafe24Matcher = new Cafe24ProductMatcher();
  constructor(private readonly prisma: PrismaService,
    private readonly foundation: SyncFoundationService) {}

  /** Publish only a fully verified completed order day, including an explicit manual reread. */
  async publishCafe24Day(input: PublishHeader & {
    completeDaySnapshot: true; fetchedAt: Date; orders: Cafe24ApiOrder[];
  }) {
    assertCafe24AppVersionEvidence();
    const day = validDay(input.metricDate);
    if (day >= formatInTimeZone(new Date(), "Asia/Seoul", "yyyy-MM-dd"))
      invalid("Cafe24 order day must be completed in the mall time zone.");
    if (input.completeDaySnapshot !== true)
      invalid("Cafe24 coverage requires a complete orderDate snapshot.");
    if (!validTimestamp(input.fetchedAt) || input.fetchedAt > new Date() ||
        formatInTimeZone(input.fetchedAt, "Asia/Seoul", "yyyy-MM-dd") <= day)
      invalid("Cafe24 fetchedAt must be an observed completion time.");
    if (input.orders.length) assertCafe24OptionProjectionDayEvidence(day);
    const approvedStatuses = verifiedCafe24V1Statuses();
    const keys = new Set<string>();
    for (const row of input.orders) {
      if (row.optionName) assertCafe24SellerOptionsEvidence();
      if (validateCafe24Order(row) !== day) invalid("Cafe24 order date or timestamp is invalid.");
      if ([row.orderStatus, row.lineStatus].some((status) =>
          status != null && !approvedStatuses.has(status)))
        syncError("FIELD_UNSUPPORTED");
      if ([row.orderStatus, row.lineStatus].some(requiresCafe24RawAllItemsEvidence))
        assertCafe24RawAllItemsV1Evidence(day);
      const key = cafe24Key(input.connectionId, row);
      if (keys.has(key)) invalid("Duplicate Cafe24 line business key in one API unit.");
      keys.add(key);
    }
    // The foundation publishes rows, coverage, and run state in one fenced transaction.
    return this.foundation.publishCafe24Window({
      runId: input.runId, generation: input.generation, unitKey: day,
      windowDate: input.metricDate, checkpointValue: input.checkpointValue,
      daySnapshot: true,
      affectedDates: [{ orderDate: input.metricDate, policyVersion: input.policyVersion }],
      fetchedCount: input.orders.length, pageCount: input.pageCount, complete: true,
      writeRows: async (tx) => {
        await assertPublishScope(tx, input.runId, input.connectionId, "CAFE24", "KRW");
        await assertNoUnboundCurrentRows(tx, SourceDataKind.CAFE24_ORDER, [input.metricDate]);
        // A complete order-date snapshot cannot certify omission as deletion.
        // Fail before coverage/checkpoint changes on an omitted current key.
        // An operator must inspect the one day and explicitly retry it.
        const existing = await tx.cafe24OrderLine.findMany({
          where: { connectionId: input.connectionId, source: SourceKind.API,
            orderDate: input.metricDate, isCurrent: true },
          select: { orderLineKey: true }
        });
        if (existing.some((line) => !keys.has(line.orderLineKey)))
          invalid("Cafe24 day snapshot omitted a current order line; reconciliation is required.");
        await this.writeCafe24Rows(tx, input, input.orders, input.fetchedAt);
        return input.orders.length;
      }
    });
  }

  /** Retired with the one completed order-day policy. */
  async publishCafe24ChangedWindow(_input: Omit<PublishHeader, "metricDate" | "policyVersion"> & {
    windowDate: Date; windowStart: Date; windowEnd: Date; orders: Cafe24ApiOrder[];
    policyVersionsByOrderDate: Record<string, number>;
  }): Promise<never> {
    invalid("Cafe24 changed-window collection is retired; specify one completed order day.");
  }

  private async writeCafe24Rows(tx: Prisma.TransactionClient,
    input: Pick<PublishHeader, "connectionId" | "runId">, orders: Cafe24ApiOrder[],
    fetchedAt: Date | null = null) {
    const rules = await this.cafe24Rules(tx);
    const observation = fetchedAt && orders.length ? cafe24ObservationKey() : null;
    try {
    // The connection is already locked by the foundation. Load the selected
    // business keys once, then retain the existing per-row revision decisions.
    const keys = orders.map((row) => cafe24Key(input.connectionId, row));
    const hashes = keys.map(sha256);
    const priorRows = await tx.cafe24OrderApiVersion.findMany({ where: {
      connectionId: input.connectionId, canonicalKeyHash: { in: hashes }, isCurrent: true
    } });
    const latestRows = await tx.cafe24OrderApiVersion.groupBy({
      by: ["canonicalKeyHash"], where: { connectionId: input.connectionId, canonicalKeyHash: { in: hashes } },
      _max: { version: true }
    });
    const currentRows = await tx.cafe24OrderLine.findMany({ where: {
      connectionId: input.connectionId, source: SourceKind.API, orderLineKey: { in: keys }, isCurrent: true
    } });
    const currentLinks = await tx.sourceRecordLink.findMany({ where: {
      connectionId: input.connectionId, dataKind: SourceDataKind.CAFE24_ORDER,
      source: SourceKind.API, canonicalKeyHash: { in: hashes }, recordTable: "cafe24_order_lines", isCurrent: true
    } });
    const priors = new Map(priorRows.map((row) => [row.canonicalKeyHash, row]));
    const currents = new Map(currentRows.map((row) => [row.orderLineKey, row]));
    const links = new Map(currentLinks.map((row) => [row.canonicalKeyHash, row]));
    const latestVersions = new Map(latestRows.map((row) => [row.canonicalKeyHash, row._max.version ?? 0]));
    if (priors.size !== priorRows.length || currents.size !== currentRows.length || links.size !== currentLinks.length)
      invalid("Cafe24 current business keys are ambiguous.");
    const versions: Prisma.Cafe24OrderApiVersionCreateManyInput[] = [];
    const lines: Prisma.Cafe24OrderLineCreateManyInput[] = [];
    const newLinks: Prisma.SourceRecordLinkCreateManyInput[] = [];
    const demoteVersionIds: string[] = [], demoteLineIds: string[] = [], changedHashes: string[] = [];
    const superseded: { previous: string; next: string }[] = [];
    for (const row of orders) {
      const revisionAt = row.providerUpdatedAt;
      if (!fetchedAt && !revisionAt) invalid("Cafe24 provider revision is unavailable.");
      const productNo = normalizeProductNo(row.productNo);
      const key = cafe24Key(input.connectionId, row);
      const hash = sha256(key);
      const fingerprint = observation
        ? cafe24CanonicalFingerprint(observation.key, input.connectionId, row, productNo) : null;
      const prior = priors.get(hash);
      if (prior && prior.orderDate.getTime() !== row.orderDate.getTime())
        invalid("Cafe24 orderDate changed for an existing business key; reconciliation is required.");
      if (prior && fetchedAt) {
        const currentLine = currents.get(key);
        const currentLink = links.get(hash);
        if (!currentLine || !currentLink || currentLink.recordId !== currentLine.id ||
            currentLink.version !== prior.version ||
            !sameCafe24CurrentLine(currentLine, prior))
          invalid("Cafe24 current line/link does not match its observed version.");
        if (fingerprint && prior.contentFingerprint === fingerprint &&
            prior.fingerprintKeyVersion === observation?.version) {
          if (currentLine.productName !== row.productName)
            invalid("Cafe24 current product name does not match its observed fingerprint.");
          continue;
        }
        // A deliberate observation-key rotation or canonical serializer change
        // must not create a business revision when stored allowlisted content is equal.
        if (sameCafe24Version(prior, row, productNo) &&
            currentLine?.productName === row.productName) continue;
      }
      if (prior && revisionAt && prior.providerUpdatedAt &&
          prior.providerUpdatedAt.getTime() > revisionAt.getTime())
        invalid("Cafe24 provider revision regressed in a later observation.");
      if (prior && !fetchedAt && revisionAt && prior.providerUpdatedAt &&
          prior.providerUpdatedAt.getTime() >= revisionAt.getTime()) {
        if (prior.providerUpdatedAt.getTime() === revisionAt.getTime()) {
          const currentLine = currents.get(key);
          if (!sameCafe24Version(prior, row, productNo) ||
              currentLine?.productName !== row.productName)
            invalid("Cafe24 revision changed without updatedAt advancing.");
        }
        continue;
      }
      const match = this.cafe24Matcher.match({
        productNo, productName: row.productName, optionName: row.optionName, optionValue: row.optionValue,
        orderDate: row.orderDate
      }, rules);
      const version = (latestVersions.get(hash) ?? 0) + 1;
      if (prior) demoteVersionIds.push(prior.id);
      versions.push({
        id: randomUUID(),
        connectionId: input.connectionId, canonicalKeyHash: hash,
        orderNo: row.orderNo.trim(), lineOrderNo: row.lineOrderNo.trim(), productNo,
        optionName: row.optionName.trim(), optionValue: row.optionValue ?? null, orderedAt: row.orderedAt, orderDate: row.orderDate,
        providerUpdatedAt: revisionAt,
        fetchedAt, contentFingerprint: fingerprint,
        fingerprintKeyVersion: observation?.version ?? null,
        quantity: new Prisma.Decimal(row.quantity), salePriceKrw: new Prisma.Decimal(row.salePriceKrw),
        totalOrderKrw: optionalDecimal(row.totalOrderKrw), totalPaidKrw: new Prisma.Decimal(row.totalPaidKrw),
        totalPaidInputSource: row.totalPaidInputSource ?? null,
        paymentMethod: row.paymentMethod,
        providerPaymentCodes: row.providerPaymentCodes ?? Prisma.DbNull,
        providerCouponSignal: row.providerCouponSignal ?? null,
        actualOrderPriceKrw: optionalDecimal(row.actualOrderPriceKrw),
        actualPaymentKrw: optionalDecimal(row.actualPaymentKrw),
        actualShippingFeeKrw: optionalDecimal(row.actualShippingFeeKrw),
        initialOrderPriceKrw: optionalDecimal(row.initialOrderPriceKrw),
        initialPaymentKrw: optionalDecimal(row.initialPaymentKrw),
        initialShippingFeeKrw: optionalDecimal(row.initialShippingFeeKrw),
        orderStatus: row.orderStatus ?? null, lineStatus: row.lineStatus ?? null,
        cancelledAt: row.cancelledAt ?? null, cancelAmountKrw: optionalDecimal(row.cancelAmountKrw),
        refundedAt: row.refundedAt ?? null, refundAmountKrw: optionalDecimal(row.refundAmountKrw),
        discountAmountKrw: optionalDecimal(row.discountAmountKrw),
        couponAmountKrw: optionalDecimal(row.couponAmountKrw),
        version, isCurrent: true, syncRunId: input.runId
      });
      const current = currents.get(key), lineId = randomUUID();
      if (current) { demoteLineIds.push(current.id); superseded.push({ previous: current.id, next: lineId }); }
      lines.push({
        id: lineId,
        uploadBatchId: null, connectionId: input.connectionId, syncRunId: input.runId,
        source: SourceKind.API, providerUpdatedAt: revisionAt,
        rowNumber: null, sourceRowHash: null, orderLineKey: key,
        orderNo: row.orderNo.trim(), lineOrderNo: row.lineOrderNo.trim(), productNo,
        productName: row.productName, optionName: row.optionName.trim(), optionValue: row.optionValue ?? null,
        quantity: new Prisma.Decimal(row.quantity), salePriceKrw: new Prisma.Decimal(row.salePriceKrw),
        totalOrderKrw: optionalDecimal(row.totalOrderKrw), totalPaidKrw: new Prisma.Decimal(row.totalPaidKrw),
        totalPaidInputSource: row.totalPaidInputSource ?? null,
        paymentMethod: row.paymentMethod,
        providerPaymentCodes: row.providerPaymentCodes ?? Prisma.DbNull,
        providerCouponSignal: row.providerCouponSignal ?? null,
        actualOrderPriceKrw: optionalDecimal(row.actualOrderPriceKrw),
        actualPaymentKrw: optionalDecimal(row.actualPaymentKrw),
        actualShippingFeeKrw: optionalDecimal(row.actualShippingFeeKrw),
        initialOrderPriceKrw: optionalDecimal(row.initialOrderPriceKrw),
        initialPaymentKrw: optionalDecimal(row.initialPaymentKrw),
        initialShippingFeeKrw: optionalDecimal(row.initialShippingFeeKrw),
        orderedAt: row.orderedAt, orderDate: row.orderDate,
        productId: match.productId, cafe24ProductRuleId: match.matchRuleId,
        matchSource: match.source === "RULE" ? MatchSource.RULE : MatchSource.UNMATCHED,
        validationStatus: match.productId ? RowValidationStatus.VALID : RowValidationStatus.UNMATCHED,
        validationErrors: [], importVersion: version, isCurrent: true, rawRow: Prisma.DbNull
      });
      changedHashes.push(hash);
      newLinks.push({ id: randomUUID(), connectionId: input.connectionId,
        dataKind: SourceDataKind.CAFE24_ORDER, canonicalKeyHash: hash, source: SourceKind.API,
        recordTable: "cafe24_order_lines", recordId: lineId, syncRunId: input.runId,
        version, isCurrent: true, bindingMethod: "EXACT_ID" });
    }
    const batches = function* <T>(values: T[]) { for (let i = 0; i < values.length; i += 250) yield values.slice(i, i + 250); };
    for (const ids of batches(demoteVersionIds)) await tx.cafe24OrderApiVersion.updateMany({
      where: { connectionId: input.connectionId, id: { in: ids }, isCurrent: true }, data: { isCurrent: false }
    });
    for (const data of batches(versions)) await tx.cafe24OrderApiVersion.createMany({ data });
    for (const ids of batches(demoteLineIds)) await tx.cafe24OrderLine.updateMany({
      where: { connectionId: input.connectionId, source: SourceKind.API, id: { in: ids }, isCurrent: true }, data: { isCurrent: false }
    });
    for (const data of batches(lines)) await tx.cafe24OrderLine.createMany({ data });
    for (const pairs of batches(superseded)) await tx.$executeRaw(Prisma.sql`
      UPDATE "cafe24_order_lines" AS old SET "superseded_by_order_line_id"=replacement.next_id
      FROM (VALUES ${Prisma.join(pairs.map((pair) => Prisma.sql`(${pair.previous}::uuid,${pair.next}::uuid)`))}) AS replacement(previous_id,next_id)
      WHERE old.id=replacement.previous_id AND old.connection_id=${input.connectionId}::uuid AND old.source='API'
    `);
    for (const values of batches(changedHashes)) await tx.sourceRecordLink.updateMany({ where: {
      connectionId: input.connectionId, dataKind: SourceDataKind.CAFE24_ORDER, source: SourceKind.API,
      canonicalKeyHash: { in: values }, recordTable: "cafe24_order_lines", isCurrent: true
    }, data: { isCurrent: false } });
    for (const data of batches(newLinks)) await tx.sourceRecordLink.createMany({ data });
    } finally { observation?.key.fill(0); }
  }

  private async cafe24Rules(tx: Prisma.TransactionClient): Promise<Cafe24RuleInput[]> {
    const rows = await tx.cafe24ProductRule.findMany({
      where: { isActive: true, product: { is: { isActive: true } } },
      orderBy: [{ priority: "asc" }, { createdAt: "asc" }]
    });
    const strings = (value: Prisma.JsonValue) => Array.isArray(value)
      ? [...new Set(value.map((item) => String(item).trim()).filter(Boolean))] : [];
    return rows.map((rule) => ({
      id: rule.id, productId: rule.productId, displayName: rule.displayName,
      productNumbers: strings(rule.productNumbers), productNameAliases: strings(rule.productNameAliases),
      matchTarget: rule.matchTarget,
      productNameIncludeKeywords: strings(rule.productNameIncludeKeywords),
      productNameExcludeKeywords: strings(rule.productNameExcludeKeywords),
      optionIncludeKeywords: strings(rule.optionIncludeKeywords),
      optionExcludeKeywords: strings(rule.optionExcludeKeywords),
      priority: rule.priority, validFrom: formatDateOnly(rule.validFrom),
      validTo: rule.validTo ? formatDateOnly(rule.validTo) : null, isActive: rule.isActive
    }));
  }
}

async function assertPublishScope(tx: Prisma.TransactionClient, runId: string, connectionId: string,
  provider: "META" | "CAFE24", currencyCode: "USD" | "KRW") {
  const run = await tx.syncRun.findUnique({ where: { id: runId }, select: { connectionId: true } });
  if (run?.connectionId !== connectionId) invalid("Run and connection do not match.");
  const connection = await tx.sourceConnection.findUnique({ where: { id: connectionId },
    select: { provider: true, currencyCode: true, timeZone: true } });
  if (connection?.provider !== provider || connection.currencyCode !== currencyCode ||
      connection.timeZone !== "Asia/Seoul") invalid("Provider currency/timezone scope does not match canonical input.");
}

function businessKey(...parts: string[]) { return JSON.stringify(parts.map((part) => part.trim())); }
function cafe24Key(connectionId: string, row: Cafe24ApiOrder) {
  return businessKey(connectionId, row.orderNo, row.lineOrderNo, normalizeProductNo(row.productNo), row.optionName);
}
function sha256(value: string) { return createHash("sha256").update(value).digest("hex"); }
function validDay(date: Date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime()) ||
      date.toISOString().slice(10) !== "T00:00:00.000Z") invalid("Expected a UTC date-only value.");
  return date.toISOString().slice(0, 10);
}
function validTimestamp(date: Date) { return date instanceof Date && Number.isFinite(date.getTime()); }
function requiredId(value: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 256) invalid("Required provider identity is invalid.");
}
function requiredName(value: string) {
  if (typeof value !== "string" || !value.trim()) invalid("Provider name is required.");
}
function decimal(value: string, precision: number, scale: number, field: string) {
  if (typeof value !== "string" || !new RegExp(`^\\d{1,${precision - scale}}(?:\\.\\d{1,${scale}})?$`).test(value))
    invalid(`${field} must be a nonnegative decimal string.`);
  return new Prisma.Decimal(value);
}
function optionalDecimal(value: string | null | undefined) {
  return value == null ? null : decimal(value, 18, 2, "optional KRW amount");
}
function cafe24Measures(row: Cafe24ApiOrder) {
  decimal(row.quantity, 14, 4, "quantity");
  decimal(row.salePriceKrw, 14, 2, "salePriceKrw");
  decimal(row.totalPaidKrw, 14, 2, "totalPaidKrw");
  optionalDecimal(row.totalOrderKrw);
  optionalDecimal(row.actualOrderPriceKrw);
  optionalDecimal(row.actualPaymentKrw);
  optionalDecimal(row.actualShippingFeeKrw);
  optionalDecimal(row.initialOrderPriceKrw);
  optionalDecimal(row.initialPaymentKrw);
  optionalDecimal(row.initialShippingFeeKrw);
  optionalDecimal(row.cancelAmountKrw);
  optionalDecimal(row.refundAmountKrw);
  optionalDecimal(row.discountAmountKrw);
  optionalDecimal(row.couponAmountKrw);
}
function validateCafe24Order(row: Cafe24ApiOrder) {
  [row.orderNo, row.lineOrderNo, row.productNo].forEach(requiredId);
  requiredName(row.productName);
  if (!cafe24OptionCompositionFits(row.optionName) ||
      (row.optionValue != null && (typeof row.optionValue !== "string" || row.optionValue.length > 256 ||
        /[\u0000-\u001f\u007f]/.test(row.optionValue))) ||
      (row.paymentMethod !== null &&
        (typeof row.paymentMethod !== "string" || row.paymentMethod.length > 256)) ||
      (row.orderStatus != null && (typeof row.orderStatus !== "string" || row.orderStatus.length > 64)) ||
      (row.lineStatus != null && (typeof row.lineStatus !== "string" || row.lineStatus.length > 64)))
    invalid("Cafe24 option, payment, or status exceeds the canonical field limit.");
  const codes = row.providerPaymentCodes ?? null;
  if (codes !== null && (!Array.isArray(codes) || codes.length < 1 || codes.length > 16 ||
      !codes.every((code) => typeof code === "string" && code.length > 0 &&
        code.length <= 64 && !/[\u0000-\u001f\u007f]/.test(code))))
    invalid("Cafe24 provider payment code array is invalid.");
  if (row.providerCouponSignal != null && typeof row.providerCouponSignal !== "boolean")
    invalid("Cafe24 provider coupon signal is invalid.");
  if (row.totalPaidInputSource != null && row.totalPaidInputSource !== "ORDERS_PAYMENT_AMOUNT")
    invalid("Cafe24 paid amount source is invalid.");
  if (codes === null && row.providerCouponSignal != null)
    invalid("Cafe24 coupon signal needs provider payment codes.");
  if (codes !== null && (row.providerCouponSignal ?? null) !== cafe24ProviderCouponSignal(codes))
    invalid("Cafe24 coupon signal conflicts with provider payment codes.");
  const day = validDay(row.orderDate);
  if (!validTimestamp(row.orderedAt) ||
      (row.providerUpdatedAt !== null && !validTimestamp(row.providerUpdatedAt)))
    invalid("Cafe24 order date or timestamp is invalid.");
  if (formatInTimeZone(row.orderedAt, "Asia/Seoul", "yyyy-MM-dd") !== day)
    invalid("Cafe24 orderDate must equal the Asia/Seoul date of orderedAt.");
  if ((row.cancelledAt != null && !validTimestamp(row.cancelledAt)) ||
      (row.refundedAt != null && !validTimestamp(row.refundedAt)))
    invalid("Cafe24 cancellation/refund timestamp is invalid.");
  cafe24Measures(row);
  return day;
}
function sameCafe24Version(prior: {
  productNo: string; optionName: string; orderNo: string; lineOrderNo: string;
  optionValue?: string | null;
  quantity: Prisma.Decimal; salePriceKrw: Prisma.Decimal; totalOrderKrw: Prisma.Decimal | null;
  totalPaidKrw: Prisma.Decimal; paymentMethod: string | null; orderedAt: Date; orderDate: Date;
  totalPaidInputSource?: string | null;
  providerPaymentCodes?: Prisma.JsonValue | null; providerCouponSignal?: boolean | null;
  actualOrderPriceKrw?: Prisma.Decimal | null; actualPaymentKrw?: Prisma.Decimal | null;
  actualShippingFeeKrw?: Prisma.Decimal | null;
  initialOrderPriceKrw?: Prisma.Decimal | null; initialPaymentKrw?: Prisma.Decimal | null;
  initialShippingFeeKrw?: Prisma.Decimal | null;
  providerUpdatedAt: Date | null;
  orderStatus: string | null; lineStatus: string | null;
  cancelledAt: Date | null; cancelAmountKrw: Prisma.Decimal | null;
  refundedAt: Date | null; refundAmountKrw: Prisma.Decimal | null;
  discountAmountKrw: Prisma.Decimal | null; couponAmountKrw: Prisma.Decimal | null;
}, row: Cafe24ApiOrder, productNo: string) {
  const sameAmount = (before: Prisma.Decimal | null, after: string | null | undefined) =>
    before === null ? after == null : after != null && before.eq(after);
  const sameTime = (before: Date | null, after: Date | null | undefined) =>
    (before?.getTime() ?? null) === (after?.getTime() ?? null);
  const sameProviderAmount = (before: Prisma.Decimal | null | undefined, after: string | null | undefined) =>
    before == null ? after == null : after != null && before.eq(after);
  return prior.orderNo === row.orderNo.trim() && prior.lineOrderNo === row.lineOrderNo.trim() &&
    sameTime(prior.providerUpdatedAt, row.providerUpdatedAt) &&
    prior.productNo === productNo && prior.optionName === row.optionName.trim() &&
    (prior.optionValue ?? null) === (row.optionValue ?? null) &&
    prior.quantity.eq(row.quantity) && prior.salePriceKrw.eq(row.salePriceKrw) &&
    (prior.totalOrderKrw === null ? row.totalOrderKrw === null :
      row.totalOrderKrw !== null && prior.totalOrderKrw.eq(row.totalOrderKrw)) &&
    prior.totalPaidKrw.eq(row.totalPaidKrw) &&
    (prior.totalPaidInputSource ?? null) === (row.totalPaidInputSource ?? null) &&
    prior.paymentMethod === row.paymentMethod &&
    sameCafe24ProviderCodes(prior.providerPaymentCodes, row.providerPaymentCodes) &&
    (prior.providerCouponSignal ?? null) === (row.providerCouponSignal ?? null) &&
    sameProviderAmount(prior.actualOrderPriceKrw, row.actualOrderPriceKrw) &&
    sameProviderAmount(prior.actualPaymentKrw, row.actualPaymentKrw) &&
    sameProviderAmount(prior.actualShippingFeeKrw, row.actualShippingFeeKrw) &&
    sameProviderAmount(prior.initialOrderPriceKrw, row.initialOrderPriceKrw) &&
    sameProviderAmount(prior.initialPaymentKrw, row.initialPaymentKrw) &&
    sameProviderAmount(prior.initialShippingFeeKrw, row.initialShippingFeeKrw) &&
    prior.orderedAt.getTime() === row.orderedAt.getTime() &&
    prior.orderDate.getTime() === row.orderDate.getTime() &&
    prior.orderStatus === (row.orderStatus ?? null) && prior.lineStatus === (row.lineStatus ?? null) &&
    sameTime(prior.cancelledAt, row.cancelledAt) && sameAmount(prior.cancelAmountKrw, row.cancelAmountKrw) &&
    sameTime(prior.refundedAt, row.refundedAt) && sameAmount(prior.refundAmountKrw, row.refundAmountKrw) &&
    sameAmount(prior.discountAmountKrw, row.discountAmountKrw) &&
    sameAmount(prior.couponAmountKrw, row.couponAmountKrw);
}
function sameCafe24CurrentLine(line: {
  orderNo: string; lineOrderNo: string; productNo: string; productName: string;
  optionName: string; quantity: Prisma.Decimal; salePriceKrw: Prisma.Decimal;
  optionValue?: string | null;
  totalOrderKrw: Prisma.Decimal | null; totalPaidKrw: Prisma.Decimal;
  totalPaidInputSource?: string | null;
  paymentMethod: string | null; orderedAt: Date | null; orderDate: Date | null;
  providerPaymentCodes?: Prisma.JsonValue | null; providerCouponSignal?: boolean | null;
  actualOrderPriceKrw?: Prisma.Decimal | null; actualPaymentKrw?: Prisma.Decimal | null;
  actualShippingFeeKrw?: Prisma.Decimal | null;
  initialOrderPriceKrw?: Prisma.Decimal | null; initialPaymentKrw?: Prisma.Decimal | null;
  initialShippingFeeKrw?: Prisma.Decimal | null;
  providerUpdatedAt: Date | null; importVersion: number;
}, prior: {
  orderNo: string; lineOrderNo: string; productNo: string; optionName: string;
  optionValue?: string | null;
  quantity: Prisma.Decimal; salePriceKrw: Prisma.Decimal;
  totalOrderKrw: Prisma.Decimal | null; totalPaidKrw: Prisma.Decimal;
  totalPaidInputSource?: string | null;
  paymentMethod: string | null; orderedAt: Date; orderDate: Date;
  providerPaymentCodes?: Prisma.JsonValue | null; providerCouponSignal?: boolean | null;
  actualOrderPriceKrw?: Prisma.Decimal | null; actualPaymentKrw?: Prisma.Decimal | null;
  actualShippingFeeKrw?: Prisma.Decimal | null;
  initialOrderPriceKrw?: Prisma.Decimal | null; initialPaymentKrw?: Prisma.Decimal | null;
  initialShippingFeeKrw?: Prisma.Decimal | null;
  providerUpdatedAt: Date | null; version: number;
}) {
  return line.importVersion === prior.version &&
    line.orderNo === prior.orderNo && line.lineOrderNo === prior.lineOrderNo &&
    line.productNo === prior.productNo && line.optionName === prior.optionName &&
    (line.optionValue ?? null) === (prior.optionValue ?? null) &&
    line.quantity.eq(prior.quantity) && line.salePriceKrw.eq(prior.salePriceKrw) &&
    (line.totalOrderKrw === null ? prior.totalOrderKrw === null :
      prior.totalOrderKrw !== null && line.totalOrderKrw.eq(prior.totalOrderKrw)) &&
    line.totalPaidKrw.eq(prior.totalPaidKrw) &&
    (line.totalPaidInputSource ?? null) === (prior.totalPaidInputSource ?? null) &&
    line.paymentMethod === prior.paymentMethod &&
    sameCafe24ProviderCodes(line.providerPaymentCodes, prior.providerPaymentCodes) &&
    (line.providerCouponSignal ?? null) === (prior.providerCouponSignal ?? null) &&
    sameCafe24StoredAmount(line.actualOrderPriceKrw, prior.actualOrderPriceKrw) &&
    sameCafe24StoredAmount(line.actualPaymentKrw, prior.actualPaymentKrw) &&
    sameCafe24StoredAmount(line.actualShippingFeeKrw, prior.actualShippingFeeKrw) &&
    sameCafe24StoredAmount(line.initialOrderPriceKrw, prior.initialOrderPriceKrw) &&
    sameCafe24StoredAmount(line.initialPaymentKrw, prior.initialPaymentKrw) &&
    sameCafe24StoredAmount(line.initialShippingFeeKrw, prior.initialShippingFeeKrw) &&
    line.orderedAt?.getTime() === prior.orderedAt.getTime() &&
    line.orderDate?.getTime() === prior.orderDate.getTime() &&
    (line.providerUpdatedAt?.getTime() ?? null) ===
      (prior.providerUpdatedAt?.getTime() ?? null);
}
function sameCafe24StoredAmount(left: Prisma.Decimal | null | undefined,
  right: Prisma.Decimal | null | undefined) {
  return left == null || right == null ? left == null && right == null : left.eq(right);
}
function sameCafe24ProviderCodes(left: Prisma.JsonValue | null | undefined,
  right: Prisma.JsonValue | null | undefined) {
  const normalize = (value: Prisma.JsonValue | null | undefined) =>
    value === (Prisma.DbNull as unknown) || value === (Prisma.JsonNull as unknown)
      ? null : value ?? null;
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function invalid(message: string): never {
  throw new BadRequestException({ code: "INVALID_CANONICAL_ROW", message });
}
