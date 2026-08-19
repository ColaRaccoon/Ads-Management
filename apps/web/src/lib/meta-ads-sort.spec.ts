import { describe, expect, it } from "vitest";
import type { MetaCreativePerformanceRow } from "@/types/meta";
import { sortMetaCreativeRows } from "./meta-ads-sort";

describe("Meta Ads sorting", () => {
  it("sorts video rates numerically and always leaves null last", () => {
    const rows = [row("null", null), row("high", 48.81), row("zero", 0)];

    expect(sortMetaCreativeRows(rows, "videoPlay3sRatePct", "asc").map((item) => item.displayName))
      .toEqual(["zero", "high", "null"]);
    expect(sortMetaCreativeRows(rows, "videoPlay3sRatePct", "desc").map((item) => item.displayName))
      .toEqual(["high", "zero", "null"]);
  });

  it("sorts net profit numerically and leaves unavailable profit last", () => {
    const rows = [row("loss", 0, -1_000), row("unknown", 0, null), row("profit", 0, 2_000)];

    expect(sortMetaCreativeRows(rows, "profit", "desc").map((item) => item.displayName))
      .toEqual(["profit", "loss", "unknown"]);
  });
});

function row(
  displayName: string,
  videoPlay3sRatePct: number | null,
  marginKrw: number | null = 0
): MetaCreativePerformanceRow {
  return {
    creativeKey: displayName,
    displayName,
    productName: "제품",
    productId: "product-1",
    materialNo: null,
    deliveryStatus: "active",
    dataDays: 1,
    totals: {
      spendUsd: 0,
      spendKrw: 0,
      purchaseCount: 0,
      cpaUsd: null,
      cpaKrw: null,
      ctrLinkPct: null,
      cpmUsd: null,
      roas: null,
      revenueKrw: 0,
      marginKrw,
      reach: 10,
      videoPlay3sCount: videoPlay3sRatePct === null ? null : 0,
      videoPlay25Count: null,
      videoPlay50Count: null,
      videoPlay75Count: null,
      videoPlay100Count: null,
      videoPlay3sRatePct,
      videoPlay25RatePct: null,
      videoPlay50RatePct: null,
      videoPlay75RatePct: null,
      videoPlay100RatePct: null
    }
  };
}
