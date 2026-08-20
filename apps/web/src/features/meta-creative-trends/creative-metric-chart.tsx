"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import { numberFmt } from "@/lib/date-range";
import {
  formatTrendDateTick,
  formatTrendMetricValue,
  isolatedMetricPointIndexes,
  latestMetricAverage,
  trendPercentAxisMaximum,
  type CreativeChartPoint,
  type CreativeMetricChartModel
} from "@/lib/meta-creative-trends";
import { META_CREATIVE_TREND_METRICS } from "@/lib/meta-video-display";
import type { MetaCreativeTrendMetricKey } from "@/types/meta";

type TrendMetric = (typeof META_CREATIVE_TREND_METRICS)[number];

export function CreativeMetricChart({ metric, model }: { metric: TrendMetric; model: CreativeMetricChartModel }) {
  const latestAverage = latestMetricAverage(model);
  const isPercent = metric.unit === "percent";
  const yDomain: [number, number | "auto"] = isPercent
    ? [0, trendPercentAxisMaximum(model)]
    : [0, "auto"];

  return (
    <article aria-label={`${metric.label} 선 그래프`} className="creative-trend-chart-card">
      <div className="creative-trend-chart-card-header">
        <span className="creative-trend-chart-title">
          <strong>{metric.label}</strong>
          <small>{metric.description}</small>
        </span>
        <span className="creative-trend-latest-chip">
          마지막 데이터 평균 {formatTrendMetricValue(latestAverage, metric.key)}
        </span>
      </div>
      <div className="creative-trend-chart-box">
        <ResponsiveContainer height="100%" width="100%">
          <LineChart data={model.points} margin={{ top: 12, right: 14, bottom: 2, left: 0 }}>
            <CartesianGrid stroke="#e8ecef" strokeDasharray="3 3" vertical={false} />
            <XAxis
              axisLine={false}
              dataKey="date"
              minTickGap={24}
              tick={{ fill: "#788591", fontSize: 10 }}
              tickFormatter={formatTrendDateTick}
              tickLine={false}
            />
            <YAxis
              allowDecimals={metric.unit !== "count"}
              axisLine={false}
              domain={yDomain}
              tick={{ fill: "#788591", fontSize: 10 }}
              tickFormatter={(value: number) => formatAxisTick(value, metric.key)}
              tickLine={false}
              width={50}
            />
            <Tooltip
              content={<CreativeTrendTooltip metricKey={metric.key} lines={model.lines} />}
              cursor={{ stroke: "#aeb8c1", strokeDasharray: "3 3" }}
              filterNull={false}
            />
            {model.lines.map((line) => (
              <Line
                activeDot={{ r: 4 }}
                connectNulls={false}
                dataKey={line.dataKey}
                dot={(
                  <IsolatedMetricPointDot
                    color={line.color}
                    isolatedIndexes={isolatedMetricPointIndexes(model, line.dataKey)}
                    label={line.label}
                    metricKey={metric.key}
                  />
                )}
                isAnimationActive={false}
                key={line.creativeKey}
                name={line.label}
                stroke={line.color}
                strokeWidth={2}
                type="monotone"
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </article>
  );
}

function IsolatedMetricPointDot({
  color,
  cx,
  cy,
  index,
  isolatedIndexes,
  label,
  metricKey,
  payload,
  value
}: {
  color: string;
  cx?: number;
  cy?: number;
  index?: number;
  isolatedIndexes: ReadonlySet<number>;
  label: string;
  metricKey: MetaCreativeTrendMetricKey;
  payload?: CreativeChartPoint;
  value?: number | null;
}) {
  if (
    index === undefined
    || cx === undefined
    || cy === undefined
    || !isolatedIndexes.has(index)
    || typeof value !== "number"
    || !Number.isFinite(value)
  ) {
    return null;
  }
  const accessibleLabel = `${payload?.date ?? "날짜 미상"} · ${label} · ${formatTrendMetricValue(value, metricKey)}`;
  return (
    <circle
      aria-label={accessibleLabel}
      cx={cx}
      cy={cy}
      fill={color}
      r={3.5}
      role="img"
      stroke="#fff"
      strokeWidth={1.5}
      tabIndex={0}
    >
      <title>{accessibleLabel}</title>
    </circle>
  );
}

function CreativeTrendTooltip({
  active,
  payload,
  label,
  lines,
  metricKey
}: {
  active?: boolean;
  payload?: Array<{ payload?: CreativeChartPoint }>;
  label?: string | number;
  lines: CreativeMetricChartModel["lines"];
  metricKey: MetaCreativeTrendMetricKey;
}) {
  if (!active) {
    return null;
  }
  const point = payload?.find((item) => item.payload)?.payload;
  return (
    <div className="creative-trend-tooltip">
      <strong>{String(label ?? point?.date ?? "-")}</strong>
      {lines.map((line) => (
        <span key={line.creativeKey}>
          <i aria-hidden="true" style={{ backgroundColor: line.color }} />
          <b>{line.label}</b>
          <em>{formatTrendMetricValue(point?.[line.dataKey] as number | null | undefined, metricKey)}</em>
        </span>
      ))}
    </div>
  );
}

function formatAxisTick(value: number, metricKey: MetaCreativeTrendMetricKey) {
  if (metricKey === "reach") {
    if (Math.abs(value) >= 1000) {
      const thousands = value / 1000;
      return `${thousands.toLocaleString("ko-KR", { maximumFractionDigits: thousands < 10 ? 1 : 0 })}k`;
    }
    return numberFmt(value);
  }
  if (metricKey === "cpmUsd" || metricKey === "cpcLinkUsd") {
    return `$${value.toLocaleString("en-US", { maximumFractionDigits: value < 10 ? 2 : 1 })}`;
  }
  return `${Math.round(value)}%`;
}
