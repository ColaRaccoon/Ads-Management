import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../common/prisma.service";
import { formatDateOnly, toDateOnly } from "../domain/date-number";
import { influencerKey } from "./influencer-matching";
import type {
  InfluencerCollaborationInput, InfluencerDailyQuery, UpdateInfluencerCollaborationInput, UpdateInfluencerNumberingInput
} from "./influencer.dto";

const PAGE_SIZE = 30;
const SUMMARY = {
  id: true,
  version: true,
  influencerName: true,
  managerName: true,
  productId: true,
  product: { select: { displayName: true } },
  numberingRequired: true,
  _count: { select: { materials: true } },
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

const materialFields = { creativeId: true, creativeName: true, materialNo: true } as const;
type Material = Prisma.InfluencerMaterialAssignmentGetPayload<{ select: typeof materialFields }>;

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

  async daily(query: InfluencerDailyQuery) {
    const metricDate = toDateOnly(query.date);
    if (!metricDate) throw invalidDate();
    const page = query.page ?? 1;
    const [rows, managers] = await Promise.all([
      this.prisma.influencerCollaborationDay.findMany({
        where: { metricDate, collaboration: { needsBackfill: false, ...(query.managerName ? { managerName: query.managerName } : {}) } },
        orderBy: { collaborationId: "asc" }, skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE + 1,
        select: {
          collaborationId: true, adSpendKrw: true, adMarginKrw: true, creativeCount: true,
          collaboration: { select: { managerName: true, influencerName: true, product: { select: { displayName: true } } } }
        }
      }),
      this.prisma.influencerCollaboration.findMany({
        where: { managerName: { not: null } }, select: { managerName: true },
        distinct: ["managerName"], orderBy: { managerName: "asc" }
      })
    ]);
    return {
      items: rows.slice(0, PAGE_SIZE).map(row => ({
        id: row.collaborationId,
        managerName: row.collaboration.managerName,
        nickname: row.collaboration.influencerName,
        productName: row.collaboration.product?.displayName ?? null,
        adSpendKrw: row.adSpendKrw?.toNumber() ?? null,
        adMarginKrw: row.adMarginKrw?.toNumber() ?? null,
        creativeCount: row.creativeCount
      })),
      managers: managers.flatMap(row => row.managerName ? [row.managerName] : []),
      page, hasMore: rows.length > PAGE_SIZE
    };
  }

  async materials(id: string, number?: string) {
    const record = await this.prisma.influencerCollaboration.findUnique({
      where: { id }, select: { productId: true, materials: { select: materialFields } }
    });
    if (!record) throw collaborationNotFound();
    const candidates = number && record.productId
      ? await this.prisma.$queryRaw<Material[]>(Prisma.sql`
          SELECT c.id AS "creativeId", c.display_name AS "creativeName", c.material_no AS "materialNo"
          FROM creatives c
          WHERE c.platform = 'META'
            AND normalize(c.material_no, NFKC) ~ ${`(^|[^0-9])0*${number.replace(/^0+(?=\d)/, "")}(번소재)?$`}
            AND EXISTS (
              SELECT 1 FROM meta_ad_daily_metrics m
              WHERE m.creative_id = c.id AND m.product_id = ${record.productId}::uuid AND m.is_current
            )
            AND NOT EXISTS (
              SELECT 1 FROM influencer_material_assignments a WHERE a.creative_id = c.id AND a.collaboration_id <> ${id}::uuid
            )
          ORDER BY c.display_name, c.id LIMIT 50`)
      : [];
    return { selected: record.materials, candidates };
  }

  numbering(id: string, input: UpdateInfluencerNumberingInput) {
    return this.mutate(async tx => {
      const current = await this.claim(tx, id, input.version);
      const creativeIds = [...new Set(input.creativeIds.map(value => value.toLowerCase()))];
      if (!current.productId && creativeIds.length) throw productRequired();
      const other = await tx.influencerMaterialAssignment.findFirst({
        where: { creativeId: { in: creativeIds }, collaborationId: { not: id } },
        select: { creativeId: true }
      });
      if (other) throw new ConflictException("이미 다른 협업에 연결된 소재가 있습니다.");
      const existing = new Map(current.materials.map(material => [material.creativeId, material]));
      const newIds = creativeIds.filter(creativeId => !existing.has(creativeId));
      const candidates = newIds.length ? await tx.creative.findMany({
        where: {
          id: { in: newIds }, platform: "META", materialNo: { not: null },
          adDailyMetrics: { some: { productId: current.productId, isCurrent: true } }
        },
        select: { id: true, displayName: true, materialNo: true }
      }) : [];
      if (candidates.length !== newIds.length || candidates.some(c => !/[0-9]+(?:번소재)?$/.test(c.materialNo!.normalize("NFKC")))) {
        throw new BadRequestException("선택한 제품의 번호가 있는 Meta 소재를 선택해 주세요.");
      }
      const removed = current.materials.filter(material => !creativeIds.includes(material.creativeId));
      if (removed.length) await tx.influencerMaterialAssignment.deleteMany({
        where: { collaborationId: id, creativeId: { in: removed.map(material => material.creativeId) } }
      });
      if (candidates.length) await tx.influencerMaterialAssignment.createMany({
        data: candidates.map(c => ({ collaborationId: id, creativeId: c.id, creativeName: c.displayName, materialNo: c.materialNo! }))
      });
      const changed = !current.numberingRequired || newIds.length > 0 || removed.length > 0;
      const row = await tx.influencerCollaboration.update({
        where: { id },
        data: { numberingRequired: true, ...(changed ? initialPerformance(current.feeKrw.toNumber()) : {}) },
        select: SUMMARY
      });
      if (newIds.length || removed.length) {
        // Explicit assignments take priority over pre-existing nickname matches.
        const affected = await tx.influencerDailyPerformance.findMany({
          where: { scope: "NICKNAME", sourceCreativeId: { in: [...newIds, ...removed.map(material => material.creativeId)] } },
          select: { influencerKey: true }, distinct: ["influencerKey"]
        });
        if (affected.length) await tx.influencerCollaboration.updateMany({
          where: { numberingRequired: false, influencerKey: { in: affected.map(entry => entry.influencerKey) } },
          data: { needsBackfill: true, lastJobAt: null }
        });
      }
      return serializeSummary(row);
    });
  }

  create(input: InfluencerCollaborationInput) {
    const definition = collaborationDefinition(input);
    return this.mutate(async tx => {
      await validateProduct(tx, definition.productId);
      const row = await tx.influencerCollaboration.create({
        data: { ...definition, numberingRequired: true, ...initialPerformance(definition.feeKrw), version: randomUUID() },
        select: SUMMARY
      });
      return serializeSummary(row);
    });
  }

  update(id: string, input: UpdateInfluencerCollaborationInput) {
    const definition = collaborationDefinition(input);
    return this.mutate(async tx => {
      const current = await this.claim(tx, id, input.version);
      if (current.productId !== definition.productId) {
        if (current.materials.length) throw new ConflictException("관리자가 연결된 소재를 해제한 뒤 제품을 변경할 수 있습니다.");
        await validateProduct(tx, definition.productId);
      }
      if (current.endDate && definition.startDate > current.endDate) throw invalidDate();
      const legacyNameChanged = !current.numberingRequired && current.influencerKey !== definition.influencerKey;
      const matchingChanged = legacyNameChanged || current.startDate.getTime() !== definition.startDate.getTime();
      if (!current.numberingRequired && matchingChanged) {
        await assertNoLegacyOverlap(tx, definition.influencerKey, definition.startDate, current.endDate, id);
      }
      const performance = matchingChanged
        ? initialPerformance(definition.feeKrw)
        : { netPerformanceKrw: current.adMarginKrw?.minus(definition.feeKrw) ?? null };
      const row = await tx.influencerCollaboration.update({
        where: { id }, data: { ...definition, ...performance }, select: SUMMARY
      });
      return serializeSummary(row);
    });
  }

  private async claim(tx: Prisma.TransactionClient, id: string, version: string) {
    // Lock the record and check its version before reading totals or assignments.
    const updated = await tx.influencerCollaboration.updateMany({ where: { id, version }, data: { version: randomUUID() } });
    const current = await tx.influencerCollaboration.findUnique({
      where: { id },
      select: { influencerKey: true, productId: true, numberingRequired: true, startDate: true, endDate: true,
        adMarginKrw: true, feeKrw: true, materials: { select: materialFields } }
    });
    if (!current) throw collaborationNotFound();
    if (!updated.count) throw new ConflictException({
      code: "STALE_INFLUENCER_COLLABORATION",
      message: "다른 사용자가 먼저 수정했습니다. 목록을 새로고침한 뒤 다시 시도해 주세요."
    });
    return current;
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
  const influencerName = input.nickname.trim();
  const key = influencerKey(influencerName);
  const managerName = input.managerName.trim();
  if (!key || key.length > 100 || !managerName) throw new BadRequestException("담당자 이름과 인플루언서 닉네임을 입력해 주세요.");
  const startDate = toDateOnly(input.startDate);
  if (!startDate) throw invalidDate();
  return { influencerName, influencerKey: key, managerName, productId: input.productId, feeKrw: input.feeKrw, startDate, note: input.note?.trim() || null };
}

async function validateProduct(tx: Prisma.TransactionClient, productId: string) {
  const product = await tx.product.findFirst({ where: { id: productId, isActive: true }, select: { id: true } });
  if (!product) throw productRequired();
}

function productRequired() {
  return new BadRequestException("Meta Product Settings에 등록된 활성 제품을 선택해 주세요.");
}

function invalidDate() {
  return new BadRequestException("측정 날짜를 확인해 주세요.");
}

async function assertNoLegacyOverlap(tx: Prisma.TransactionClient, key: string, startDate: Date, endDate: Date | null, id: string) {
  const overlap = await tx.influencerCollaboration.findFirst({
    where: {
      influencerKey: key, numberingRequired: false, id: { not: id },
      ...(endDate ? { startDate: { lte: endDate } } : {}),
      OR: [{ endDate: null }, { endDate: { gte: startDate } }]
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
  const { influencerName, product, _count, endDate: _endDate, ...summary } = row;
  return {
    ...summary,
    nickname: influencerName,
    productName: product?.displayName ?? null,
    materialCount: _count.materials,
    feeKrw: row.feeKrw.toNumber(),
    adSpendKrw: row.adSpendKrw?.toNumber() ?? null,
    adMarginKrw: row.adMarginKrw?.toNumber() ?? null,
    netPerformanceKrw: row.netPerformanceKrw?.toNumber() ?? null,
    startDate: formatDateOnly(row.startDate),
    dataThrough: row.dataThrough ? formatDateOnly(row.dataThrough) : null,
    aggregatedAt: row.aggregatedAt?.toISOString() ?? null
  };
}
