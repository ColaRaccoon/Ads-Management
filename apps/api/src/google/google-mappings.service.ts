import { createHash } from "node:crypto";
import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { GooglePerformanceMapping, Prisma } from "@prisma/client";
import { PrismaService } from "../common/prisma.service";
import { asDateOnly } from "../common/date-range";
import { assertGoogleEnabled, googleConnection } from "./google-access";
import { GoogleMappingInput, GoogleQuery } from "./google.dto";

export const mappingIdentity = (kind: string, campaignId?: string | null, productNo?: string | null, optionName = "", optionScope = "EXACT") =>
  createHash("sha256").update(JSON.stringify(kind === "CAMPAIGN" ? [kind, campaignId]
    : optionScope === "PRODUCT" ? [kind, productNo, { scope: "PRODUCT" }] : [kind, productNo, optionName])).digest("hex");
const configurationFields = ["salePriceKrwOverride", "productCostKrwOverride", "shippingKrwOverride", "extraCostKrwOverride"] as const;
export function mappingConfiguration(input: GoogleMappingInput) {
  const optionScope = input.optionScope ?? "EXACT";
  if (!["EXACT", "PRODUCT"].includes(optionScope)) throw new BadRequestException("옵션 적용 범위가 올바르지 않습니다.");
  if (optionScope === "PRODUCT" && input.optionName) throw new BadRequestException("상품 전체 매핑에는 옵션명을 지정할 수 없습니다.");
  const values = configurationFields.map(key => input[key] ?? null);
  const count = values.filter(value => value !== null).length;
  if (count !== 0 && count !== 4) throw new BadRequestException("판매 구성의 판매가·원가·배송비·추가비용을 모두 지정해 주세요.");
  if (values.some(value => value !== null && (!Number.isFinite(value) || value < 0 || value > 999999999999.99 || new Prisma.Decimal(value).decimalPlaces() > 2)))
    throw new BadRequestException("판매 구성 금액은 0 이상의 소수 둘째 자리 금액이어야 합니다.");
  if (input.saleUnitLabel != null && (typeof input.saleUnitLabel !== "string" || input.saleUnitLabel.length > 64))
    throw new BadRequestException("판매 단위 이름은 64자 이내 문자열이어야 합니다.");
  const saleUnitLabel = input.saleUnitLabel?.trim() || null;
  if (saleUnitLabel && count !== 4) throw new BadRequestException("판매 단위 이름은 4개 판매 구성 금액과 함께 지정해 주세요.");
  if (input.kind === "CAMPAIGN" && (optionScope !== "EXACT" || count || saleUnitLabel))
    throw new BadRequestException("캠페인 매핑에는 판매 구성을 지정할 수 없습니다.");
  return { optionScope, salePriceKrwOverride: values[0], productCostKrwOverride: values[1], shippingKrwOverride: values[2], extraCostKrwOverride: values[3], saleUnitLabel };
}
export function mappingDates(input: GoogleMappingInput) {
  const startDate = asDateOnly(input.startDate), endDate = input.endDate ? asDateOnly(input.endDate) : null;
  if (endDate && endDate < startDate) throw new BadRequestException("적용 종료일은 시작일 이후여야 합니다.");
  return { startDate, endDate };
}
export function mappingJson(row: GooglePerformanceMapping & { product?: { displayName: string } | null }) {
  return { ...row, startDate: row.startDate.toISOString().slice(0, 10), endDate: row.endDate?.toISOString().slice(0, 10) ?? null,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), productName: row.product?.displayName ?? null,
    optionScope: row.optionScope ?? "EXACT", salePriceKrwOverride: row.salePriceKrwOverride?.toNumber() ?? null,
    productCostKrwOverride: row.productCostKrwOverride?.toNumber() ?? null, shippingKrwOverride: row.shippingKrwOverride?.toNumber() ?? null,
    extraCostKrwOverride: row.extraCostKrwOverride?.toNumber() ?? null, saleUnitLabel: row.saleUnitLabel ?? null };
}

