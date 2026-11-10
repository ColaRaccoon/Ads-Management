import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../common/prisma.service";
import { formatDateOnly, toDateOnly } from "../domain/date-number";
import { influencerKey } from "./influencer-matching";
import type { InfluencerCollaborationInput, UpdateInfluencerCollaborationInput } from "./influencer.dto";

const PAGE_SIZE = 30;
const SUMMARY = {
  id: true,
  version: true,
  influencerName: true,
  feeKrw: true,
  startDate: true,
  endDate: true,
  note: true,
  adSpendKrw: true,
  adMarginKrw: true,
  netPerformanceKrw: true,
  dataThrough: true,
  aggregatedAt: true,
  creativeCount: true
} as const satisfies Prisma.InfluencerCollaborationSelect;

@Injectable()
export class InfluencerRecordsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(page: number) {
    const rows = await this.prisma.influencerCollaboration.findMany({
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE + 1,
      select: SUMMARY
    });
    return { items: rows.slice(0, PAGE_SIZE).map(serializeSummary), page, hasMore: rows.length > PAGE_SIZE };
  }

  async creatives(id: string) {
    const row = await this.prisma.influencerCollaboration.findUnique({ where: { id }, select: { creativeTotals: true } });
    if (!row) throw collaborationNotFound();
    return { items: row.creativeTotals };
  }

  create(input: InfluencerCollaborationInput) {
    const definition = collaborationDefinition(input);
    return this.mutate(async tx => {
      await assertNoOverlap(tx, definition);
      const row = await tx.influencerCollaboration.create({
        data: { ...definition, ...initialPerformance(definition.feeKrw), version: randomUUID() },
        select: SUMMARY
      });
      return serializeSummary(row);
    });
  }

  update(id: string, input: UpdateInfluencerCollaborationInput) {
    const definition = collaborationDefinition(input);
    const nextVersion = randomUUID();
    return this.mutate(async tx => {
      // Claim the row before reading its totals. A worker may have published after the form was opened.
      const [current] = await tx.influencerCollaboration.updateManyAndReturn({
        where: { id, version: input.version }, data: { version: nextVersion },
        select: { influencerKey: true, startDate: true, endDate: true, adMarginKrw: true }
      });
      if (!current) {
        const existing = await tx.influencerCollaboration.findUnique({ where: { id }, select: { id: true } });
        if (!existing) throw collaborationNotFound();
        throw new ConflictException({
          code: "STALE_INFLUENCER_COLLABORATION",
          message: "다른 사용자가 먼저 수정했습니다. 목록을 새로고침한 뒤 다시 시도해 주세요."
        });
      }

      const matchingChanged = current.influencerKey !== definition.influencerKey ||
        current.startDate.getTime() !== definition.startDate.getTime() ||
        current.endDate?.getTime() !== definition.endDate?.getTime();
      if (matchingChanged) await assertNoOverlap(tx, definition, id);
      const performance = matchingChanged
        ? initialPerformance(definition.feeKrw)
        : { netPerformanceKrw: current.adMarginKrw?.minus(definition.feeKrw) ?? null };
      const row = await tx.influencerCollaboration.update({
        where: { id }, data: { ...definition, ...performance }, select: SUMMARY
      });
      return serializeSummary(row);
    });
  }

  private mutate<T>(work: (tx: Prisma.TransactionClient) => Promise<T>) {
    return this.prisma.$transaction(async tx => {
      // Serialize definition writes across API instances, including moves between names.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('influencer-collaboration-definitions', 0))`;
      return work(tx);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  }
}

function collaborationDefinition(input: InfluencerCollaborationInput) {
  const influencerName = input.influencerName.trim();
  const key = influencerKey(influencerName);
  if (!key) {
    throw new BadRequestException({ code: "INFLUENCER_NAME_REQUIRED", message: "인플루언서 이름을 입력해 주세요." });
  }
  if (key.length > 100 || /[()]/.test(key)) {
    throw new BadRequestException({
      code: "INVALID_INFLUENCER_NAME",
      message: "괄호를 제외한 인플루언서 이름을 100자 이내로 입력해 주세요."
    });
  }
  const startDate = toDateOnly(input.startDate);
  const endDate = toDateOnly(input.endDate);
  if (!startDate || (input.endDate !== null && (!endDate || endDate < startDate))) {
    throw new BadRequestException({ code: "INVALID_INFLUENCER_PERIOD", message: "측정 시작일과 종료일을 확인해 주세요." });
  }
  return { influencerName, influencerKey: key, feeKrw: input.feeKrw, startDate, endDate, note: input.note?.trim() || null };
}

async function assertNoOverlap(tx: Prisma.TransactionClient, definition: ReturnType<typeof collaborationDefinition>, excludeId?: string) {
  const overlap = await tx.influencerCollaboration.findFirst({
    where: {
      influencerKey: definition.influencerKey,
      ...(excludeId ? { id: { not: excludeId } } : {}),
      ...(definition.endDate ? { startDate: { lte: definition.endDate } } : {}),
      OR: [{ endDate: null }, { endDate: { gte: definition.startDate } }]
    },
    select: { id: true }
  });
  if (overlap) throw new ConflictException({
    code: "INFLUENCER_PERIOD_OVERLAP",
    message: "같은 인플루언서의 측정 기간이 겹칩니다."
  });
}

function initialPerformance(feeKrw: number) {
  return {
    adSpendKrw: 0, adMarginKrw: 0, netPerformanceKrw: -feeKrw, dataThrough: null, aggregatedAt: null,
    creativeCount: 0, creativeTotals: [], needsBackfill: true, lastJobAt: null
  };
}

function collaborationNotFound() {
  return new NotFoundException({ code: "INFLUENCER_COLLABORATION_NOT_FOUND", message: "인플루언서 협업 기록을 찾을 수 없습니다." });
}

function serializeSummary(row: Prisma.InfluencerCollaborationGetPayload<{ select: typeof SUMMARY }>) {
  return {
    ...row,
    feeKrw: row.feeKrw.toNumber(),
    adSpendKrw: row.adSpendKrw?.toNumber() ?? null,
    adMarginKrw: row.adMarginKrw?.toNumber() ?? null,
    netPerformanceKrw: row.netPerformanceKrw?.toNumber() ?? null,
    startDate: formatDateOnly(row.startDate),
    endDate: row.endDate ? formatDateOnly(row.endDate) : null,
    dataThrough: row.dataThrough ? formatDateOnly(row.dataThrough) : null,
    aggregatedAt: row.aggregatedAt?.toISOString() ?? null
  };
}
