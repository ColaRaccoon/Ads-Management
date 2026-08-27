import { ApiError, apiErrorCode } from "@/lib/api";
import {
  APP_ROLES,
  AppRole,
  AUTH_INVITE_STATUSES,
  AuthInviteStatus,
  roleLabel
} from "@/features/auth/auth-types";

export const INVITE_STATUSES = AUTH_INVITE_STATUSES;
export type InviteStatus = AuthInviteStatus;

export const RECONCILIATION_ACTIONS = ["RETRY_INVITATION", "CANCEL"] as const;
export type ReconciliationAction = (typeof RECONCILIATION_ACTIONS)[number];

export type UserSummary = {
  id: string;
  username: string;
  email: string | null;
  name: string;
  role: AppRole;
  isActive: boolean;
  inviteStatus: InviteStatus;
  reconciliationActions: ReconciliationAction[];
  lastLoginAt: string | null;
  invitedAt: string | null;
  createdAt: string;
  updatedAt: string;
  setupToken?: string;
};

export type InvitationPayload = {
  username?: string;
  email?: string;
  name: string;
  role: AppRole;
};

export type SafeAuditItem = {
  id: string;
  actorUserId: string | null;
  actorType: "USER" | "SYSTEM" | "ANONYMOUS";
  action: string;
  targetType: string;
  targetId: string | null;
  result: string;
  summary: string;
  requestId: string | null;
  createdAt: string;
};

export type AuditPage = {
  items: SafeAuditItem[];
  nextCursor: string | null;
};

const inviteStatusSet = new Set<string>(INVITE_STATUSES);
const roleSet = new Set<string>(APP_ROLES);
const reconciliationActionSet = new Set<string>(RECONCILIATION_ACTIONS);
const actorTypeSet = new Set(["USER", "SYSTEM", "ANONYMOUS"]);
const SAFE_AUDIT_FIELDS = ["name", "role", "isActive", "inviteStatus"] as const;

export function normalizeInvitationPayload(payload: InvitationPayload): InvitationPayload {
  return {
    ...(payload.username === undefined
      ? { email: payload.email?.trim().toLowerCase() }
      : { username: payload.username.trim().toLowerCase() }),
    name: payload.name.trim(),
    role: payload.role
  };
}

export function validateInvitationPayload(payload: InvitationPayload): string | null {
  if (payload.username !== undefined && !/^[a-z][a-z0-9._-]{2,31}$/.test(payload.username)) {
    return "사용자 이름은 영문자로 시작하는 3~32자의 영문 소문자, 숫자, 점, 밑줄, 하이픈만 사용할 수 있습니다.";
  }
  if (payload.username === undefined && (
    !payload.email || payload.email.length > 320 || !/^[\x21-\x7e]+$/.test(payload.email) ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)
  )) return "올바른 이메일 주소를 입력해 주세요.";
  if (payload.name.length < 1 || payload.name.length > 120) {
    return "이름은 1자 이상 120자 이하로 입력해 주세요.";
  }
  if (!roleSet.has(payload.role)) return "허용된 역할을 선택해 주세요.";
  return null;
}

export function createIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto === "undefined" || typeof crypto.getRandomValues !== "function") {
    throw new Error("안전한 요청 식별자를 생성할 수 없습니다.");
  }
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function parseUsersResponse(value: unknown): UserSummary[] {
  if (!isRecord(value) || !Array.isArray(value.items)) throw invalidResponse();
  return value.items.map(parseUserSummary);
}

export function parseUserSummary(value: unknown): UserSummary {
  if (!isRecord(value)) throw invalidResponse();
  const role = requiredString(value.role, 32);
  const inviteStatus = requiredString(value.inviteStatus, 64);
  const summary: UserSummary = {
    id: requiredString(value.id, 128),
    username: value.username === undefined || value.username === null
      ? requiredString(value.email, 320)
      : requiredString(value.username, 32),
    email: nullableString(value.email, 320),
    name: requiredString(value.name, 120),
    role: role as AppRole,
    isActive: requiredBoolean(value.isActive),
    inviteStatus: inviteStatus as InviteStatus,
    reconciliationActions: value.reconciliationActions === undefined
      ? []
      : reconciliationActions(value.reconciliationActions),
    lastLoginAt: nullableTimestamp(value.lastLoginAt),
    invitedAt: nullableTimestamp(value.invitedAt),
    createdAt: requiredTimestamp(value.createdAt),
    updatedAt: requiredTimestamp(value.updatedAt),
    ...(value.setupToken === undefined ? {} : { setupToken: requiredString(value.setupToken, 128) })
  };
  if (!roleSet.has(role) || !inviteStatusSet.has(inviteStatus)) throw invalidResponse();
  return summary;
}

