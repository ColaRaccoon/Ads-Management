"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { Save, Search } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost } from "@/lib/api";
import { useRange } from "@/lib/use-range";

type ProductListItem = {
  id: string;
  productName: string;
  spendUsd: number;
};

type ProductDetail = {
  product: {
    id: string;
    name: string;
  };
  date: string;
  adsDate: string;
  isPreviousAdsDate: boolean;
  spendUsd: number;
  activeAdCount: number;
  inactiveAdCount: number;
  ads: {
    active: ProductAdSummary[];
    inactive: ProductAdSummary[];
  };
  logs: ProductLogItem[];
};

type ProductAdSummary = {
  id: string;
  creativeName: string;
  campaignName: string;
  spendUsd: number;
};

type ProductLogItem = {
  id: string;
  actionDate: string;
  text: string;
  createdAt: string;
};

export default function ChangeLogsPage() {
  const range = useRange();
  const selectedDate = useMemo(() => range.to || todayInputValue(), [range.to]);
  const queryClient = useQueryClient();
  const [selectedProductId, setSelectedProductId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [actionDate, setActionDate] = useState(todayInputValue());
  const [logText, setLogText] = useState("");

  const products = useQuery({
    queryKey: ["product-change-log-list", selectedDate],
    queryFn: () => apiGet<ProductListItem[]>(`/change-logs/products?date=${encodeURIComponent(selectedDate)}`)
  });
  const detail = useQuery({
    queryKey: ["product-change-log-detail", selectedProductId, selectedDate],
    enabled: Boolean(selectedProductId),
    queryFn: () => {
      if (!selectedProductId) {
        throw new Error("productId is required");
      }
      return apiGet<ProductDetail>(`/change-logs/products/${selectedProductId}?date=${encodeURIComponent(selectedDate)}`);
    }
  });
  const createLog = useMutation({
    mutationFn: (body: { actionDate: string; text: string }) => {
      if (!selectedProductId) {
        throw new Error("productId is required");
      }
      return apiPost(`/change-logs/products/${selectedProductId}/logs`, body);
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["product-change-log-list"] }),
        queryClient.invalidateQueries({ queryKey: ["product-change-log-detail"] })
      ]);
      setActionDate(todayInputValue());
      setLogText("");
    }
  });

  useEffect(() => {
    const ids = products.data?.map((product) => product.id) ?? [];
    if (ids.length === 0) {
      setSelectedProductId(null);
      return;
    }
    if (!selectedProductId || !ids.includes(selectedProductId)) {
      setSelectedProductId(ids[0]);
    }
  }, [products.data, selectedProductId]);

  useEffect(() => {
    setActionDate(todayInputValue());
    setLogText("");
  }, [selectedProductId]);

  const filteredProducts = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    if (!keyword) {
      return products.data ?? [];
    }
    return (products.data ?? []).filter((product) => product.productName.toLowerCase().includes(keyword));
  }, [products.data, search]);

  const selectedProduct = products.data?.find((product) => product.id === selectedProductId) ?? null;
  const selectedDetail = detail.data ?? null;
  const adPanelSuffix = selectedDetail?.isPreviousAdsDate ? ` (${selectedDetail.adsDate} 전일자 데이터)` : "";
  const adMetricSuffix = selectedDetail?.isPreviousAdsDate ? " (전일)" : "";

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = logText.trim();
    if (!text) {
      return;
    }
    createLog.mutate({ actionDate, text });
  };

  return (
    <section className="page">
      <div className="page-title">
        <div>
          <h1>Change Logs</h1>
          <p>제품별 광고비, 광고 상태, 운영 기록을 선택 날짜 기준으로 확인합니다.</p>
        </div>
      </div>

      <div className="creative-log-layout">
        <aside className="panel creative-list-panel">
          <div className="creative-list-heading">
            <h2>제품</h2>
            <span>{products.data?.length ?? 0}개</span>
          </div>
          <label className="creative-search">
            <Search size={15} />
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="제품명 검색" />
          </label>
          <div className="creative-list product-list-grid">
            {filteredProducts.map((product) => (
              <button
                key={product.id}
                className={`creative-item product-item ${product.id === selectedProductId ? "active" : ""}`}
                type="button"
                onClick={() => setSelectedProductId(product.id)}
              >
                <strong>{product.productName}</strong>
                <span>{formatUsd(product.spendUsd)}</span>
              </button>
            ))}
            {!products.isLoading && filteredProducts.length === 0 ? <p className="muted">등록된 제품이 없습니다.</p> : null}
          </div>
        </aside>

        <section className="panel creative-detail-panel">
          {selectedProduct ? (
            selectedDetail ? (
            <div className="creative-detail">
              <div className="creative-detail-header">
                <div>
                  <h2>{selectedDetail.product.name}</h2>
                  <p className="muted">
                    선택 날짜 {selectedDetail.date} 기준 제품 광고 현황
                    {selectedDetail.isPreviousAdsDate ? ` / 광고 소재는 ${selectedDetail.adsDate} 기준` : ""}
                  </p>
                </div>
                <span className="badge keep">제품 기록</span>
              </div>

              <div className="creative-metric-row product-metric-row">
                <MetricBox label="광고비" value={formatUsd(selectedDetail.spendUsd)} />
                <MetricBox label={`활성화 광고${adMetricSuffix}`} value={`${formatNumber(selectedDetail.activeAdCount)}개`} />
                <MetricBox label={`비활성화 광고${adMetricSuffix}`} value={`${formatNumber(selectedDetail.inactiveAdCount)}개`} />
              </div>

              <section className="creative-detail-block">
                <div className="ad-status-grid">
                  <AdStatusPanel title={`활성화 광고${adPanelSuffix}`} ads={selectedDetail.ads.active} isPreviousData={selectedDetail.isPreviousAdsDate} />
                  <AdStatusPanel title={`비활성화 광고${adPanelSuffix}`} ads={selectedDetail.ads.inactive} isPreviousData={selectedDetail.isPreviousAdsDate} />
                </div>
              </section>

              <form className="creative-log-form product-log-form" onSubmit={submit}>
                <h3>새 기록</h3>
                <label className="field">
                  <span className="field-label">기록일</span>
                  <input className="input" type="date" value={actionDate} onChange={(event) => setActionDate(event.target.value)} required />
                </label>
                <textarea
                  className="textarea"
                  value={logText}
                  onChange={(event) => setLogText(event.target.value)}
                  placeholder="기록"
                  required
                />
                <button className="button primary" type="submit" disabled={createLog.isPending || !logText.trim()}>
                  <Save size={16} />
                  저장
                </button>
              </form>

              <section className="creative-detail-block">
                <h3>기록</h3>
                <div className="log-scroll-box">
                  <div className="timeline">
                    {selectedDetail.logs.map((log) => (
                      <article key={log.id} className="timeline-item product-log-item">
                        <div className="timeline-title">
                          <strong>{log.actionDate}</strong>
                        </div>
                        <p>{log.text}</p>
                      </article>
                    ))}
                    {selectedDetail.logs.length === 0 ? <p className="muted">기록된 로그가 없습니다.</p> : null}
                  </div>
                </div>
              </section>
            </div>
            ) : detail.isError ? (
              <div className="creative-empty">
                <h2>제품 정보를 불러오지 못했습니다.</h2>
                <p className="muted">잠시 후 다시 시도하거나 새로고침해 주세요.</p>
              </div>
            ) : (
              <div className="creative-empty">
                <h2>제품 정보를 불러오는 중입니다.</h2>
                <p className="muted">선택 제품의 광고 현황과 기록을 조회하고 있습니다.</p>
              </div>
            )
          ) : (
            <div className="creative-empty">
              <h2>선택된 제품이 없습니다.</h2>
              <p className="muted">Product Settings에 등록된 제품이 표시됩니다.</p>
            </div>
          )}
        </section>
      </div>
    </section>
  );
}

function MetricBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="creative-metric-box">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function AdStatusPanel({
  title,
  ads,
  isPreviousData
}: {
  title: string;
  ads: ProductAdSummary[];
  isPreviousData: boolean;
}) {
  return (
    <section className="status-ad-panel">
      <h3>{title}</h3>
      {ads.length > 0 ? (
        <div className="status-ad-scroll">
          <table className="status-ad-table">
            <thead>
              <tr>
                <th>광고소재명 / 캠페인명</th>
                <th>{isPreviousData ? "전일 광고비" : "광고비"}</th>
              </tr>
            </thead>
            <tbody>
              {ads.map((ad) => (
                <tr key={ad.id}>
                  <td>
                    <span className="status-ad-name">
                      <strong>{ad.creativeName}</strong>
                      <small>{ad.campaignName}</small>
                    </span>
                  </td>
                  <td>{formatUsd(ad.spendUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">표시할 광고가 없습니다.</p>
      )}
    </section>
  );
}

function todayInputValue() {
  const today = new Date();
  today.setMinutes(today.getMinutes() - today.getTimezoneOffset());
  return today.toISOString().slice(0, 10);
}

function formatUsd(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value);
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("ko-KR").format(value);
}
