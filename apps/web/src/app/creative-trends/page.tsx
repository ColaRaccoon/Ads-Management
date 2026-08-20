"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowDownRight, ArrowRight, ArrowUpRight, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { CreativeMetricChart } from "@/features/meta-creative-trends/creative-metric-chart";
import { CreativeTrendControls } from "@/features/meta-creative-trends/creative-trend-controls";
import { apiGet, rangeQuery } from "@/lib/api";
import {
  applyCreativeTrendResponseSelection,
  beginCreativeProductSelectionTransition,
  buildCreativeMetricChartModel,
  buildThreeSecondInsight,
  CREATIVE_TREND_COLORS,
  creativeLabel,
  DEFAULT_TREND_METRIC_KEYS,
  productLabel,
  selectDefaultCreativeKeys,
  trendSelectedDays,
  type CreativeSelectionScope
} from "@/lib/meta-creative-trends";
import { META_CREATIVE_TREND_METRICS } from "@/lib/meta-video-display";
import { useRange } from "@/lib/use-range";
import type {
  MetaCreativeTrendMetricKey,
  MetaCreativeVideoTrendResponse,
  MetaProductListItem
} from "@/types/meta";

export default function CreativeTrendsPage() {
  const range = useRange();
  const [isMounted, setIsMounted] = useState(false);
  const [selectedProductId, setSelectedProductId] = useState("");
  const [selectedCreativeKeys, setSelectedCreativeKeys] = useState<Set<string>>(() => new Set());
  const [selectedMetricKeys, setSelectedMetricKeys] = useState<Set<MetaCreativeTrendMetricKey>>(
    () => new Set(DEFAULT_TREND_METRIC_KEYS)
  );
  const selectionScopeRef = useRef<CreativeSelectionScope | null>(null);

  useEffect(() => setIsMounted(true), []);

  const productsQuery = useQuery({
    queryKey: ["products"],
    queryFn: () => apiGet<MetaProductListItem[]>("/products")
  });
  const products = useMemo(
    () => (productsQuery.data ?? []).filter((product) => product.isActive !== false),
    [productsQuery.data]
  );

  useEffect(() => {
    if (!productsQuery.isSuccess) return;
    const currentIsAvailable = products.some((product) => product.id === selectedProductId);
    if (currentIsAvailable) return;
    const transition = beginCreativeProductSelectionTransition();
    selectionScopeRef.current = transition.scope;
    setSelectedProductId(products[0]?.id ?? "");
    setSelectedCreativeKeys(new Set(transition.selectedKeys));
  }, [products, productsQuery.isSuccess, selectedProductId]);

  const trendsQuery = useQuery({
    queryKey: ["meta-creative-video-trends", range.from, range.to, selectedProductId],
    queryFn: () => apiGet<MetaCreativeVideoTrendResponse>(
      `/metrics/ads/creative-video-trends?${rangeQuery(range, {
        productId: selectedProductId,
        deliveryStatus: "active"
      })}`
    ),
    enabled: isMounted && Boolean(selectedProductId) && productsQuery.isSuccess
  });
  const responseMatchesSelection = isMounted
    && trendsQuery.data?.productId === selectedProductId
    && trendsQuery.data.period.from === range.from
    && trendsQuery.data.period.to === range.to;
  const trendData = responseMatchesSelection ? trendsQuery.data : undefined;

  useEffect(() => {
    if (!trendData) return;
    const nextScope = selectionScope(selectedProductId, range.from, range.to);
    const previousScope = selectionScopeRef.current;
    selectionScopeRef.current = nextScope;
    setSelectedCreativeKeys((previous) => new Set(applyCreativeTrendResponseSelection(
      { scope: previousScope, selectedKeys: previous },
      trendData.creatives,
      nextScope
    ).selectedKeys));
  }, [range.from, range.to, selectedProductId, trendData]);

  const selectedProduct = products.find((product) => product.id === selectedProductId) ?? null;
  const creatives = trendData?.creatives ?? [];
  const colorByCreativeKey = useMemo(
    () => new Map(creatives.map((creative, index) => [
      creative.creativeKey,
      CREATIVE_TREND_COLORS[index % CREATIVE_TREND_COLORS.length]
    ])),
    [creatives]
  );
  const selectedCreatives = useMemo(
    () => creatives.filter((creative) => selectedCreativeKeys.has(creative.creativeKey)),
    [creatives, selectedCreativeKeys]
  );
  const selectedMetrics = useMemo(
    () => META_CREATIVE_TREND_METRICS.filter((metric) => selectedMetricKeys.has(metric.key)),
    [selectedMetricKeys]
  );
  const chartModels = useMemo(
    () => selectedMetrics.map((metric) => ({
      metric,
      model: buildCreativeMetricChartModel({
        creatives,
        selectedKeys: selectedCreativeKeys,
        metricKey: metric.key,
        from: range.from,
        to: range.to
      })
    })),
    [creatives, range.from, range.to, selectedCreativeKeys, selectedMetrics]
  );
  const insight = useMemo(
    () => buildThreeSecondInsight(creatives, selectedCreativeKeys),
    [creatives, selectedCreativeKeys]
  );
  const selectedDays = isMounted
    ? trendData?.period.selectedDays ?? trendSelectedDays(range.from, range.to)
    : 0;

  const changeProduct = (productId: string) => {
    const transition = beginCreativeProductSelectionTransition();
    selectionScopeRef.current = transition.scope;
    setSelectedProductId(productId);
    setSelectedCreativeKeys(new Set(transition.selectedKeys));
  };
  const toggleCreative = (creativeKey: string) => {
    setSelectedCreativeKeys((previous) => {
      const next = new Set(previous);
      if (next.has(creativeKey)) next.delete(creativeKey);
      else next.add(creativeKey);
      return next;
    });
  };
  const toggleAllCreatives = () => {
    setSelectedCreativeKeys((previous) => {
      const allSelected = creatives.length > 0 && creatives.every((creative) => previous.has(creative.creativeKey));
      return allSelected ? new Set() : new Set(creatives.map((creative) => creative.creativeKey));
    });
  };
  const toggleMetric = (metricKey: MetaCreativeTrendMetricKey) => {
    setSelectedMetricKeys((previous) => {
      const next = new Set(previous);
      if (next.has(metricKey)) next.delete(metricKey);
      else next.add(metricKey);
      return next;
    });
  };
  const resetSelection = () => {
    const firstProductId = products[0]?.id ?? "";
    setSelectedProductId(firstProductId);
    setSelectedMetricKeys(new Set(DEFAULT_TREND_METRIC_KEYS));
    if (trendData?.productId === firstProductId) {
      setSelectedCreativeKeys(selectDefaultCreativeKeys(trendData.creatives));
      selectionScopeRef.current = selectionScope(firstProductId, range.from, range.to);
    } else {
      setSelectedCreativeKeys(new Set());
      selectionScopeRef.current = null;
    }
  };

  return (
    <section className="page">
      <div className="page-title">
        <div>
          <h1>소재별 성과 지표 추이</h1>
          <p>제품의 광고 소재별 도달·비용·클릭·전환·영상 재생 지표를 일자별로 비교합니다.</p>
        </div>
        <div className="creative-trend-page-title-actions">
          <span className="creative-trend-period-chip">
            <span aria-hidden="true">●</span>
            {isMounted ? formatPeriodSummary(range.from, range.to, selectedDays) : "조회 기간 확인 중"}
          </span>
          <button
            aria-label="선택 초기화"
            className="icon-button"
            disabled={products.length === 0}
            onClick={resetSelection}
            title="선택 초기화"
            type="button"
          >
            <RotateCcw size={16} />
          </button>
        </div>
      </div>

      {productsQuery.isError ? (
        <div className="warning-strip">
          <span>제품 목록을 불러오지 못했습니다. API 연결 또는 DB 설정을 확인해주세요.</span>
        </div>
      ) : null}

      <div className="creative-trend-layout">
        <CreativeTrendControls
          colorByCreativeKey={colorByCreativeKey}
          creatives={creatives}
          isProductsLoading={productsQuery.isLoading}
          isTrendsLoading={Boolean(selectedProductId) && trendsQuery.isLoading}
          onAllCreativesToggle={toggleAllCreatives}
          onCreativeToggle={toggleCreative}
          onMetricToggle={toggleMetric}
          onProductChange={changeProduct}
          productId={selectedProductId}
          products={products}
          selectedCreativeKeys={selectedCreativeKeys}
          selectedMetricKeys={selectedMetricKeys}
        />

        <section aria-live="polite" className="panel creative-trend-chart-panel">
          <header className="creative-trend-chart-header">
            <div>
              <h2>{selectedProduct ? productLabel(selectedProduct) : "제품 미선택"} · 소재 추이</h2>
              <p>선택한 {selectedCreatives.length}개 소재의 일별 성과</p>
            </div>
            <div className="creative-trend-meta-chips">
              <span>일별 · {selectedDays}일 선택</span>
              <span>데이터 존재 {trendData?.period.dataDays ?? 0}일</span>
              <span>KST 기준</span>
            </div>
          </header>

          <div className="creative-trend-legend">
            <strong>소재</strong>
            {selectedCreatives.length === 0 ? <span>비교 소재를 선택해주세요.</span> : null}
            {selectedCreatives.map((creative) => (
              <span className="creative-trend-legend-item" key={creative.creativeKey}>
                <i aria-hidden="true" style={{ backgroundColor: colorByCreativeKey.get(creative.creativeKey) }} />
                {creativeLabel(creative)}
              </span>
            ))}
          </div>

          <CreativeTrendChartBody
            chartModels={chartModels}
            hasProducts={products.length > 0}
            hasResponse={Boolean(trendData)}
            isProductsError={productsQuery.isError}
            isProductsLoading={productsQuery.isLoading}
            isTrendsError={trendsQuery.isError}
            isTrendsLoading={Boolean(selectedProductId) && trendsQuery.isLoading}
            metricCount={selectedMetricKeys.size}
            onRetry={() => void trendsQuery.refetch()}
            selectedCreativeCount={selectedCreatives.length}
            totalCreativeCount={creatives.length}
          />

          {trendData && creatives.length > 0 && selectedCreatives.length > 0 ? (
            <div className="creative-trend-insight">
              <InsightIcon direction={insight?.direction ?? "flat"} />
              <span>{insight ? <InsightText insight={insight} /> : "비교 가능한 3초 재생률 데이터가 부족합니다."}</span>
              <small>선택 기간 비교</small>
            </div>
          ) : null}
        </section>
      </div>
    </section>
  );
}

