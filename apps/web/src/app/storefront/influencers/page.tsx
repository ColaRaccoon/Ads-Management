"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, ExternalLink, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { format } from "date-fns";
import { useId, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { DataTable, type Column } from "@/components/data-table";
import { useAuth, useCan } from "@/features/auth/use-auth";
import {
  collaborationKey, influencerCreativesOptions, influencerDailyOptions, influencerListOptions, influencerResource as resource,
  type Collaboration, type CollaborationInput, type InfluencerDailyRow
} from "@/features/influencers/influencer-queries";
import { apiDelete, apiErrorMessage, apiGet, apiPatch, apiPost } from "@/lib/api";
import { storefrontTime } from "@/lib/storefront-display";
import styles from "./influencers.module.css";

const maxFeeKrw = 999_999_999_999;
const moneyFormat = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 });

type ActiveDialog = { kind: "editor"; collaboration?: Collaboration } |
  { kind: "creatives" | "numbering" | "remove"; collaboration: Collaboration };

export default function InfluencersPage() {
  const canRead = useCan("data.read");
  const canManage = useCan("influencers.manage");
  const canNumber = useCan("influencers.numbering");
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
    { key: "manager", header: "담당자 이름", render: (row) => <strong>{row.managerName ?? "미등록"}</strong> },
    { key: "influencer", header: "인플루언서 닉네임", render: (row) => row.nickname },
    { key: "product", header: "제품", render: (row) => row.productName ?? "미선택" },
    { key: "numbers", header: "소재 번호", render: (row) => row.numbers.join(", ") || "—" },
    { key: "period", header: "측정 시작일", render: (row) => row.startDate },
    { key: "fee", header: "섭외비", render: (row) => money(row.feeKrw) },
    { key: "spend", header: "누적 광고비", render: (row) => money(row.adSpendKrw) },
    { key: "margin", header: "누적 광고 성과", render: (row) => <Performance value={row.adMarginKrw} /> },
    { key: "net", header: "최종 성과", render: (row) => <Performance value={row.netPerformanceKrw} /> },
    { key: "status", header: "집계 상태", render: (row) => (
      <div className={styles.status}>
        <AggregationStatus row={row} />
        {row.creativeCount > 0 ? <button className={styles.creativeDetails} type="button"
          onClick={() => openDialog({ kind: "creatives", collaboration: row })}
          onMouseEnter={() => prefetchCreatives(row)} onFocus={() => prefetchCreatives(row)}>
          소재별 성과
        </button> : null}
      </div>
    ) },
    { key: "actions", header: "관리", render: (row) => (
      <div className="toolbar">
        <CollaborationLink row={row} />
        {canManage ? <button className="button" type="button" onClick={() => openDialog({ kind: "editor", collaboration: row })}
          aria-label={`${row.nickname} 협업 수정`}>
          <Pencil size={14} aria-hidden="true" /> 수정
        </button> : null}
        {canNumber ? <button className="button" type="button" onClick={() => openDialog({ kind: "numbering", collaboration: row })}
          aria-label={`${row.nickname} 소재 넘버링`}>
          넘버링{row.numbers.length ? ` (${row.numbers.length})` : ""}
        </button> : null}
        {canManage ? <button className="button danger" type="button" onClick={() => openDialog({ kind: "remove", collaboration: row })}
          aria-label={`${row.nickname} 협업 삭제`}>
          <Trash2 size={14} aria-hidden="true" /> 삭제
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
        <button className="button" type="button" disabled={list.isFetching}
          onClick={() => void queryClient.invalidateQueries({ queryKey: collaborationKey })}>
          <RefreshCw size={15} aria-hidden="true" /> 저장값 새로고침
        </button>
        {canManage ? <button className="button primary" type="button" onClick={() => openDialog({ kind: "editor" })}>
          <Plus size={16} aria-hidden="true" /> 협업 등록
        </button> : null}
      </div> : null}
    </div>

    {canRead ? <InfluencerDailyPanel /> : null}
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
    {canRead && canNumber && dialog?.kind === "numbering" ? <NumberingDialog collaboration={dialog.collaboration}
      onClose={() => setDialog(null)} onSaved={() => {
        setDialog(null);
        setSavedMessage("소재 번호를 저장했습니다. 인플(담당자 이름)번호 형식의 광고가 수집되면 제품·담당자·번호가 일치하는 협업에 자동으로 집계됩니다.");
        void queryClient.invalidateQueries({ queryKey: collaborationKey });
      }} /> : null}
    {canRead && canManage && dialog?.kind === "remove" ? <DeleteCollaborationDialog collaboration={dialog.collaboration}
      onClose={() => setDialog(null)} onDeleted={() => {
        if (page > 1 && list.data?.items.length === 1 && !list.data.hasMore) setPage(page - 1);
        setDialog(null);
        setSavedMessage("협업을 삭제했습니다.");
        void queryClient.invalidateQueries({ queryKey: collaborationKey });
      }} /> : null}
  </section>;
}

function CollaborationLink({ row }: { row: Collaboration }) {
  const href = collaborationLink(row.note);
  if (!href) return <button className="button" type="button" disabled aria-label="링크 미등록" title="등록된 링크가 없습니다.">
    <ExternalLink size={15} aria-hidden="true" /> 링크
  </button>;
  return <a className="button" href={href} target="_blank" rel="noopener noreferrer" aria-label={`${row.nickname} 링크 (새 탭)`}>
    <ExternalLink size={15} aria-hidden="true" /> 링크
  </a>;
}

function collaborationLink(value: string | null) {
  const text = value?.trim();
  if (!text || !/^https?:\/\/[^/\\\s]/i.test(text) || /[\u0000-\u001f\u007f\\]/.test(text)) return null;
  try {
    const url = new URL(text);
    return url.username || url.password ? null : url.href;
  } catch {
    return null;
  }
}

function AggregationStatus({ row }: { row: Collaboration }) {
  if (row.numberingRequired && row.numbers.length === 0) return <span className="badge watch">넘버링 대기</span>;
  if (!row.aggregatedAt) return <span className="badge watch">집계 대기</span>;
  const status = !row.dataThrough ? (row.numberingRequired ? "광고 데이터 대기" : "매칭 자료 없음") : row.netPerformanceKrw === null || row.adSpendKrw === null ? "자료 확인 필요" : "집계 반영";
  return <>
    <strong>{status}</strong>
    {row.dataThrough ? <small>마지막 매칭일 {row.dataThrough}</small> : null}
    <small>집계 {storefrontTime(row.aggregatedAt)} (KST)</small>
  </>;
}

function InfluencerDailyPanel() {
  const managerField = useId();
  const [date, setDate] = useState(() => format(new Date(), "yyyy-MM-dd"));
  const [managerName, setManagerName] = useState("");
  const [page, setPage] = useState(1);
  const daily = useQuery({ ...influencerDailyOptions(date, managerName, page), enabled: Boolean(date) });
  const managers = daily.data?.managers ?? [];
  const columns: Column<InfluencerDailyRow>[] = [
    { key: "manager", header: "담당자 이름", render: row => row.managerName ?? "미등록" },
    { key: "nickname", header: "인플루언서 닉네임", render: row => <strong>{row.nickname}</strong> },
    { key: "product", header: "제품", render: row => row.productName ?? "미선택" },
    { key: "creativeCount", header: "집행 소재", render: row => `${row.creativeCount}개` },
    { key: "spend", header: "당일 광고비", render: row => money(row.adSpendKrw) },
    { key: "margin", header: "당일 광고 성과", render: row => <Performance value={row.adMarginKrw} /> }
  ];
  return <section className="panel" aria-labelledby="influencer-daily-heading">
    <h2 id="influencer-daily-heading">인플루언서 데일리 성과</h2>
    <div className={styles.dailyFilters}>
      <label className="field">
        <span className="field-label">성과 날짜</span>
        <input className="input" type="date" value={date} onChange={event => { setDate(event.target.value); setPage(1); }} />
      </label>
      <div className="field">
        <label className="field-label" htmlFor={managerField}>담당자</label>
        <select id={managerField} className="select" value={managerName} onChange={event => { setManagerName(event.target.value); setPage(1); }}>
          <option value="">전체 담당자</option>
          {managerName && !managers.includes(managerName) ? <option>{managerName}</option> : null}
          {managers.map(name => <option key={name} value={name}>{name}</option>)}
        </select>
      </div>
    </div>
    <p className={styles.help}>선택한 날짜에 광고비나 노출이 기록된 소재의 성과를 표시합니다.</p>
    {!date ? <p>성과 날짜를 선택해 주세요.</p> : null}
    {date && daily.isPending ? <p role="status">당일 성과를 불러오는 중입니다.</p> : null}
    {daily.isError ? <p className={styles.error} role="alert">당일 성과를 불러오지 못했습니다. 새로고침해 주세요.</p> : null}
    {daily.data ? <DataTable rows={daily.data.items} columns={columns} getRowKey={row => row.id}
      empty="선택한 날짜에 집계된 광고 집행 내역이 없습니다." /> : null}
    {page > 1 || daily.data?.hasMore ? <nav className={`toolbar ${styles.pagination}`} aria-label="일일 성과 목록 페이지">
      <button type="button" className="button" disabled={page === 1 || daily.isFetching} onClick={() => setPage(page - 1)}>이전</button>
      <span aria-live="polite">{page}페이지</span>
      <button type="button" className="button" disabled={!daily.data?.hasMore || daily.isFetching} onClick={() => setPage(page + 1)}>다음</button>
    </nav> : null}
  </section>;
}

function ProductPicker({ value, onChange, collaboration }: {
  value: string;
  onChange: (productId: string) => void;
  collaboration?: Collaboration;
}) {
  const productField = useId();
  const [search, setSearch] = useState("");
  const locked = Boolean(collaboration?.numbers.length);
  const products = useQuery({
    queryKey: ["products"],
    queryFn: () => apiGet<{ id: string; displayName: string; name: string; code: string; isActive: boolean }[]>("/products"),
    enabled: !locked,
    staleTime: 30_000
  });
  const text = search.trim().normalize("NFKC").toLowerCase();
  const matchesSearch = (product: NonNullable<typeof products.data>[number]) =>
    [product.displayName, product.name, product.code].some(label => label.normalize("NFKC").toLowerCase().includes(text));
  const options = (products.data ?? []).filter(product => product.isActive && (product.id === value || matchesSearch(product)));
  const savedName = collaboration?.productName;
  return <div className={styles.note}>
    {!locked ? <label className="field">
      <span className="field-label">제품 검색</span>
      <input className="input" type="search" value={search} onChange={event => setSearch(event.target.value)}
        placeholder="제품 이름 또는 코드" />
    </label> : null}
    <div className="field">
      <label className="field-label" htmlFor={productField}>제품</label>
      <select id={productField} className="select" value={value} required disabled={locked} onChange={event => onChange(event.target.value)}>
        <option value="">{products.isPending && !locked ? "제품을 불러오는 중입니다" : "제품 선택"}</option>
        {value && savedName && !options.some(product => product.id === value) ? <option value={value}>{savedName}</option> : null}
        {options.map(product => <option key={product.id} value={product.id}>{product.displayName}</option>)}
      </select>
      {locked ? <span className="field-help">제품을 바꾸려면 관리자가 저장한 소재 번호를 먼저 지워야 합니다.</span> : null}
    </div>
    {products.isError ? <p className={styles.error} role="alert">제품 목록을 불러오지 못했습니다.</p> : null}
    {text && products.data && !options.some(matchesSearch) ? <p className={styles.help}>일치하는 제품이 없습니다.</p> : null}
  </div>;
}

function CollaborationEditor({ collaboration, onClose, onSaved }: {
  collaboration?: Collaboration;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { user } = useAuth();
  const [formError, setFormError] = useState("");
  const [productId, setProductId] = useState(collaboration?.productId ?? "");
  const savedNote = collaboration?.note ?? null;
  const savedLink = collaborationLink(savedNote);
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
    const managerName = String(fields.get("managerName")).trim();
    const nickname = String(fields.get("nickname")).trim();
    const feeKrw = Number(fields.get("feeKrw"));
    const startDate = String(fields.get("startDate"));
    const link = String(fields.get("link")).trim();
    if (!managerName || !nickname || !productId) {
      setFormError("담당자 이름, 인플루언서 닉네임, 제품을 입력해 주세요.");
      return;
    }
    if (!Number.isSafeInteger(feeKrw) || feeKrw < 0 || feeKrw > maxFeeKrw) {
      setFormError("섭외비를 0원 이상의 정수로 입력해 주세요.");
      return;
    }
    if (link && !collaborationLink(link)) {
      setFormError("https:// 또는 http://로 시작하는 링크를 입력해 주세요.");
      return;
    }
    setFormError("");
    save.mutate({ managerName, nickname, productId, feeKrw, startDate, note: link || (savedLink ? null : savedNote) });
  }

  return <InfluencerDialog title={collaboration ? "협업 수정" : "협업 등록"} onClose={onClose} busy={save.isPending}>
    <p className={styles.help}>
      협업을 등록하면 관리자가 광고에 사용할 소재 번호를 미리 지정할 수 있습니다.
    </p>
    <form onSubmit={submit}>
      <fieldset className={styles.fields} disabled={save.isPending}>
        <label className="field">
          <span className="field-label">담당자 이름</span>
          <input className="input" name="managerName" defaultValue={collaboration ? collaboration.managerName ?? "" : user?.name ?? ""} maxLength={100} required />
        </label>
        <label className="field">
          <span className="field-label">인플루언서 닉네임</span>
          <input className="input" name="nickname" defaultValue={collaboration?.nickname} maxLength={100} required />
        </label>
        <label className="field">
          <span className="field-label">섭외비 (원)</span>
          <input className="input" name="feeKrw" type="number" inputMode="numeric" min={0} max={maxFeeKrw} step={1}
            placeholder="150000" defaultValue={collaboration?.feeKrw} required />
        </label>
        <label className="field">
          <span className="field-label">측정 시작일</span>
          <input className="input" name="startDate" type="date" defaultValue={collaboration?.startDate ?? format(new Date(), "yyyy-MM-dd")} required />
        </label>
        <ProductPicker value={productId} onChange={setProductId} collaboration={collaboration} />
        <label className={`field ${styles.note}`}>
          <span className="field-label">링크 (선택)</span>
          <input className="input" name="link" inputMode="url" autoComplete="url" spellCheck={false}
            placeholder="https://" defaultValue={savedLink ? savedNote?.trim() : ""} maxLength={1000} />
          {savedNote && !savedLink ? <span className="field-help">기존 메모: {savedNote}</span> : null}
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
  return <InfluencerDialog title={`${collaboration.nickname} · 소재별 누적 성과`} onClose={onClose} wide>
    <p className={styles.help}>측정 시작일 {collaboration.startDate}. 섭외비는 협업의 최종 성과에 한 번 반영됩니다.</p>
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

function NumberingDialog({ collaboration, onClose, onSaved }: {
  collaboration: Collaboration;
  onClose: () => void;
  onSaved: () => void;
}) {
  const hintId = useId();
  const [validation, setValidation] = useState("");
  const path = `${resource}/${encodeURIComponent(collaboration.id)}`;
  const save = useMutation({
    mutationFn: (numbers: string[]) => apiPatch(`${path}/numbering`, { version: collaboration.version, numbers }),
    onSuccess: onSaved
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = String(new FormData(event.currentTarget).get("numbers") ?? "").trim();
    const numbers = input.split(/[\s,]+/).filter(Boolean);
    if (numbers.length > 30 || numbers.some(number => !/^[0-9]{1,16}$/.test(number))) {
      setValidation("소재 번호는 16자리 이내의 숫자로 최대 30개까지 입력해 주세요.");
      return;
    }
    setValidation("");
    save.mutate(numbers);
  }
  return <InfluencerDialog title={`${collaboration.nickname} · 소재 넘버링`} onClose={onClose} busy={save.isPending}>
    {collaboration.productId ? <form onSubmit={submit}>
      <p className={styles.help}>제품 {collaboration.productName}, 담당자 {collaboration.managerName}의 번호를 미리 저장합니다.
        광고명에 <code>인플({collaboration.managerName})번호</code>가 있어야 자동으로 매칭됩니다.</p>
      <label className="field">
        <span className="field-label">소재 번호</span>
        <textarea className="input" name="numbers" rows={3} maxLength={600}
          aria-describedby={hintId} defaultValue={collaboration.numbers.join(", ")} placeholder="0015, 0016"
          disabled={save.isPending} onChange={() => { setValidation(""); save.reset(); }} />
      </label>
      <p className={styles.help} id={hintId}>여러 번호는 쉼표나 줄바꿈으로 구분하세요. 번호를 모두 지우고 저장하면 등록을 해제합니다.</p>
      {validation || save.isError ? <p className={styles.error} role="alert">
        {validation || apiErrorMessage(save.error, "소재 번호를 저장하지 못했습니다.")}
      </p> : null}
      <div className={`toolbar ${styles.dialogActions}`}>
        <button className="button" type="button" onClick={onClose} disabled={save.isPending}>취소</button>
        <button className="button primary" type="submit" disabled={save.isPending}>{save.isPending ? "저장 중…" : "번호 저장"}</button>
      </div>
    </form> : <>
      <p>협업 수정에서 제품을 먼저 선택해 주세요.</p>
      <div className={`toolbar ${styles.dialogActions}`}><button className="button" type="button" onClick={onClose}>닫기</button></div>
    </>}
  </InfluencerDialog>;
}

function DeleteCollaborationDialog({ collaboration, onClose, onDeleted }: {
  collaboration: Collaboration;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const path = `${resource}/${encodeURIComponent(collaboration.id)}?${new URLSearchParams({ version: collaboration.version })}`;
  const remove = useMutation({ mutationFn: () => apiDelete(path), onSuccess: onDeleted });
  return <InfluencerDialog title="협업 삭제" onClose={onClose} busy={remove.isPending}>
    <p><strong>{collaboration.nickname}</strong> 협업을 삭제할까요?</p>
    <p className={styles.help}>데일리·누적 성과 목록에서 사라지고 이 협업에 저장된 소재 번호가 해제됩니다.</p>
    {remove.isError ? <p className={styles.error} role="alert">
      {apiErrorMessage(remove.error, "협업을 삭제하지 못했습니다.")}
    </p> : null}
    <div className={`toolbar ${styles.dialogActions}`}>
      <button className="button" type="button" onClick={onClose} disabled={remove.isPending}>취소</button>
      <button className="button danger" type="button" onClick={() => remove.mutate()} disabled={remove.isPending}>
        {remove.isPending ? "삭제 중…" : "협업 삭제 확인"}
      </button>
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
