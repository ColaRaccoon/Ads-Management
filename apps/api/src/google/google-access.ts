import { BadRequestException, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { Prisma } from "@prisma/client";

export function assertGoogleEnabled() {
  if (process.env.GOOGLE_PERFORMANCE_ENABLED !== "true") throw new ServiceUnavailableException({
    code: "GOOGLE_PERFORMANCE_DISABLED", message: "Google 독립 성과 기능이 비활성화되어 있습니다." });
}

// This application has workspace-wide role permissions, not per-user account ACLs.
// Reject account/provider substitution at every Google boundary.
export async function googleConnection(tx: Prisma.TransactionClient, id: string, provider: "GOOGLE" | "CAFE24") {
  const connection = await tx.sourceConnection.findUnique({ where: { id }, select: {
    id: true, provider: true, displayName: true, externalAccountId: true, currencyCode: true, timeZone: true
  } });
  if (!connection || connection.provider !== provider) throw new NotFoundException({ code: "GOOGLE_CONNECTION_NOT_FOUND", message: "해당 채널의 연결을 찾을 수 없습니다." });
  return connection;
}

export function googleBound(rows: unknown[], maximum = 50_000) {
  if (rows.length > maximum) throw new BadRequestException({ code: "GOOGLE_RANGE_TOO_LARGE", message: "조회량이 많습니다. 기간 또는 계정 범위를 줄여 주세요." });
}