function CreativeTrendChartBody({
  chartModels,
  hasProducts,
  hasResponse,
  isProductsError,
  isProductsLoading,
  isTrendsError,
  isTrendsLoading,
  metricCount,
  onRetry,
  selectedCreativeCount,
  totalCreativeCount
}: {
  chartModels: Array<{
    metric: (typeof META_CREATIVE_TREND_METRICS)[number];
    model: ReturnType<typeof buildCreativeMetricChartModel>;
  }>;
  hasProducts: boolean;
  hasResponse: boolean;
  isProductsError: boolean;
  isProductsLoading: boolean;
  isTrendsError: boolean;
  isTrendsLoading: boolean;
  metricCount: number;
  onRetry: () => void;
  selectedCreativeCount: number;
  totalCreativeCount: number;
}) {
  if (isProductsLoading) return <TrendEmpty title="제품 목록을 불러오는 중입니다." />;
  if (isProductsError) return <TrendEmpty title="제품 목록을 불러오지 못했습니다." />;
  if (!hasProducts) return <TrendEmpty title="등록된 활성 제품이 없습니다." />;
  if (isTrendsLoading || !hasResponse && !isTrendsError) {
    return <TrendEmpty title="소재 추이 데이터를 불러오는 중입니다." />;
  }
  if (isTrendsError) {
    return (
      <TrendEmpty title="소재 추이 데이터를 불러오지 못했습니다.">
        <button className="button" onClick={onRetry} type="button">다시 시도</button>
      </TrendEmpty>
    );
  }
  if (totalCreativeCount === 0) {
    return <TrendEmpty title="선택한 기간에 활성 소재 데이터가 없습니다." />;
  }
  if (selectedCreativeCount === 0 && metricCount === 0) {
    return <TrendEmpty title="비교할 소재와 표시할 지표를 선택해주세요." />;
  }
  if (selectedCreativeCount === 0) {
    return <TrendEmpty title="비교할 소재를 1개 이상 선택해주세요." />;
  }
  if (metricCount === 0) {
    return <TrendEmpty title="표시할 지표를 1개 이상 선택해주세요." />;
  }
  return (
    <div className="creative-trend-chart-grid">
      {chartModels.map(({ metric, model }) => (
        <CreativeMetricChart key={metric.key} metric={metric} model={model} />
      ))}
    </div>
  );
}

