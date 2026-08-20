import { describe, expect, it } from "vitest";
import {
  applyCreativeTrendResponseSelection,
  beginCreativeProductSelectionTransition,
  buildCreativeMetricChartModel,
  buildThreeSecondInsight,
  CREATIVE_TREND_COLORS,
  creativeLabel,
  formatTrendMetricValue,
  isolatedMetricPointIndexes,
  latestMetricAverage,
  productLabel,
  reconcileCreativeSelection,
  selectDefaultCreativeKeys,
  trendPercentAxisMaximum
} from "./meta-creative-trends";
import type { MetaCreativeVideoTrendSeries } from "@/types/meta";

describe("meta creative trend display model", () => {
  it("fills every selected date with null while preserving real zero and API percentages", () => {
    const creative = trendSeries({
      creativeKey: "creative.with[special]",
      points: [
        trendPoint("2026-08-01", { reach: 0, videoPlay3sRatePct: 48.81 }),
        trendPoint("2026-08-03", { reach: 30, videoPlay3sRatePct: 0 })
      ]
    });

    const reachModel = buildCreativeMetricChartModel({
      creatives: [creative],
      selectedKeys: new Set([creative.creativeKey]),
      metricKey: "reach",
      from: "2026-08-01",
      to: "2026-08-03"
    });
    const rateModel = buildCreativeMetricChartModel({
      creatives: [creative],
      selectedKeys: new Set([creative.creativeKey]),
      metricKey: "videoPlay3sRatePct",
      from: "2026-08-01",
      to: "2026-08-03"
    });

    expect(reachModel.lines).toEqual([expect.objectContaining({
      dataKey: "series_0",
      creativeKey: "creative.with[special]"
    })]);
    expect(reachModel.points).toEqual([
      { date: "2026-08-01", series_0: 0 },
      { date: "2026-08-02", series_0: null },
      { date: "2026-08-03", series_0: 30 }
    ]);
    expect(rateModel.points[0].series_0).toBe(48.81);
    expect(rateModel.points[2].series_0).toBe(0);
  });

  it("keeps line data keys and colors tied to the full creative order", () => {
    const creatives = [
      trendSeries({ creativeKey: "a", materialNo: "1" }),
      trendSeries({ creativeKey: "b", materialNo: "2" }),
      trendSeries({ creativeKey: "c", materialNo: "3" })
    ];

    const model = buildCreativeMetricChartModel({
      creatives,
      selectedKeys: new Set(["c"]),
      metricKey: "reach",
      from: "2026-08-01",
      to: "2026-08-01"
    });

    expect(model.lines).toEqual([expect.objectContaining({
      creativeKey: "c",
      dataKey: "series_2",
      color: CREATIVE_TREND_COLORS[2]
    })]);
  });

  it("marks only isolated valid values for sparse point dots", () => {
    const model = buildCreativeMetricChartModel({
      creatives: [trendSeries({
        points: [
          trendPoint("2026-08-01", { reach: 10 }),
          trendPoint("2026-08-03", { reach: 20 }),
          trendPoint("2026-08-04", { reach: 30 }),
          trendPoint("2026-08-06", { reach: 0 })
        ]
      })],
      selectedKeys: new Set(["creative-1"]),
      metricKey: "reach",
      from: "2026-08-01",
      to: "2026-08-06"
    });

    expect([...isolatedMetricPointIndexes(model, "series_0")]).toEqual([0, 5]);
  });

  it("uses the actual percentage maximum instead of capping the axis at 100", () => {
    const model = buildCreativeMetricChartModel({
      creatives: [trendSeries({
        points: [trendPoint("2026-08-01", { videoPlay3sRatePct: 124.1 })]
      })],
      selectedKeys: new Set(["creative-1"]),
      metricKey: "videoPlay3sRatePct",
      from: "2026-08-01",
      to: "2026-08-01"
    });

    expect(trendPercentAxisMaximum(model)).toBe(130);
  });

  it("averages the final selected date and excludes null values", () => {
    const model = buildCreativeMetricChartModel({
      creatives: [
        trendSeries({ creativeKey: "a", points: [trendPoint("2026-08-02", { reach: 10 })] }),
        trendSeries({ creativeKey: "b", points: [trendPoint("2026-08-02", { reach: 20 })] }),
        trendSeries({ creativeKey: "c", points: [] })
      ],
      selectedKeys: new Set(["a", "b", "c"]),
      metricKey: "reach",
      from: "2026-08-01",
      to: "2026-08-02"
    });

    const modelWithEmptyTrailingDate = {
      ...model,
      points: [...model.points, { date: "2026-08-03", series_0: null, series_1: null, series_2: null }]
    };
    expect(latestMetricAverage(modelWithEmptyTrailingDate)).toBe(15);
    expect(latestMetricAverage({ ...model, points: [{ date: "2026-08-02", series_0: null }] })).toBeNull();
  });

  it("builds the three-second insight from each creative's first and last known values", () => {
    const creatives = [
      trendSeries({
        creativeKey: "up-small",
        materialNo: "2",
        points: [
          trendPoint("2026-08-01", { videoPlay3sRatePct: 40 }),
          trendPoint("2026-08-02", { videoPlay3sRatePct: null }),
          trendPoint("2026-08-03", { videoPlay3sRatePct: 43 })
        ]
      }),
      trendSeries({
        creativeKey: "up-best",
        materialNo: "10",
        points: [
          trendPoint("2026-08-01", { videoPlay3sRatePct: 30 }),
          trendPoint("2026-08-03", { videoPlay3sRatePct: 38 })
        ]
      })
    ];

    expect(buildThreeSecondInsight(creatives, new Set(creatives.map((creative) => creative.creativeKey))))
      .toEqual({
        creativeKey: "up-best",
        label: "10번 소재",
        changePctPoints: 8,
        direction: "up"
      });
  });

  it("uses the largest absolute change when no creative improves and rejects one-point comparisons", () => {
    const onePoint = trendSeries({
      creativeKey: "one",
      points: [trendPoint("2026-08-01", { videoPlay3sRatePct: 50 })]
    });
    const down = trendSeries({
      creativeKey: "down",
      materialNo: "4번소재",
      points: [
        trendPoint("2026-08-01", { videoPlay3sRatePct: 50 }),
        trendPoint("2026-08-03", { videoPlay3sRatePct: 41 })
      ]
    });

    expect(buildThreeSecondInsight([onePoint], new Set(["one"]))).toBeNull();
    expect(buildThreeSecondInsight([onePoint, down], new Set(["one", "down"]))).toEqual({
      creativeKey: "down",
      label: "4번 소재",
      changePctPoints: -9,
      direction: "down"
    });
  });

  it("resets to the first three creatives for a product change and reconciles a period change", () => {
    const creatives = ["a", "b", "c", "d"].map((creativeKey) => trendSeries({ creativeKey }));

    expect([...selectDefaultCreativeKeys(creatives)]).toEqual(["a", "b", "c"]);
    expect([...reconcileCreativeSelection(new Set(["b", "missing"]), creatives, false)]).toEqual(["b"]);
    expect([...reconcileCreativeSelection(new Set(["missing"]), creatives, false)]).toEqual(["a", "b", "c"]);
    expect([...reconcileCreativeSelection(new Set(["d"]), creatives, true)]).toEqual(["a", "b", "c"]);
    expect([...reconcileCreativeSelection(new Set(["a"]), [], false)]).toEqual([]);
  });

  it("restores defaults when a product transition returns quickly to a cached scope", () => {
    const creativesA = ["a1", "a2", "a3", "a4"].map((creativeKey) => trendSeries({ creativeKey }));
    const scopeA = { productId: "product-a", from: "2026-08-01", to: "2026-08-14" };
    const beforeChange = { scope: scopeA, selectedKeys: new Set(["a4"]) };

    const transitioning = beginCreativeProductSelectionTransition();
    const cachedAResponse = applyCreativeTrendResponseSelection(transitioning, creativesA, scopeA);

    expect(beforeChange.scope).toEqual(scopeA);
    expect(transitioning.scope).toBeNull();
    expect([...cachedAResponse.selectedKeys]).toEqual(["a1", "a2", "a3"]);
  });

  it("prunes stale keys on same-scope refetch while preserving an intentional empty selection", () => {
    const scope = { productId: "product-a", from: "2026-08-01", to: "2026-08-14" };
    const creatives = ["keep", "new"].map((creativeKey) => trendSeries({ creativeKey }));

    const pruned = applyCreativeTrendResponseSelection(
      { scope, selectedKeys: new Set(["keep", "stale"]) },
      creatives,
      scope
    );
    const remainsEmpty = applyCreativeTrendResponseSelection(
      { scope, selectedKeys: new Set() },
      creatives,
      scope
    );

    expect([...pruned.selectedKeys]).toEqual(["keep"]);
    expect([...remainsEmpty.selectedKeys]).toEqual([]);
  });

  it("formats product, creative, count, and percentage labels", () => {
    expect(productLabel({ id: "p", code: "code", name: "name", displayName: "표시명", isActive: true })).toBe("표시명");
    expect(productLabel({ id: "p", code: "code", name: "name", displayName: " ", isActive: true })).toBe("name");
    expect(creativeLabel(trendSeries({ materialNo: "04" }))).toBe("04번 소재");
    expect(creativeLabel(trendSeries({ materialNo: null, displayName: "소재 이름" }))).toBe("소재 이름");
    expect(formatTrendMetricValue(1234, "reach")).toBe("1,234명");
    expect(formatTrendMetricValue(1.234, "cpcLinkUsd")).toBe("$1.23");
    expect(formatTrendMetricValue(0, "cpmUsd")).toBe("$0");
    expect(formatTrendMetricValue(2.5, "addToCartRatePct")).toBe("2.50%");
    expect(formatTrendMetricValue(48.81, "videoPlay3sRatePct")).toBe("48.81%");
    expect(formatTrendMetricValue(null, "videoPlay3sRatePct")).toBe("-");
  });
});

function trendSeries(overrides: Partial<MetaCreativeVideoTrendSeries> = {}): MetaCreativeVideoTrendSeries {
  return {
    creativeKey: "creative-1",
    displayName: "제품_01",
    productName: "제품",
    materialNo: "01",
    deliveryStatus: "active",
    originalAdNames: ["260801_제품_01_IG"],
    dataDays: 1,
    points: [trendPoint("2026-08-01")],
    ...overrides
  };
}

function trendPoint(
  date: string,
  overrides: Partial<MetaCreativeVideoTrendSeries["points"][number]> = {}
): MetaCreativeVideoTrendSeries["points"][number] {
  return {
    date,
    reach: 100,
    cpmUsd: 10,
    cpcLinkUsd: 0.5,
    ctrLinkPct: 2,
    addToCartRatePct: 1,
    videoPlay3sRatePct: 50,
    videoPlay25RatePct: 20,
    videoPlay50RatePct: 10,
    videoPlay75RatePct: 5,
    videoPlay100RatePct: 2,
    ...overrides
  };
}
