import { BadRequestException } from "@nestjs/common";
import { dateRangeDays, formatDateOnly, toDateOnly } from "../domain/date-number";

export { dateRangeDays };

export type DateRange = {
  from: string;
  to: string;
  fromDate: Date;
  toDate: Date;
};

export function parseDateRange(from?: string, to?: string): DateRange {
  if (!from || !to) {
    throw new BadRequestException({ code: "DATE_RANGE_REQUIRED", message: "from과 to 날짜가 필요합니다." });
  }
  const fromDate = toDateOnly(from);
  const toDate = toDateOnly(to);
  if (!fromDate || !toDate || toDate < fromDate) {
    throw new BadRequestException({ code: "INVALID_DATE_RANGE", message: "날짜 범위가 올바르지 않습니다." });
  }
  return { from: formatDateOnly(fromDate), to: formatDateOnly(toDate), fromDate, toDate };
}

export function asDateOnly(value: string): Date {
  const parsed = toDateOnly(value);
  if (!parsed) {
    throw new BadRequestException({ code: "INVALID_DATE", message: `${value} 날짜 형식이 올바르지 않습니다.` });
  }
  return parsed;
}

export function numberFrom(value: unknown): number {
  if (value === null || value === undefined) {
    return 0;
  }
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "object" && "toNumber" in value && typeof value.toNumber === "function") {
    return value.toNumber();
  }
  return Number(value);
}
