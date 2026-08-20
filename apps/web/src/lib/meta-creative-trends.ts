import { eachDayOfInterval, format, isValid, parseISO } from "date-fns";
import { money, numberFmt } from "./date-range";
import { formatPercent } from "./meta-video-display";
import type {
  MetaCreativeTrendMetricKey,
  MetaCreativeVideoTrendSeries,
  MetaProductListItem
} from "@/types/meta";

export const CREATIVE_TREND_COLORS = [
  "#2764b7",
  "#dc7218",
  "#7b4ab6",
  "#137a45",
  "#b42318",
  "#147d9a",
  "#a15c00",
  "#6f7780"
] as const;

export const DEFAULT_TREND_METRIC_KEYS: ReadonlySet<MetaCreativeTrendMetricKey> = new Set([
  "reach",
  "videoPlay3sRatePct"
]);

export type CreativeChartLine = {
  dataKey: `series_${number}`;
  creativeKey: string;
  label: string;
  color: string;
};

export type CreativeChartPoint = {
  date: string;
  [key: string]: string | number | null;
};

export type CreativeMetricChartModel = {
  metricKey: MetaCreativeTrendMetricKey;
  lines: CreativeChartLine[];
  points: CreativeChartPoint[];
};

export type ThreeSecondInsight = {
  creativeKey: string;
  label: string;
  changePctPoints: number;
  direction: "up" | "down" | "flat";
};

export type CreativeSelectionScope = {
  productId: string;
  from: string;
  to: string;
};

export type CreativeSelectionState = {
  scope: CreativeSelectionScope | null;
  selectedKeys: ReadonlySet<string>;
};

export function productLabel(product: MetaProductListItem) {
  return product.displayName?.trim() || product.name?.trim() || product.code;
}

export function creativeLabel(series: MetaCreativeVideoTrendSeries) {
  if (!series.materialNo) {
    return series.displayName;
  }
  const materialNo = series.materialNo.replace(/\s*번\s*소재$/u, "").trim();
  return `${materialNo}번 소재`;
}

export function selectDefaultCreativeKeys(creatives: readonly MetaCreativeVideoTrendSeries[], limit = 3) {
  return new Set(creatives.slice(0, Math.max(0, limit)).map((creative) => creative.creativeKey));
}

export function reconcileCreativeSelection(
  previous: ReadonlySet<string>,
  creatives: readonly MetaCreativeVideoTrendSeries[],
  productChanged: boolean
) {
  if (creatives.length === 0) {
    return new Set<string>();
  }
  if (productChanged) {
    return selectDefaultCreativeKeys(creatives);
  }
  const available = new Set(creatives.map((creative) => creative.creativeKey));
  const intersection = new Set([...previous].filter((creativeKey) => available.has(creativeKey)));
  return intersection.size > 0 ? intersection : selectDefaultCreativeKeys(creatives);
}

export function beginCreativeProductSelectionTransition(): CreativeSelectionState {
  return { scope: null, selectedKeys: new Set<string>() };
}

export function applyCreativeTrendResponseSelection(
  state: CreativeSelectionState,
  creatives: readonly MetaCreativeVideoTrendSeries[],
  nextScope: CreativeSelectionScope
): CreativeSelectionState {
  const available = new Set(creatives.map((creative) => creative.creativeKey));
  if (sameCreativeSelectionScope(state.scope, nextScope)) {
    return {
      scope: nextScope,
      selectedKeys: new Set([...state.selectedKeys].filter((creativeKey) => available.has(creativeKey)))
    };
  }
  return {
    scope: nextScope,
    selectedKeys: reconcileCreativeSelection(
      state.selectedKeys,
      creatives,
      state.scope?.productId !== nextScope.productId
    )
  };
}

export function buildCreativeMetricChartModel({
  creatives,
  selectedKeys,
  metricKey,
  from,
  to
}: {
  creatives: readonly MetaCreativeVideoTrendSeries[];
  selectedKeys: ReadonlySet<string>;
  metricKey: MetaCreativeTrendMetricKey;
  from: string;
  to: string;
}): CreativeMetricChartModel {
  const selected = creatives
    .map((creative, index) => ({ creative, index }))
    .filter(({ creative }) => selectedKeys.has(creative.creativeKey));
  const lines = selected.map(({ creative, index }): CreativeChartLine => ({
    dataKey: `series_${index}`,
    creativeKey: creative.creativeKey,
    label: creativeLabel(creative),
    color: CREATIVE_TREND_COLORS[index % CREATIVE_TREND_COLORS.length]
  }));
  const pointMaps = new Map(
    selected.map(({ creative }) => [
      creative.creativeKey,
      new Map(creative.points.map((point) => [point.date, point]))
    ])
  );
  const points = trendDates(from, to).map((date) => {
    const chartPoint: CreativeChartPoint = { date };
    for (const line of lines) {
      const sourcePoint = pointMaps.get(line.creativeKey)?.get(date);
      chartPoint[line.dataKey] = sourcePoint?.[metricKey] ?? null;
    }
    return chartPoint;
  });

  return { metricKey, lines, points };
}

