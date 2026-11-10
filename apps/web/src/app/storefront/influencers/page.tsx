"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, List, Pencil, Plus, RefreshCw } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { DataTable, type Column } from "@/components/data-table";
import { useCan } from "@/features/auth/use-auth";
import {
  collaborationKey, influencerCreativesOptions, influencerListOptions, influencerResource as resource,
  type Collaboration, type CollaborationInput
} from "@/features/influencers/influencer-queries";
import { apiErrorMessage, apiPatch, apiPost } from "@/lib/api";
import { koreaTodayDateInput } from "@/lib/korea-date";
import { storefrontTime } from "@/lib/storefront-display";
import styles from "./influencers.module.css";

const maxFeeKrw = 999_999_999_999;
const moneyFormat = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 6 });

type ActiveDialog = { kind: "editor"; collaboration?: Collaboration } | { kind: "creatives"; collaboration: Collaboration };

export default function InfluencersPage() {
  const canRead = useCan("data.read");
  const canManage = useCan("influencers.manage");
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [dialog, setDialog] = useState<ActiveDialog | null>(null);
  const [savedMessage, setSavedMessage] = useState("");
  const list = useQuery({ ...influencerListOptions(page), enabled: canRead });

  const prefetchCreatives = (collaboration: Collaboration) => {
    void queryClient.prefetchQuery(influencerCreativesOptions(collaboration));
  };

  function openDialog(dialog: ActiveDialog) {
    setSavedMessage("");
    setDialog(dialog);
  }

  const columns: Column<Collaboration>[] = [
    { key: "influencer", header: "인플루언서", render: (row) => <strong>{row.influencerName}</strong> },
    { key: "period", header: "측정 기간", render: (row) => <>{row.startDate} ~ {row.endDate ?? "진행 중"}</> },
    { key: "fee", header: "섭외비", render: (row) => money(row.feeKrw) },
    { key: "spend", header: "누적 광고비", render: (row) => money(row.adSpendKrw) },
    { key: "margin", header: "누적 광고 성과", render: (row) => <Performance value={row.adMarginKrw} /> },
    { key: "net", header: "최종 성과", render: (row) => <Performance value={row.netPerformanceKrw} /> },
    { key: "status", header: "집계 상태", render: (row) => <AggregationStatus row={row} /> },
    { key: "actions", header: "관리", render: (row) => (
      <div className="toolbar">
        <button className="button" type="button" onClick={() => openDialog({ kind: "creatives", collaboration: row })}
          onMouseEnter={() => prefetchCreatives(row)} onFocus={() => prefetchCreatives(row)}
          aria-label={`${row.influencerName} 소재 ${row.creativeCount}개 보기`}>
          <List size={15} aria-hidden="true" /> 소재 {row.creativeCount}개
        </button>
        {canManage ? <button className="button" type="button" onClick={() => openDialog({ kind: "editor", collaboration: row })}
          aria-label={`${row.influencerName} 협업 수정`}>
          <Pencil size={14} aria-hidden="true" /> 수정
        </button> : null}
      </div>
    ) }
  ];

  return <section className="page">
    <div className={`page-title ${styles.heading}`}>
      <div>
        <h1>인플루언서 성과측정</h1>
        <p>협업별로 섭외비를 기록하고, Meta 광고의 누적 성과와 섭외비를 차감한 최종 성과를 확인합니다.</p>
      </div>
      {canRead ? <div className="toolbar">
        <button className="button" type="button" disabled={list.isFetching} onClick={() => void list.refetch()}>
          <RefreshCw size={15} aria-hidden="true" /> 저장값 새로고침
        </button>
        {canManage ? <button className="button primary" type="button" onClick={() => openDialog({ kind: "editor" })}>
          <Plus size={16} aria-hidden="true" /> 협업 등록
        </button> : null}
      </div> : null}
    </div>

    {canRead ? <section className="panel" aria-labelledby="influencer-list-heading">
      <h2 id="influencer-list-heading">협업별 누적 성과</h2>
      <p className={styles.help}>
        광고 성과는 Meta 소재별 추정 마진입니다. 등록 시 섭외비부터 반영하고, 일일 광고 성과는 별도 집계가 끝나면 반영합니다.
        과거 자료는 순차 반영되며, 필요한 자료가 부족한 금액은 ‘—’로 표시합니다.
      </p>
      {savedMessage ? <p className={styles.success} role="status">{savedMessage}</p> : null}
      {list.isPending ? <p role="status">저장된 협업을 불러오는 중입니다.</p> : null}
      {list.isError ? <p className={styles.error} role="alert">저장된 협업을 불러오지 못했습니다. 새로고침해 주세요.</p> : null}
      {list.data ? <div className={styles.listTable}>
        <DataTable rows={list.data.items} columns={columns} getRowKey={(row) => row.id} empty="이 페이지에 등록된 협업이 없습니다." />
      </div> : null}
      {page > 1 || list.data?.hasMore ? <nav className={`toolbar ${styles.pagination}`} aria-label="협업 목록 페이지">
        <button className="button" type="button" disabled={page === 1 || list.isFetching} onClick={() => setPage(page - 1)}>
          <ChevronLeft size={16} aria-hidden="true" /> 이전
        </button>
        <span aria-live="polite">{page}페이지</span>
        <button className="button" type="button" disabled={!list.data?.hasMore || list.isFetching} onClick={() => setPage(page + 1)}>
          다음 <ChevronRight size={16} aria-hidden="true" />
        </button>
      </nav> : null}
    </section> : <div className="panel" role="alert">데이터 조회 권한이 없습니다.</div>}

    {canRead && canManage && dialog?.kind === "editor" ? <CollaborationEditor
      collaboration={dialog.collaboration} onClose={() => setDialog(null)}
      onSaved={() => {
        if (!dialog.collaboration) setPage(1);
        setSavedMessage(dialog.collaboration ? "협업 정보를 수정했습니다." : "협업을 등록했습니다.");
        setDialog(null);
        void queryClient.invalidateQueries({ queryKey: collaborationKey });
      }} /> : null}
    {canRead && dialog?.kind === "creatives" ? <CreativesDialog collaboration={dialog.collaboration} onClose={() => setDialog(null)} /> : null}
  </section>;
}

