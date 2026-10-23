import { Prisma, SourceDataKind, SourceKind } from "@prisma/client";
import { ConflictException } from "@nestjs/common";
import { PrismaService } from "./prisma.service";
import { validatedMetaApiDaysBatch } from "./meta-source-read-coverage";

export type MetaCollectionItem = {
  connectionId: string; accountId: string; dataKind: string;
  expectedDays: number; collectedDays: number; missingDays: number;
  failedDays: number; runningDays: number;
  lastSuccessAt: string | null; lastAttemptAt: string | null;
};
export type MetaCollectionSummary = {
  mode: "DISABLED" | "NO_API_POLICY" | "API"; items: MetaCollectionItem[];
};

/** Includes policy dates with no metric rows; a failed reread keeps its last success. */
export async function metaCollectionSummary(client: PrismaService | Prisma.TransactionClient,
  from: Date, to: Date): Promise<MetaCollectionSummary> {
  if (process.env.DAILY_SYNC_FEATURE_ENABLED !== "true") return { mode: "DISABLED", items: [] };
  const policies = await client.sourcePolicy.findMany({ where: {
    connection: { provider: "META" }, dataKind: { in: ["META_AD", "META_ADSET"] },
    primarySource: SourceKind.API, fromDate: { lte: to },
    OR: [{ toDate: null }, { toDate: { gt: from } }]
  }, select: { connectionId: true, dataKind: true, fromDate: true, toDate: true,
    connection: { select: { externalAccountId: true } } }, take: 401 });
  if (policies.length > 400) throw new ConflictException({ code: "SOURCE_SELECTION_REQUIRED",
    message: "Meta 수집 범위를 확인할 수 없습니다." });
  if (!policies.length) return { mode: "NO_API_POLICY", items: [] };
  const ids = [...new Set(policies.map((row) => row.connectionId))];
  const [coverage, validated] = await Promise.all([
    client.sourceCoverage.findMany({ where: { connectionId: { in: ids },
      dataKind: { in: ["META_AD", "META_ADSET"] }, metricDate: { gte: from, lte: to } },
    select: { connectionId: true, dataKind: true, metricDate: true, source: true,
      state: true, lastAttemptAt: true, lastSuccessAt: true } }),
    validatedMetaApiDaysBatch(client, [SourceDataKind.META_AD, SourceDataKind.META_ADSET], ids, from, to)
  ]);
  const ads = validated.get(SourceDataKind.META_AD) ?? new Set<string>();
  const adsets = validated.get(SourceDataKind.META_ADSET) ?? new Set<string>();
  const groups = new Map<string, MetaCollectionItem>();
  const dayMs = 86_400_000;
  for (const policy of policies) {
    const key = `${policy.connectionId}:${policy.dataKind}`;
    const item = groups.get(key) ?? { connectionId: policy.connectionId,
      accountId: policy.connection.externalAccountId, dataKind: policy.dataKind,
      expectedDays: 0, collectedDays: 0, missingDays: 0, failedDays: 0,
      runningDays: 0, lastSuccessAt: null, lastAttemptAt: null };
    const start = Math.max(from.getTime(), policy.fromDate.getTime());
    const end = Math.min(to.getTime() + dayMs, policy.toDate?.getTime() ?? Infinity);
    item.expectedDays += Math.max(0, Math.round((end - start) / dayMs));
    groups.set(key, item);
  }
  for (const row of coverage) {
    if (row.source !== SourceKind.API || !policies.some((policy) =>
      policy.connectionId === row.connectionId && policy.dataKind === row.dataKind &&
      policy.fromDate <= row.metricDate && (!policy.toDate || row.metricDate < policy.toDate))) continue;
    const item = groups.get(`${row.connectionId}:${row.dataKind}`)!;
    const valid = row.dataKind === SourceDataKind.META_AD ? ads : adsets;
    const collected = valid.has(`${row.connectionId}:${row.metricDate.getTime()}`);
    if (collected) {
      item.collectedDays++;
      item.lastSuccessAt = latest(item.lastSuccessAt, row.lastSuccessAt);
    }
    if (["FAILED", "PARTIAL", "UNSUPPORTED"].includes(row.state)) item.failedDays++;
    if (row.state === "RUNNING") item.runningDays++;
    item.lastAttemptAt = latest(item.lastAttemptAt, row.lastAttemptAt);
  }
  for (const item of groups.values()) item.missingDays = item.expectedDays - item.collectedDays;
  return { mode: "API", items: [...groups.values()].sort((a, b) =>
    `${a.accountId}:${a.dataKind}`.localeCompare(`${b.accountId}:${b.dataKind}`)) };
}

function latest(previous: string | null, value: Date | null) {
  return value && (!previous || value > new Date(previous)) ? value.toISOString() : previous;
}

export function metaCollectionNote(summary: MetaCollectionSummary) {
  if (summary.mode === "DISABLED") return "";
  if (summary.mode === "NO_API_POLICY") return "Meta API 수집 미연결";
  return summary.items.map((item) => `${item.accountId} ${item.dataKind === "META_AD" ? "광고" : "광고세트"}: ` +
    `${item.collectedDays}/${item.expectedDays}일 수집, 미수집 ${item.missingDays}일, 실패 ${item.failedDays}일, 진행 ${item.runningDays}일; ` +
    `마지막 성공 ${item.lastSuccessAt ?? "없음"}, 마지막 시도 ${item.lastAttemptAt ?? "없음"}`).join(" / ");
}
