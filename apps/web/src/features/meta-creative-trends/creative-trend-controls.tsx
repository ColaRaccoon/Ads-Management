"use client";

import { Info } from "lucide-react";
import { META_CREATIVE_TREND_METRICS, formatMetaDeliveryStatus } from "@/lib/meta-video-display";
import { creativeLabel, productLabel } from "@/lib/meta-creative-trends";
import type {
  MetaCreativeTrendMetricKey,
  MetaCreativeVideoTrendSeries,
  MetaProductListItem
} from "@/types/meta";

type CreativeTrendControlsProps = {
  products: MetaProductListItem[];
  productId: string;
  creatives: MetaCreativeVideoTrendSeries[];
  selectedCreativeKeys: ReadonlySet<string>;
  selectedMetricKeys: ReadonlySet<MetaCreativeTrendMetricKey>;
  colorByCreativeKey: ReadonlyMap<string, string>;
  isProductsLoading: boolean;
  isTrendsLoading: boolean;
  onProductChange: (productId: string) => void;
  onCreativeToggle: (creativeKey: string) => void;
  onAllCreativesToggle: () => void;
  onMetricToggle: (metricKey: MetaCreativeTrendMetricKey) => void;
};

export function CreativeTrendControls({
  products,
  productId,
  creatives,
  selectedCreativeKeys,
  selectedMetricKeys,
  colorByCreativeKey,
  isProductsLoading,
  isTrendsLoading,
  onProductChange,
  onCreativeToggle,
  onAllCreativesToggle,
  onMetricToggle
}: CreativeTrendControlsProps) {
  const allCreativesSelected = creatives.length > 0 && creatives.every((creative) =>
    selectedCreativeKeys.has(creative.creativeKey)
  );
  const productNote = isProductsLoading
    ? "제품 목록을 불러오는 중입니다."
    : products.length === 0
      ? "등록된 활성 제품이 없습니다."
      : isTrendsLoading
        ? "활성 소재 데이터를 불러오는 중입니다."
        : creatives.length === 0
          ? "활성 소재 0개 · 선택 기간 데이터 없음"
          : `활성 소재 ${creatives.length}개 · 일별 데이터 있음`;

  return (
    <aside aria-label="그래프 조건 선택" className="panel creative-trend-controls">
      <div className="creative-trend-control-section">
        <div className="creative-trend-section-heading">
          <strong>1. 제품 선택</strong>
        </div>
        <select
          aria-label="제품 선택"
          className="select creative-trend-product-select"
          disabled={isProductsLoading || products.length === 0}
          onChange={(event) => onProductChange(event.target.value)}
          value={productId}
        >
          {products.length === 0 ? <option value="">제품 없음</option> : null}
          {products.map((product) => (
            <option key={product.id} value={product.id}>{productLabel(product)}</option>
          ))}
        </select>
        <p className="creative-trend-product-note">
          <span aria-hidden="true" className="creative-trend-status-dot" />
          {productNote}
        </p>
      </div>

      <div className="creative-trend-control-section">
        <div className="creative-trend-section-heading">
          <strong>2. 비교 소재</strong>
          <button
            className="creative-trend-text-button"
            disabled={creatives.length === 0}
            onClick={onAllCreativesToggle}
            type="button"
          >
            {allCreativesSelected ? "전체 해제" : "전체 선택"}
          </button>
        </div>
        <div className="creative-trend-creative-list">
          {!isProductsLoading && isTrendsLoading ? (
            <span className="creative-trend-control-message">소재를 불러오는 중입니다.</span>
          ) : null}
          {!isProductsLoading && !isTrendsLoading && creatives.length === 0 ? (
            <span className="creative-trend-control-message">선택 기간에 활성 소재가 없습니다.</span>
          ) : null}
          {creatives.map((creative) => {
            const originalName = creative.originalAdNames[creative.originalAdNames.length - 1] ?? creative.displayName;
            return (
              <label className="creative-trend-creative-option" key={creative.creativeKey}>
                <input
                  checked={selectedCreativeKeys.has(creative.creativeKey)}
                  onChange={() => onCreativeToggle(creative.creativeKey)}
                  type="checkbox"
                />
                <span
                  aria-hidden="true"
                  className="creative-trend-series-dot"
                  style={{ backgroundColor: colorByCreativeKey.get(creative.creativeKey) }}
                />
                <span className="creative-trend-creative-name">
                  <strong>{creativeLabel(creative)}</strong>
                  <small title={originalName}>{originalName}</small>
                </span>
                {creative.deliveryStatus ? (
                  <span className="creative-trend-active-badge">
                    {formatMetaDeliveryStatus(creative.deliveryStatus)}
                  </span>
                ) : null}
              </label>
            );
          })}
        </div>
      </div>

      <div className="creative-trend-control-section">
        <div className="creative-trend-section-heading">
          <strong>3. 표시 지표</strong>
          <small>{selectedMetricKeys.size}개 선택</small>
        </div>
        <div className="creative-trend-metric-grid">
          {META_CREATIVE_TREND_METRICS.map((metric) => (
            <label className="creative-trend-metric-option" key={metric.key}>
              <input
                checked={selectedMetricKeys.has(metric.key)}
                onChange={() => onMetricToggle(metric.key)}
                type="checkbox"
              />
              <span>{metric.label}</span>
            </label>
          ))}
        </div>
        <p className="creative-trend-formula-note">
          <Info aria-hidden="true" size={15} />
          <span>
            재생률 = 해당 재생 구간 수 ÷ 도달수 × 100
            <br />
            단위가 다른 지표는 각각의 그래프로 표시됩니다.
          </span>
        </p>
      </div>
    </aside>
  );
}
