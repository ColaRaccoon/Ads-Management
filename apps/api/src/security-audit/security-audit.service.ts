import { BadRequestException, HttpException, HttpStatus, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../common/prisma.service";
import { ListSecurityAuditDto } from "./dto/list-security-audit.dto";

type Cursor = { createdAt: string; id: string };

@Injectable()
export class SecurityAuditService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ListSecurityAuditDto) {
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    if (query.from && query.to && new Date(query.from) > new Date(query.to)) {
      throw new BadRequestException({
        code: "AUDIT_FILTER_INVALID",
        message: "The audit date range is invalid.",
        details: null
      });
    }
    const dateFilter: Prisma.DateTimeFilter = {};
    if (query.from) dateFilter.gte = new Date(query.from);
    if (query.to) dateFilter.lte = new Date(query.to);
    const createdAt = Object.keys(dateFilter).length ? dateFilter : undefined;
    const cursorFilter: Prisma.SecurityAuditEventWhereInput | undefined = cursor
      ? {
          OR: [
            { createdAt: { lt: new Date(cursor.createdAt) } },
            { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } }
          ]
        }
      : undefined;
    let items;
    try {
      items = await this.prisma.securityAuditEvent.findMany({
      where: {
        action: query.action,
        targetType: query.targetType,
        result: query.result,
        actorType: query.actorType,
        actorUserId: query.actorUserId,
        createdAt,
        AND: cursorFilter
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: query.limit + 1,
      select: {
        id: true,
        actorUserId: true,
        actorType: true,
        action: true,
        targetType: true,
        targetId: true,
        result: true,
        beforeJson: true,
        afterJson: true,
        requestId: true,
        createdAt: true
      }
      });
    } catch {
      throw new HttpException({
        code: "AUDIT_QUERY_FAILED",
        message: "The security audit could not be queried.",
        details: null
      }, HttpStatus.INTERNAL_SERVER_ERROR);
    }
    const hasMore = items.length > query.limit;
    const page = hasMore ? items.slice(0, query.limit) : items;
    const last = page.at(-1);
    return {
      items: page,
      nextCursor: hasMore && last
        ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
        : null
    };
  }
}

function encodeCursor(cursor: Cursor) {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string): Cursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<Cursor>;
    if (
      typeof parsed.createdAt !== "string" ||
      Number.isNaN(new Date(parsed.createdAt).getTime()) ||
      typeof parsed.id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed.id)
    ) throw new Error();
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    throw new BadRequestException({
      code: "AUDIT_CURSOR_INVALID",
      message: "The audit cursor is invalid.",
      details: null
    });
  }
}
