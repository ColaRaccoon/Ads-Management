import { ConflictPolicy, Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { ParsedMetaAdDailyRow } from "../domain/meta-ad-daily-csv";
import { ParsedMetaAdsetRow } from "../domain/meta-csv";
import { formatDateOnly } from "../domain/date-number";
import {
  CreativePlacementCleanupKey,
  DeletedAdMetricKey,
  DeletedAdsetMetricKey
} from "./upload-contracts";

export function minDate(current: Date | null, next: Date) {
  return current && current < next ? current : next;
}

export function maxDate(current: Date | null, next: Date) {
  return current && current > next ? current : next;
}

export function decimalOrNull(value: number | null) {
  return value === null ? null : new Prisma.Decimal(value);
}

export function jsonSafeParsedRow(parsedRow: ParsedMetaAdsetRow) {
  return {
    ...parsedRow,
    dateStart: formatDateOnly(parsedRow.dateStart),
    dateEnd: formatDateOnly(parsedRow.dateEnd),
    metricDate: formatDateOnly(parsedRow.metricDate),
    startDate: parsedRow.startDate ? formatDateOnly(parsedRow.startDate) : null
  };
}

export function jsonSafeAdParsedRow(parsedRow: ParsedMetaAdDailyRow) {
  return {
    ...parsedRow,
    dateStart: formatDateOnly(parsedRow.dateStart),
    dateEnd: formatDateOnly(parsedRow.dateEnd),
    metricDate: formatDateOnly(parsedRow.metricDate)
  };
}

export function creativeOriginalKey(originalName: string) {
  return originalName.trim();
}

export function creativePlacementCleanupKey(metric: {
  creativeId: string | null;
  metaCampaignId: string;
  metaAdsetId: string;
  adNameSnapshot: string;
}): CreativePlacementCleanupKey {
  return {
    creativeId: metric.creativeId ?? "",
    metaCampaignId: metric.metaCampaignId,
    metaAdsetId: metric.metaAdsetId,
    originalAdName: metric.adNameSnapshot
  };
}

export function placementKeyToString(key: CreativePlacementCleanupKey) {
  return `${key.creativeId}:${key.metaCampaignId}:${key.metaAdsetId}:${key.originalAdName}`;
}

export function creativePlacementWhere(key: CreativePlacementCleanupKey): Prisma.CreativePlacementWhereInput {
  return {
    creativeId: key.creativeId,
    metaCampaignId: key.metaCampaignId,
    metaAdsetId: key.metaAdsetId,
    originalAdName: key.originalAdName
  };
}

export function emptyCreativeCleanup() {
  return {
    deletedCreativePlacementCount: 0,
    deletedCreativeAliasCount: 0,
    deletedCreativeLogCount: 0,
    deletedCreativeCount: 0,
    deactivatedCreativeCount: 0
  };
}

export function nextImportVersion(latestVersion?: number | null) {
  return (latestVersion ?? 0) + 1;
}

export function snapshotMetricKey(metricDate: Date, metaAdsetId: string) {
  return `${formatDateOnly(metricDate)}:${metaAdsetId}`;
}

export function snapshotAdMetricKey(metric: {
  metricDate: Date;
  metaCampaignId: string;
  metaAdsetId: string;
  adIdentityKey: string;
}) {
  return `${formatDateOnly(metric.metricDate)}:${metric.metaCampaignId}:${metric.metaAdsetId}:${metric.adIdentityKey}`;
}

export function findMissingSnapshotMetricIds(
  currentMetrics: Array<{ id: string; metricDate: Date; metaAdsetId: string }>,
  includedKeys: Set<string>
) {
  return currentMetrics
    .filter((metric) => !includedKeys.has(snapshotMetricKey(metric.metricDate, metric.metaAdsetId)))
    .map((metric) => metric.id);
}

export function duplicatedValues(values: string[]) {
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      duplicated.add(value);
    }
    seen.add(value);
  }
  return Array.from(duplicated);
}

export function uniqueAdMetricKeys(metrics: DeletedAdMetricKey[]) {
  const unique = new Map<string, DeletedAdMetricKey>();
  for (const metric of metrics) {
    unique.set(snapshotAdMetricKey(metric), metric);
  }
  return Array.from(unique.values());
}

export function uniqueAdsetMetricKeys(metrics: DeletedAdsetMetricKey[]) {
  const unique = new Map<string, DeletedAdsetMetricKey>();
  for (const metric of metrics) {
    unique.set(snapshotMetricKey(metric.metricDate, metric.metaAdsetId), metric);
  }
  return Array.from(unique.values());
}

export function duplicateBatchHash(fileHashSha256: string, conflictPolicy: ConflictPolicy) {
  return createHash("sha256").update(`${fileHashSha256}:${conflictPolicy}:${Date.now()}:${Math.random()}`).digest("hex");
}

export function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}