function AggregationStatus({ row }: { row: Collaboration }) {
  if (!row.aggregatedAt) return <span className="badge watch">집계 대기</span>;
  const status = !row.dataThrough ? "매칭 자료 없음" : row.netPerformanceKrw === null || row.adSpendKrw === null ? "자료 확인 필요" : "집계 반영";
  return <div className={styles.status}>
    <strong>{status}</strong>
    {row.dataThrough ? <small>마지막 매칭일 {row.dataThrough}</small> : null}
    <small>집계 {storefrontTime(row.aggregatedAt)} (KST)</small>
  </div>;
}

function CollaborationEditor({ collaboration, onClose, onSaved }: {
  collaboration?: Collaboration;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [formError, setFormError] = useState("");
  const save = useMutation({
    mutationFn: (input: CollaborationInput) => collaboration
      ? apiPatch(`${resource}/${encodeURIComponent(collaboration.id)}`, { ...input, version: collaboration.version })
      : apiPost(resource, input),
    onSuccess: onSaved
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (save.isPending) return;
    const fields = new FormData(event.currentTarget);
    const influencerName = String(fields.get("influencerName")).trim();
    const feeKrw = Number(fields.get("feeKrw"));
    const startDate = String(fields.get("startDate"));
    const endDate = String(fields.get("endDate")) || null;
    const note = String(fields.get("note")).trim() || null;
    if (!influencerName || /[()]/.test(influencerName.normalize("NFKC"))) {
      setFormError("광고 이름의 ‘인플(이름)’에서 괄호 안의 이름만 입력해 주세요.");
      return;
    }
    if (!Number.isSafeInteger(feeKrw) || feeKrw < 0 || feeKrw > maxFeeKrw) {
      setFormError("섭외비를 0원 이상의 정수로 입력해 주세요.");
      return;
    }
    if (endDate && endDate < startDate) {
      setFormError("측정 종료일은 시작일 이후로 입력해 주세요.");
      return;
    }
    setFormError("");
    save.mutate({ influencerName, feeKrw, startDate, endDate, note });
  }

  return <InfluencerDialog title={collaboration ? "협업 수정" : "협업 등록"} onClose={onClose} busy={save.isPending}>
    <p className={styles.help}>
      Meta 광고 소재명에 <code>인플(혜민)</code>이 있으면 인플루언서 이름에 ‘혜민’을 입력하세요. 소재명에 표기가 없으면 캠페인명을 확인합니다.
    </p>
    <form onSubmit={submit}>
      <fieldset className={styles.fields} disabled={save.isPending}>
        <label className="field">
          <span className="field-label">인플루언서 이름</span>
          <input className="input" name="influencerName" placeholder="혜민" defaultValue={collaboration?.influencerName} maxLength={100} required />
        </label>
        <label className="field">
          <span className="field-label">섭외비 (원)</span>
          <input className="input" name="feeKrw" type="number" inputMode="numeric" min={0} max={maxFeeKrw} step={1}
            placeholder="150000" defaultValue={collaboration?.feeKrw} required />
        </label>
        <label className="field">
          <span className="field-label">측정 시작일</span>
          <input className="input" name="startDate" type="date" defaultValue={collaboration?.startDate ?? koreaTodayDateInput()} required />
        </label>
        <label className="field">
          <span className="field-label">측정 종료일 (선택)</span>
          <input className="input" name="endDate" type="date" defaultValue={collaboration?.endDate ?? ""} />
          <span className="field-help">종료일을 포함합니다. 비워 두면 집계가 계속됩니다.</span>
        </label>
        <label className={`field ${styles.note}`}>
          <span className="field-label">메모 (선택)</span>
          <textarea className="textarea" name="note" defaultValue={collaboration?.note ?? ""} maxLength={1000} />
        </label>
      </fieldset>
      {formError || save.isError ? <p className={styles.error} role="alert">
        {formError || apiErrorMessage(save.error, "협업을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.")}
      </p> : null}
      <div className={`toolbar ${styles.dialogActions}`}>
        <button className="button" type="button" onClick={onClose} disabled={save.isPending}>취소</button>
        <button className="button primary" type="submit" disabled={save.isPending}>{save.isPending ? "저장 중…" : "저장"}</button>
      </div>
    </form>
  </InfluencerDialog>;
}

function CreativesDialog({ collaboration, onClose }: { collaboration: Collaboration; onClose: () => void }) {
  const creatives = useQuery(influencerCreativesOptions(collaboration));
  return <InfluencerDialog title={`${collaboration.influencerName} · 소재별 누적 성과`} onClose={onClose} wide>
    <p className={styles.help}>{collaboration.startDate} ~ {collaboration.endDate ?? "진행 중"}. 섭외비는 협업의 최종 성과에 한 번 반영됩니다.</p>
    {collaboration.note ? <p className={styles.noteText}><strong>메모</strong> {collaboration.note}</p> : null}
    {creatives.isPending ? <p role="status">저장된 소재별 성과를 불러오는 중입니다.</p> : null}
    {creatives.isError ? <p className={styles.error} role="alert">소재별 성과를 불러오지 못했습니다.</p> : null}
    {creatives.data ? <div className={styles.creativeTable}>
      <DataTable rows={creatives.data.items} getRowKey={(row) => row.creativeName}
        empty="아직 저장된 소재별 성과가 없습니다." columns={[
          { key: "creative", header: "소재 이름", render: (row) => row.creativeName },
          { key: "spend", header: "누적 광고비", render: (row) => money(row.adSpendKrw) },
          { key: "margin", header: "누적 광고 성과", render: (row) => <Performance value={row.adMarginKrw} /> },
          { key: "date", header: "마지막 매칭일", render: (row) => row.dataThrough }
        ]} />
    </div> : null}
    <div className={`toolbar ${styles.dialogActions}`}>
      {creatives.isError ? <button className="button" type="button" onClick={() => void creatives.refetch()}>다시 조회</button> : null}
      <button className="button" type="button" onClick={onClose}>닫기</button>
    </div>
  </InfluencerDialog>;
}

function InfluencerDialog({ title, onClose, busy = false, wide = false, children }: {
  title: string;
  onClose: () => void;
  busy?: boolean;
  wide?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return <dialog ref={ref} className={`panel ${styles.dialog} ${wide ? styles.wideDialog : ""}`} aria-labelledby={titleId}
    onCancel={(event) => {
      event.preventDefault();
      if (!busy) onClose();
    }}>
    <h2 id={titleId}>{title}</h2>
    {children}
  </dialog>;
}

function money(value: number | null) {
  return value === null ? "—" : `${moneyFormat.format(value)}원`;
}

function Performance({ value }: { value: number | null }) {
  const color = value === null ? "muted" : value < 0 ? styles.negative : value > 0 ? styles.positive : "";
  return <strong className={color}>{money(value)}</strong>;
}