function TrendEmpty({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="creative-trend-empty">
      <div>
        <strong>{title}</strong>
        {children}
      </div>
    </div>
  );
}

function InsightIcon({ direction }: { direction: "up" | "down" | "flat" }) {
  if (direction === "up") return <ArrowUpRight aria-hidden="true" size={17} />;
  if (direction === "down") return <ArrowDownRight aria-hidden="true" size={17} />;
  return <ArrowRight aria-hidden="true" size={17} />;
}

function InsightText({ insight }: { insight: NonNullable<ReturnType<typeof buildThreeSecondInsight>> }) {
  const amount = Math.abs(insight.changePctPoints).toLocaleString("ko-KR", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 2
  });
  if (insight.direction === "up") {
    return <><strong>{insight.label}</strong>의 3초 재생률이 기간 초 대비 {amount}%p 상승했습니다.</>;
  }
  if (insight.direction === "down") {
    return <><strong>{insight.label}</strong>의 3초 재생률이 기간 초 대비 {amount}%p 하락했습니다.</>;
  }
  return <><strong>{insight.label}</strong>의 3초 재생률은 기간 초와 같습니다.</>;
}

function selectionScope(productId: string, from: string, to: string): CreativeSelectionScope {
  return { productId, from, to };
}

function formatPeriodSummary(from: string, to: string, selectedDays: number) {
  return `${from.replaceAll("-", ".")} ~ ${to.slice(5).replace("-", ".")} · ${selectedDays}일`;
}