function reconciliationActions(value: unknown): ReconciliationAction[] {
  if (
    !Array.isArray(value) ||
    value.some((action) => typeof action !== "string" || !reconciliationActionSet.has(action))
  ) throw invalidResponse();
  return [...new Set(value as ReconciliationAction[])];
}

export function parseAuditResponse(value: unknown): AuditPage {
  if (!isRecord(value) || !Array.isArray(value.items)) throw invalidResponse();
  const nextCursor = value.nextCursor === null || value.nextCursor === undefined
    ? null
    : requiredString(value.nextCursor, 2048);
  return { items: value.items.map(parseAuditItem), nextCursor };
}

function parseAuditItem(value: unknown): SafeAuditItem {
  if (!isRecord(value)) throw invalidResponse();
  const actorType = requiredString(value.actorType, 32);
  if (!actorTypeSet.has(actorType)) throw invalidResponse();
  return {
    id: requiredString(value.id, 128),
    actorUserId: nullableString(value.actorUserId, 128),
    actorType: actorType as SafeAuditItem["actorType"],
    action: safeIdentifier(value.action),
    targetType: safeIdentifier(value.targetType),
    targetId: nullableString(value.targetId, 128),
    result: safeIdentifier(value.result),
    summary: safeAuditSummary(value.beforeJson, value.afterJson),
    requestId: nullableString(value.requestId, 128),
    createdAt: requiredTimestamp(value.createdAt)
  };
}

export function safeAuditSummary(beforeValue: unknown, afterValue: unknown): string {
  const before = safeAuditFields(beforeValue);
  const after = safeAuditFields(afterValue);
  const changes: string[] = [];
  for (const field of SAFE_AUDIT_FIELDS) {
    if (before[field] === after[field] || (before[field] === undefined && after[field] === undefined)) continue;
    changes.push(`${auditFieldLabel(field)}: ${displayAuditValue(field, before[field])} → ${displayAuditValue(field, after[field])}`);
  }
  return changes.length > 0 ? changes.join(" · ") : "민감정보를 제외한 상세 변경 없음";
}

function safeAuditFields(value: unknown): Partial<Record<(typeof SAFE_AUDIT_FIELDS)[number], string | boolean | null>> {
  if (!isRecord(value)) return {};
  const result: Partial<Record<(typeof SAFE_AUDIT_FIELDS)[number], string | boolean | null>> = {};
  for (const field of SAFE_AUDIT_FIELDS) {
    const fieldValue = value[field];
    if (typeof fieldValue === "boolean" || fieldValue === null) result[field] = fieldValue;
    if (typeof fieldValue === "string" && fieldValue.length <= 100 && !hasControlCharacters(fieldValue)) {
      result[field] = fieldValue;
    }
  }
  return result;
}

function displayAuditValue(field: (typeof SAFE_AUDIT_FIELDS)[number], value: string | boolean | null | undefined) {
  if (value === undefined || value === null) return "-";
  if (typeof value === "boolean") return value ? "활성" : "비활성";
  if (field === "role" && roleSet.has(value)) return roleLabel(value as AppRole);
  if (field === "inviteStatus" && inviteStatusSet.has(value)) return inviteStatusLabel(value as InviteStatus);
  return value;
}

function auditFieldLabel(field: (typeof SAFE_AUDIT_FIELDS)[number]) {
  return { name: "이름", role: "역할", isActive: "계정", inviteStatus: "설정 상태" }[field];
}

export function invitationErrorMessage(error: unknown): string {
  const code = apiErrorCode(error);
  const messages: Record<string, string> = {
    USER_EMAIL_EXISTS: "이미 등록되었거나 초대 처리 중인 이메일입니다.",
    USERNAME_EXISTS: "이미 등록되었거나 설정 대기 중인 사용자 이름입니다.",
    USERNAME_INVALID: "사용자 이름 형식이 올바르지 않습니다.",
    IDEMPOTENCY_KEY_INVALID: "사용자 설정 요청 식별자를 만들지 못했습니다. 입력을 다시 확인해 주세요.",
    IDEMPOTENCY_KEY_CONFLICT: "같은 요청 식별자가 다른 사용자 설정 내용에 사용되었습니다. 입력을 다시 확인해 주세요.",
    IDEMPOTENCY_REPLAY: "이 사용자 추가 요청은 이미 처리되었습니다. 새로고침된 목록에서 사용자를 선택해 설정 코드를 재발급하세요.",
    INVITATION_PROVIDER_UNAVAILABLE: "사용자 설정 요청을 처리하지 못했습니다. 같은 요청으로 다시 시도해 주세요.",
    INVITATION_NOT_RECONCILABLE: "현재 설정 상태에서는 이 작업을 수행할 수 없습니다.",
    INVITATION_LOCAL_COMMIT_FAILED: "사용자 설정 상태를 반영하지 못했습니다. 계정은 활성화되지 않았습니다.",
    LAST_ACTIVE_SUPER_ADMIN: "마지막 활성 총관리자의 역할 또는 상태는 변경할 수 없습니다.",
    SELF_LOCKOUT: "현재 로그인한 계정을 잠그는 변경은 허용되지 않습니다.",
    INVALID_USER_TRANSITION: "현재 사용자 상태에서는 요청한 변경을 수행할 수 없습니다.",
    USER_NOT_FOUND: "사용자를 찾을 수 없습니다. 목록을 새로고침해 주세요."
  };
  return code && messages[code] ? messages[code] : "사용자 관리 요청을 안전하게 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.";
}