export function latestMetricAverage(model: CreativeMetricChartModel) {
  const latestPoint = [...model.points].reverse().find((point) =>
    model.lines.some((line) => isFiniteNumber(point[line.dataKey]))
  );
  if (!latestPoint) {
    return null;
  }
  const values = model.lines
    .map((line) => latestPoint[line.dataKey])
    .filter(isFiniteNumber);
  if (values.length === 0) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function isolatedMetricPointIndexes(
  model: CreativeMetricChartModel,
  dataKey: CreativeChartLine["dataKey"]
) {
  const isolated = new Set<number>();
  for (let index = 0; index < model.points.length; index += 1) {
    if (!isFiniteNumber(model.points[index][dataKey])) continue;
    const previousIsKnown = index > 0 && isFiniteNumber(model.points[index - 1][dataKey]);
    const nextIsKnown = index < model.points.length - 1 && isFiniteNumber(model.points[index + 1][dataKey]);
    if (!previousIsKnown && !nextIsKnown) {
      isolated.add(index);
    }
  }
  return isolated;
}

export function trendPercentAxisMaximum(model: CreativeMetricChartModel) {
  const maximum = model.points.reduce((currentMaximum, point) => {
    const pointMaximum = model.lines.reduce((lineMaximum, line) => {
      const value = point[line.dataKey];
      return isFiniteNumber(value) ? Math.max(lineMaximum, value) : lineMaximum;
    }, 0);
    return Math.max(currentMaximum, pointMaximum);
  }, 0);
  return Math.max(10, Math.ceil(maximum / 10) * 10);
}

export function buildThreeSecondInsight(
  creatives: readonly MetaCreativeVideoTrendSeries[],
  selectedKeys: ReadonlySet<string>
): ThreeSecondInsight | null {
  const candidates = creatives
    .filter((creative) => selectedKeys.has(creative.creativeKey))
    .map((creative) => {
      const values = [...creative.points]
        .sort((left, right) => left.date.localeCompare(right.date))
        .map((point) => point.videoPlay3sRatePct)
        .filter(isFiniteNumber);
      if (values.length < 2) {
        return null;
      }
      return {
        creativeKey: creative.creativeKey,
        label: creativeLabel(creative),
        changePctPoints: values[values.length - 1] - values[0]
      };
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null);
  if (candidates.length === 0) {
    return null;
  }

  const improvements = candidates.filter((candidate) => candidate.changePctPoints > 0);
  const selected = (improvements.length > 0 ? improvements : candidates).reduce((best, candidate) => {
    if (improvements.length > 0) {
      return candidate.changePctPoints > best.changePctPoints ? candidate : best;
    }
    return Math.abs(candidate.changePctPoints) > Math.abs(best.changePctPoints) ? candidate : best;
  });

  return {
    ...selected,
    direction: selected.changePctPoints > 0 ? "up" : selected.changePctPoints < 0 ? "down" : "flat"
  };
}

export function formatTrendDateTick(date: string) {
  const parsed = parseISO(date);
  return isValid(parsed) ? format(parsed, "MM.dd") : date;
}

export function trendSelectedDays(from: string, to: string) {
  return trendDates(from, to).length;
}

export function formatTrendMetricValue(value: number | null | undefined, metricKey: MetaCreativeTrendMetricKey) {
  if (metricKey === "reach") {
    return value === null || value === undefined || !Number.isFinite(value) ? "-" : `${numberFmt(value)}명`;
  }
  if (metricKey === "cpmUsd" || metricKey === "cpcLinkUsd") {
    return money(value, "USD");
  }
  return formatPercent(value);
}

function trendDates(from: string, to: string) {
  const start = parseISO(from);
  const end = parseISO(to);
  if (!isValid(start) || !isValid(end) || end < start) {
    return [];
  }
  return eachDayOfInterval({ start, end }).map((date) => format(date, "yyyy-MM-dd"));
}

function sameCreativeSelectionScope(left: CreativeSelectionScope | null, right: CreativeSelectionScope) {
  return left?.productId === right.productId && left.from === right.from && left.to === right.to;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
