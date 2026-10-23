/** Keep the API's decimal strings exact, including values above Number.MAX_SAFE_INTEGER. */
export function storefrontDecimal(value: string | null | undefined) {
  if (value == null || !/^-?\d+(?:\.\d+)?$/.test(value)) return "—";
  const [integer, fraction] = value.split(".");
  const sign = integer.startsWith("-") ? "-" : "";
  const digits = sign ? integer.slice(1) : integer;
  const decimal = fraction?.replace(/0+$/, "");
  return `${sign}${digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${decimal ? `.${decimal}` : ""}`;
}

export function storefrontMoney(value: string | null | undefined, currency = "KRW") {
  const formatted = storefrontDecimal(value);
  return formatted === "—" ? formatted : `${formatted} ${currency === "KRW" ? "원" : currency}`;
}

export function storefrontTime(value: string | null | undefined) {
  if (!value || !Number.isFinite(Date.parse(value))) return "기록 없음";
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  }).format(new Date(value));
}

export function storefrontToday(timeZone: string, now = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
    const part = (type: string) => parts.find((value) => value.type === type)?.value ?? "";
    return `${part("year")}-${part("month")}-${part("day")}`;
  } catch { return null; }
}

const LABELS: Record<string, string> = {
  CAFE24: "Cafe24", META: "Meta", GOOGLE: "Google", KAKAO: "카카오",
  COMPLETE_ZERO: "정상 수집 · 0", COMPLETE_NONZERO: "수집 완료", COMPLETE: "수집 완료",
  MISSING: "미수집", NOT_COLLECTED: "미수집", NOT_CONNECTED: "미연동", UNCONNECTED: "미연동",
  PARTIAL: "부분 수집 / 일부 실패", FAILED: "수집 실패", STALE: "오래된 데이터",
  AUTH_REQUIRED: "재연결 필요", ACTION_REQUIRED: "확인 필요", REAUTH_REQUIRED: "재연결 필요",
  PROVIDER_AUTH_REQUIRED: "재연결 필요", PAUSED: "수집 중지", NOT_STARTED: "미시작",
  READY: "연결 준비 완료", PENDING: "연결 확인 필요", BLOCKED: "연결 차단",
  SUCCEEDED: "성공", RUNNING: "실행 중", QUEUED: "대기", RETRY_WAIT: "재시도 대기",
  CANCELLED: "중지됨", EXPIRED: "실행 기한 만료", UNSUPPORTED: "입력 확인 필요",
  CSV: "CSV", API: "자동 연결", MIXED: "날짜별 원천 선택", UNKNOWN: "확인 필요",
  SOURCE_SELECTION_REQUIRED: "CSV와 자동 연결 자료의 원천 선택이 필요합니다. 기존 성공 자료를 보존했습니다.",
  CURRENCY_MISMATCH: "계정 통화가 달라 합산할 수 없습니다.",
  MIXED_ACCOUNT_CURRENCIES: "같은 채널의 계정 통화가 달라 원본 금액 합계를 표시하지 않습니다. 계정별 금액을 확인하세요.",
  TIMEZONE_MISMATCH: "계정 날짜 기준이 달라 합산을 제한합니다.",
  MISSING_EXCHANGE_RATE: "환율이 없어 원화 합계와 비율을 확정할 수 없습니다.",
  EXCHANGE_RATE_MISSING: "환율이 없어 원화 합계와 비율을 확정할 수 없습니다.",
  CAFE24_PRODUCT_MAPPING_INCOMPLETE: "미매칭 품목은 보존하며 매칭된 품목만 매출 계산에 반영합니다.",
  SCHEDULE_MISSED: "예약 수집 누락이 있습니다. 필요한 날짜를 하루씩 선택해 복구하세요.",
  MISSING_SCHEDULE: "예약 수집 누락 · 수동 하루 복구 필요",
  SCHEDULE_INCOMPLETE: "예약 수집 진행 중 / 미완료",
  OLDER_SCHEDULE_HISTORY_NOT_SCANNED: "오래된 예약 이력은 확인 범위 밖입니다.",
  STALE_DATA: "오래된 데이터 · 최근 성공 시점을 확인하세요.",
  CAFE24_LEGACY_MATCHED_REVENUE: "Cafe24 매출은 기존 계산의 매칭된 품목 기준입니다.",
  GOOGLE_COMMON_UNALLOCATED: "Google 비용은 공통 미배분 비용이며 상품별 마진에 반복 배분하지 않습니다.",
  PAST_CHANGES_REQUIRE_MANUAL_DAY_RERUN: "늦게 바뀐 자료는 자동 보정하지 않습니다. 필요한 날짜 하루를 직접 선택해 재실행하세요.",
  KAKAO_NOT_CONNECTED: "카카오는 미연동이며 광고비가 0원이라고 확인한 상태가 아닙니다.",
  INCOMPATIBLE_SCOPE: "계정 통화 또는 날짜 기준이 달라 합산을 제한합니다.",
  STOREFRONT_RANGE_LIMIT: "조회 기간은 최대 92일입니다. 기간을 줄여 주세요.",
  STOREFRONT_ROW_LIMIT: "조회할 자료가 많습니다. 기간을 줄여 주세요.",
  CONNECTION_STATE_CONFLICT: "다른 작업에서 연결 상태가 변경되었습니다. 새로고침한 뒤 다시 선택하세요.",
  STALE_CONNECTION: "다른 작업에서 연결 상태가 변경되었습니다. 새로고침한 뒤 다시 선택하세요.",
  SYNC_IN_PROGRESS: "수집이 진행 중입니다. 완료 후 중지·재개를 다시 선택하세요.",
  FIELD_UNSUPPORTED: "수집 입력 중 지원·검증되지 않은 항목이 있습니다. 이전 성공 자료와 최근 시도 결과를 구분해 확인하세요.",
  LEGACY_PRODUCT_FX_FALLBACK: "일부 Meta 비용은 기존 상품별 환율을 사용합니다. 공통 환율표의 적용 범위와 다를 수 있습니다.",
  DAILY_SYNC_DISABLED: "자동 연결 수집 기능이 꺼져 있습니다. 개별 연결의 사용 설정과 실제 수집 가능 상태는 다를 수 있습니다.",
  DAILY_SYNC_SCHEDULE_DISABLED: "예약 수집이 꺼져 있습니다. 연결을 사용하도록 설정해도 예약은 실행되지 않습니다.",
  PROVIDER_UNAVAILABLE: "현재 연결을 사용할 수 없습니다. 기존 성공 자료는 보존됩니다.",
  ACCOUNT_SCOPE_MISMATCH: "이 계정의 연결 범위를 확인하세요.",
  LEASE_BUSY: "같은 계정의 수집이 진행 중입니다.",
  RUN_LIMIT_EXCEEDED: "완료된 날짜 하루만 선택해 다시 실행하세요.",
  DATA_READ_FORBIDDEN: "데이터 조회 권한이 없습니다.",
  AUTHENTICATION_REQUIRED: "로그인이 필요합니다."
};

export function storefrontLabel(value: string | null | undefined) {
  if (!value) return "기록 없음";
  return LABELS[value] ?? "확인 필요";
}

export function storefrontError(error: unknown, fallback = "처리하지 못했습니다. 상태를 다시 확인하세요.") {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    return LABELS[error.code] ?? fallback;
  }
  return fallback;
}

/** Deliberately no focus/reconnect/interval refresh: only route/filter entry and user actions read. */
export const STOREFRONT_QUERY_OPTIONS = {
  staleTime: Infinity,
  refetchOnMount: "always",
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  refetchInterval: false,
  refetchIntervalInBackground: false,
  retry: false
} as const;
