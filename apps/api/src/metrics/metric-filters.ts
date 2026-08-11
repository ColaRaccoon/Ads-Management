import { BadRequestException } from "@nestjs/common";
import { Prisma } from "@prisma/client";

export type DeliveryStatusFilter = "active" | "inactive" | "all";

export function parseDeliveryStatusFilter(value?: string): DeliveryStatusFilter {
  if (!value) {
    return "active";
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "active" || normalized === "inactive" || normalized === "all") {
    return normalized;
  }
  throw new BadRequestException({
    code: "INVALID_DELIVERY_STATUS",
    message: "deliveryStatus must be active, inactive, or all."
  });
}

export function deliveryStatusWhere(filter: DeliveryStatusFilter): Prisma.MetaAdsetDailyMetricWhereInput {
  if (filter === "all") {
    return {};
  }
  return { deliveryStatus: { equals: filter, mode: "insensitive" } };
}

export function adDeliveryStatusWhere(filter: DeliveryStatusFilter): Prisma.MetaAdDailyMetricWhereInput {
  if (filter === "all") {
    return {};
  }
  return { adDeliveryStatus: { equals: filter, mode: "insensitive" } };
}

export function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
