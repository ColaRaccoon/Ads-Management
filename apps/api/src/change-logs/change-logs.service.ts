import { BadRequestException, Injectable } from "@nestjs/common";
import { AdStage, Prisma } from "@prisma/client";
import { PrismaService } from "../common/prisma.service";
import { asDateOnly, parseDateRange } from "../common/date-range";

const ACTION_TYPES = new Set(["TURN_OFF", "BUDGET_CHANGE", "PROMOTE_STAGE", "DEMOTE_STAGE", "CREATIVE_EXCLUDE", "NOTE"]);
const TARGET_TYPES = new Set(["PRODUCT", "ADSET", "STAGE"]);

@Injectable()
export class ChangeLogsService {
  constructor(private readonly prisma: PrismaService) {}

  list(from?: string, to?: string) {
    const where =
      from && to
        ? { actionDate: { gte: parseDateRange(from, to).fromDate, lte: parseDateRange(from, to).toDate } }
        : undefined;
    return this.prisma.changeLog.findMany({
      where,
      orderBy: [{ actionDate: "desc" }, { createdAt: "desc" }],
      include: { product: true, metaAdset: true, relatedDecision: true }
    });
  }

  create(body: Record<string, unknown>) {
    const actionType = requiredEnum(body.actionType, ACTION_TYPES, "actionType");
    const targetType = requiredEnum(body.targetType, TARGET_TYPES, "targetType");
    return this.prisma.changeLog.create({
      data: {
        actionDate: body.actionDate ? asDateOnly(String(body.actionDate)) : asDateOnly(new Date().toISOString().slice(0, 10)),
        actionType,
        targetType,
        productId: optionalString(body.productId),
        metaAdsetId: optionalString(body.metaAdsetId),
        stageFrom: parseStageOrNull(body.stageFrom),
        stageTo: parseStageOrNull(body.stageTo),
        previousValue: body.previousValue === undefined ? undefined : (body.previousValue as Prisma.InputJsonValue),
        newValue: body.newValue === undefined ? undefined : (body.newValue as Prisma.InputJsonValue),
        reason: requiredString(body.reason, "reason"),
        relatedDecisionId: optionalString(body.relatedDecisionId),
        nextCheckDate: body.nextCheckDate ? asDateOnly(String(body.nextCheckDate)) : null
      }
    });
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new BadRequestException({ code: "FIELD_REQUIRED", message: `${field} 값이 필요합니다.` });
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null || String(value).trim() === "") {
    return undefined;
  }
  return String(value).trim();
}

function requiredEnum(value: unknown, allowed: Set<string>, field: string) {
  const text = requiredString(value, field).toUpperCase();
  if (!allowed.has(text)) {
    throw new BadRequestException({ code: "INVALID_ENUM", message: `${field} 값이 올바르지 않습니다.` });
  }
  return text;
}

function parseStageOrNull(value: unknown): AdStage | null {
  if (value === undefined || value === null || String(value).trim() === "") {
    return null;
  }
  const text = String(value).toUpperCase();
  if (text in AdStage) {
    return AdStage[text as keyof typeof AdStage];
  }
  throw new BadRequestException({ code: "INVALID_STAGE", message: "stage 값이 올바르지 않습니다." });
}