export function invitationAcceptanceError(error: unknown): { message: string; retryable: boolean; activeSession: boolean } {
  const code = apiErrorCode(error);
  if (code === "ACTIVE_SESSION_PRESENT") {
    return {
      message: "다른 계정으로 이미 로그인되어 있어 설정 코드를 수락하지 않았습니다. 현재 계정에서 로그아웃하거나 시크릿 창에서 다시 여세요.",
      retryable: true,
      activeSession: true
    };
  }
  if (error instanceof ApiError && error.status === 429) {
    return {
      message: "요청이 너무 많습니다. 잠시 기다린 뒤 이 화면에서 다시 시도해 주세요.",
      retryable: true,
      activeSession: false
    };
  }
  return {
    message: code === "INVITATION_INVALID_OR_EXPIRED"
      ? "설정 코드가 만료되었거나 이미 사용되었습니다. 총관리자에게 새 코드를 요청해 주세요."
      : "설정 코드를 확인하지 못했습니다. 잠시 후 다시 시도하거나 총관리자에게 문의해 주세요.",
    retryable: code === "AUTH_PROVIDER_UNAVAILABLE",
    activeSession: false
  };
}

export function passwordErrorMessage(error: unknown): string {
  const code = apiErrorCode(error);
  if (code === "PASSWORD_POLICY_INVALID") return "비밀번호 정책을 충족하지 않습니다. 12자 이상으로 다시 입력해 주세요.";
  if (code === "ONBOARDING_SESSION_REQUIRED") return "최초 설정 세션이 만료되었습니다. 총관리자에게 새 설정 코드를 요청해 주세요.";
  if (code === "PASSWORD_PROVIDER_UNAVAILABLE") return "비밀번호 설정을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.";
  if (code === "PASSWORD_LOCAL_COMMIT_FAILED") return "비밀번호 설정 뒤 계정 활성화에 실패했습니다. 업무 접근은 계속 차단되어 있습니다.";
  if (error instanceof ApiError && error.status === 429) return "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.";
  return "비밀번호를 설정하지 못했습니다. 잠시 후 다시 시도해 주세요.";
}

export function inviteStatusLabel(status: InviteStatus) {
  return {
    PENDING_PROVIDER: "설정 요청 처리 중",
    INVITED: "설정 코드 발급됨",
    VERIFIED_PENDING_PASSWORD: "비밀번호 설정 대기",
    ACTIVE: "활성화 완료",
    RECONCILE_REQUIRED: "설정 확인 필요",
    CANCELLED: "설정 요청 취소"
  }[status];
}

export function takeInvitationTokenHash(
  location: Pick<Location, "hash" | "pathname" | "search">,
  history: Pick<History, "replaceState" | "state">
) {
  const raw = location.hash.startsWith("#") ? location.hash.slice(1) : location.hash;
  const params = new URLSearchParams(raw);
  const tokenHash = params.get("token_hash");
  history.replaceState(history.state, "", `${location.pathname}${location.search}`);
  if (!tokenHash || tokenHash.length < 32 || tokenHash.length > 512 || !/^[A-Za-z0-9_-]+$/.test(tokenHash)) return null;
  return tokenHash;
}

function requiredString(value: unknown, maxLength: number) {
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength || hasControlCharacters(value)) {
    throw invalidResponse();
  }
  return value;
}

function nullableString(value: unknown, maxLength: number) {
  return value === null || value === undefined ? null : requiredString(value, maxLength);
}

function safeIdentifier(value: unknown) {
  const result = requiredString(value, 100);
  if (!/^[A-Za-z0-9_.:-]+$/.test(result)) throw invalidResponse();
  return result;
}

function requiredBoolean(value: unknown) {
  if (typeof value !== "boolean") throw invalidResponse();
  return value;
}

function nullableTimestamp(value: unknown) {
  return value === null || value === undefined ? null : requiredTimestamp(value);
}

function requiredTimestamp(value: unknown) {
  const result = requiredString(value, 64);
  if (Number.isNaN(Date.parse(result))) throw invalidResponse();
  return result;
}

function hasControlCharacters(value: string) {
  return /[\u0000-\u001f\u007f]/.test(value);
}

function invalidResponse() {
  return new Error("서버 응답 형식이 올바르지 않습니다.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