@Injectable()
export class GoogleMappingsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: GoogleQuery) {
    assertGoogleEnabled();
    if (query.connectionId) await googleConnection(this.prisma, query.connectionId, "GOOGLE");
    if (query.cafe24ConnectionId) await googleConnection(this.prisma, query.cafe24ConnectionId, "CAFE24");
    const page = query.page ?? 1, pageSize = query.pageSize ?? 50;
    const where: Prisma.GooglePerformanceMappingWhereInput = {
      ...(query.productId ? { productId: query.productId } : {}),
      OR: [{ kind: "CAMPAIGN", ...(query.connectionId ? { connectionId: query.connectionId } : {}) },
        { kind: "SALE", ...(query.cafe24ConnectionId ? { connectionId: query.cafe24ConnectionId } : {}) }],
      ...(query.to ? { startDate: { lte: asDateOnly(query.to) } } : {}),
      ...(query.from ? { AND: [{ OR: [{ endDate: null }, { endDate: { gte: asDateOnly(query.from) } }] }] } : {})
    };
    return this.prisma.$transaction(async tx => {
      const [rows, total] = await Promise.all([
        tx.googlePerformanceMapping.findMany({ where, include: { product: { select: { displayName: true } } },
          orderBy: [{ startDate: "desc" }, { id: "asc" }], skip: (page - 1) * pageSize, take: pageSize }),
        tx.googlePerformanceMapping.count({ where })
      ]);
      const audit = await tx.googleMappingAudit.findMany({ where: { mappingId: { in: rows.map(r => r.id) } },
        orderBy: [{ createdAt: "desc" }, { id: "asc" }], take: 100 });
      return { campaignMappings: rows.filter(r => r.kind === "CAMPAIGN").map(mappingJson),
        salesMappings: rows.filter(r => r.kind === "SALE").map(mappingJson), audit, pagination: { page, pageSize, total } };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  async preview(input: GoogleMappingInput) {
    assertGoogleEnabled();
    return this.prisma.$transaction(tx => this.prepare(tx, input), { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  private async prepare(tx: Prisma.TransactionClient, input: GoogleMappingInput) {
    const configuration = mappingConfiguration(input);
    await googleConnection(tx, input.connectionId, input.kind === "CAMPAIGN" ? "GOOGLE" : "CAFE24");
    if (input.productId === undefined) throw new BadRequestException("연결 상품 또는 명시적인 미배분(null)을 지정해 주세요.");
    if (input.productId && !await tx.product.findFirst({ where: { id: input.productId, isActive: true }, select: { id: true } }))
      throw new NotFoundException("활성 상품을 찾을 수 없습니다.");
    if (input.kind === "CAMPAIGN") {
      if (!input.campaignId || input.productNo || input.optionName) throw new BadRequestException("캠페인 ID만 지정해 주세요.");
      if (!await tx.googleCampaignDailyCost.findFirst({ where: { connectionId: input.connectionId, campaignId: input.campaignId }, select: { id: true } }))
        throw new NotFoundException("해당 계정에서 수집된 캠페인을 찾을 수 없습니다.");
    } else {
      if (!input.productNo || input.campaignId) throw new BadRequestException("카페24 상품번호를 지정해 주세요.");
      if (!await tx.cafe24OrderLine.findFirst({ where: { connectionId: input.connectionId, productNo: input.productNo,
        ...(configuration.optionScope === "EXACT" ? { optionName: input.optionName ?? "" } : {}), productName: { contains: "[유튜브]" } }, select: { id: true } }))
        throw new NotFoundException("해당 쇼핑몰에서 수집된 유튜브 상품번호/옵션을 찾을 수 없습니다.");
    }
    const dates = mappingDates(input);
    const identityKey = mappingIdentity(input.kind, input.campaignId, input.productNo, input.optionName, configuration.optionScope);
    const before = input.id ? await tx.googlePerformanceMapping.findUnique({ where: { id: input.id }, include: { product: { select: { displayName: true } } } }) : null;
    if (input.id && !before) throw new NotFoundException("매핑을 찾을 수 없습니다.");
    if (before && (before.connectionId !== input.connectionId || before.kind !== input.kind || before.identityKey !== identityKey))
      throw new BadRequestException("기존 매핑의 계정과 식별키는 바꿀 수 없습니다. 새 매핑을 생성해 주세요.");
    const overlaps = await tx.googlePerformanceMapping.findMany({ where: {
      connectionId: input.connectionId, kind: input.kind,
      ...(input.kind === "CAMPAIGN" ? { identityKey } : { productNo: input.productNo,
        ...(configuration.optionScope === "EXACT" ? { AND: [{ OR: [{ optionScope: "PRODUCT" }, { optionScope: "EXACT", optionName: input.optionName ?? "" }] }] } : {}) }),
      ...(input.id ? { id: { not: input.id } } : {}),
      ...(dates.endDate ? { startDate: { lte: dates.endDate } } : {}),
      OR: [{ endDate: null }, { endDate: { gte: dates.startDate } }]
    }, include: { product: { select: { displayName: true } } }, take: 101 });
    const after = { kind: input.kind, connectionId: input.connectionId, identityKey, campaignId: input.campaignId ?? null,
      productNo: input.productNo ?? null, optionName: input.optionName ?? "", productId: input.productId,
      ...configuration,
      startDate: input.startDate, endDate: input.endDate ?? null };
    const from = before && before.startDate < dates.startDate ? before.startDate : dates.startDate;
    const to = before && (!before.endDate || !dates.endDate) ? null : before?.endDate && dates.endDate && before.endDate > dates.endDate ? before.endDate : dates.endDate;
    return { before: before ? mappingJson(before) : null, after,
      affectedRange: { from: from.toISOString().slice(0, 10), to: to?.toISOString().slice(0, 10) ?? null },
      overlaps: overlaps.map(mappingJson), canSave: overlaps.length === 0 };
  }

  async save(input: GoogleMappingInput, actorUserId: string, id?: string) {
    assertGoogleEnabled();
    if (input.id && input.id !== id) throw new BadRequestException("매핑 ID가 요청 경로와 일치하지 않습니다.");
    try {
      return await this.prisma.$transaction(async tx => {
        // Same-connection saves serialize; exclusion constraint also protects non-API writers.
        await tx.$queryRaw(Prisma.sql`SELECT id FROM source_connections WHERE id=${input.connectionId}::uuid FOR UPDATE`);
        const prepared = await this.prepare(tx, { ...input, id });
        if (!prepared.canSave) throw new ConflictException({ code: "GOOGLE_MAPPING_OVERLAP", message: "적용 기간이 기존 매핑과 겹칩니다." });
        if (id && (!input.expectedUpdatedAt || prepared.before?.updatedAt !== input.expectedUpdatedAt))
          throw new ConflictException({ code: "GOOGLE_MAPPING_CHANGED", message: "매핑이 변경되었습니다. 새로고침해 주세요." });
        const data = { ...prepared.after, ...mappingDates(input) };
        const mapping = id ? await tx.googlePerformanceMapping.update({ where: { id }, data }) : await tx.googlePerformanceMapping.create({ data });
        const after = mappingJson(mapping);
        await tx.googleMappingAudit.create({ data: { mappingId: mapping.id, actorUserId,
          before: prepared.before ? JSON.parse(JSON.stringify(prepared.before)) : Prisma.DbNull,
          after: JSON.parse(JSON.stringify(after)) } });
        // Reads are uncached, so the affected interval is immediately recomputed on the next request.
        return { mapping: after, affectedRange: prepared.affectedRange };
      }, { timeout: 15_000 });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && ["P2004", "P2010", "P2034"].includes(error.code))
        throw new ConflictException({ code: "GOOGLE_MAPPING_CONFLICT", message: "동시 매핑 변경 또는 기간 중복입니다. 새로고침해 주세요." });
      throw error;
    }
  }
}
