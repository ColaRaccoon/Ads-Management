import { BadRequestException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { assertBusinessDate } from "./domain/product-name-resolver";
import { normalizePlatforms } from "./domain/platform-selection";
import type { Platform } from "./types";

export type ReportGrain = "day" | "week" | "month";
export interface ReportQuery {
  from: string; to: string; compareFrom: string; compareTo: string;
  platforms: Platform[]; scopeKeys?: string[]; productName?: string;
  grain: ReportGrain; limit: number; cursor?: string; selectionHash: string;
}
const DAY = 86400000;
export const shiftDate = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
export const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY) + 1;
export const reportHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const datesIn = (from: string, to: string) => Array.from({ length: daysBetween(from, to) }, (_, i) => shiftDate(from, i));
export function range(from: unknown, to: unknown, maximum = 366) {
  if (typeof from !== "string" || typeof to !== "string") throw new Error("날짜 범위가 필요합니다.");
  assertBusinessDate(from); assertBusinessDate(to);
  if (to < from || daysBetween(from, to) > maximum) throw new Error(`날짜 범위는 ${maximum}일 이하여야 합니다.`);
  return { from, to };
}
export function stringArray(value: unknown, field: string, maximum = 50): string[] | undefined {
  if (value === undefined) return undefined;
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(parsed) || parsed.length > maximum || parsed.some(v => typeof v !== "string" || !v.trim() || v.length > 256))
    throw new Error(`${field} 목록을 확인해 주세요.`);
  return [...new Set(parsed as string[])].sort();
}
export function parseReportQuery(input: Record<string, unknown>, now = new Date()): ReportQuery {
  try {
    const yesterday = shiftDate(new Date(now.getTime() + 9 * 3600000).toISOString().slice(0, 10), -1);
    if ((input.from === undefined) !== (input.to === undefined)) throw new Error("from과 to를 함께 지정해 주세요.");
    const current = input.from === undefined ? range(shiftDate(yesterday, -29), yesterday) : range(input.from, input.to);
    if ((input.compareFrom === undefined) !== (input.compareTo === undefined)) throw new Error("비교 날짜를 함께 지정해 주세요.");
    const previous = input.compareFrom === undefined ? range(shiftDate(current.from, -daysBetween(current.from, current.to)), shiftDate(current.from, -1)) : range(input.compareFrom, input.compareTo);
    const platforms = normalizePlatforms(input.platforms), scopeKeys = stringArray(input.scopeKeys, "scopeKeys");
    if (input.productName !== undefined && (typeof input.productName !== "string" || !input.productName.trim() || input.productName.length > 256)) throw new Error("기준 제품명을 확인해 주세요.");
    const productName = input.productName as string | undefined;
    const grain = input.grain ?? "day";
    if (!["day", "week", "month"].includes(String(grain))) throw new Error("grain을 확인해 주세요.");
    const limit = input.limit === undefined ? 100 : Number(input.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("limit은 1~100이어야 합니다.");
    if (input.cursor !== undefined && (typeof input.cursor !== "string" || input.cursor.length > 512)) throw new Error("cursor를 확인해 주세요.");
    const selection = { ...current, compareFrom: previous.from, compareTo: previous.to, platforms, scopeKeys, productName, grain: grain as ReportGrain };
    return { ...selection, limit, cursor: input.cursor as string | undefined, selectionHash: reportHash(selection) };
  } catch (error) {
    throw new BadRequestException({ code: "UNIFIED_QUERY_INVALID", message: error instanceof Error ? error.message : "조회 조건을 확인해 주세요." });
  }
}
export function reportBuckets(from: string, to: string, grain: ReportGrain) {
  const map = new Map<string, { date: string; bucketFrom: string; bucketTo: string; partial: boolean }>();
  for (const date of datesIn(from, to)) {
    const at = new Date(`${date}T00:00:00Z`);
    const start = grain === "day" ? date : grain === "week" ? shiftDate(date, -((at.getUTCDay() + 6) % 7)) : `${date.slice(0, 7)}-01`;
    const end = grain === "day" ? date : grain === "week" ? shiftDate(start, 6) : new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    map.set(start, { date: start, bucketFrom: start < from ? from : start, bucketTo: end > to ? to : end, partial: start < from || end > to });
  }
  return [...map.values()];
}
