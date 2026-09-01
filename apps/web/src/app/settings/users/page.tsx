"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FormEvent, useEffect, useRef, useState } from "react";
import { apiErrorCode, apiGet, apiPatch, apiRequest } from "@/lib/api";
import { PermissionPage } from "@/components/permission-page";
import { WEB_AUTH_PROVIDER } from "@/features/auth/auth-provider";
import { APP_ROLES, AppRole, roleLabel } from "@/features/auth/auth-types";
import { useAuth } from "@/features/auth/use-auth";
import {
  createIdempotencyKey,
  InvitationPayload,
  invitationErrorMessage,
  inviteStatusLabel,
  normalizeInvitationPayload,
  parseUserSummary,
  parseUsersResponse,
  UserSummary,
  validateInvitationPayload
} from "@/features/user-management/user-management";

const USERS_QUERY_KEY = ["security", "users"] as const;
const AUDIT_QUERY_KEY = ["security", "audit"] as const;

type InvitationAttempt = { payload: InvitationPayload; idempotencyKey: string };

export default function UsersPage() {
  return <PermissionPage permission="users.manage"><UsersPageContent /></PermissionPage>;
}

function UsersPageContent() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const inviteInFlight = useRef(false);
  const supabaseAuth = WEB_AUTH_PROVIDER === "supabase";
  const [identifier, setIdentifier] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<AppRole>("GUEST");
  const [attempt, setAttempt] = useState<InvitationAttempt | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [issuedSetupToken, setIssuedSetupToken] = useState<string | null>(null);

  const users = useQuery({
    queryKey: USERS_QUERY_KEY,
    queryFn: async () => {
      const parsed = parseUsersResponse(await apiGet<unknown>("/users"));
      if (!supabaseAuth) return parsed;
      return parsed.map(({ setupToken: _discarded, ...safe }) => safe);
    }
  });

  const invalidateManagementQueries = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: USERS_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: AUDIT_QUERY_KEY })
    ]);
  };

  useEffect(() => () => setIssuedSetupToken(null), []);

  const invitation = useMutation({
    mutationFn: async (value: InvitationAttempt) => {
      const created = parseUserSummary(await apiRequest<unknown>(
        "/users/invitations",
        {
          method: "POST",
          headers: { "Idempotency-Key": value.idempotencyKey },
          body: value.payload
        }
      ));
      if (!supabaseAuth && created.setupToken) setIssuedSetupToken(created.setupToken);
      const { setupToken: _discarded, ...safe } = created;
      return safe;
    },
    onSuccess: async () => {
      setAttempt(null);
      setIdentifier("");
      setName("");
      setRole("GUEST");
      await invalidateManagementQueries();
    },
    onError: async (error) => {
      if (apiErrorCode(error) === "IDEMPOTENCY_REPLAY") {
        setAttempt(null);
        await invalidateManagementQueries();
      }
    }
  });

  function resetAttempt() {
    setAttempt(null);
    setFormError(null);
    invitation.reset();
  }

  function submitInvitation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inviteInFlight.current) return;
    const payload = normalizeInvitationPayload(supabaseAuth
      ? { email: identifier, name, role }
      : { username: identifier, name, role });
    const validationError = validateInvitationPayload(payload);
    if (validationError) {
      setFormError(validationError);
      return;
    }
    const nextAttempt = { payload, idempotencyKey: createIdempotencyKey() };
    setAttempt(nextAttempt);
    runInvitation(nextAttempt);
  }

  function runInvitation(value: InvitationAttempt) {
    if (inviteInFlight.current) return;
    inviteInFlight.current = true;
    setFormError(null);
    invitation.mutate(value, { onSettled: () => { inviteInFlight.current = false; } });
  }

  return (
    <section className="page security-admin-page">
      <div className="page-title">
        <div>
          <h1>사용자 관리</h1>
          <p>{supabaseAuth
            ? "업무 계정을 초대하고 이름, 역할, 활성 상태와 초대 수명주기를 관리합니다."
            : "로컬 업무 계정과 역할, 활성 상태, 최초 설정 수명주기를 관리합니다."}</p>
        </div>
      </div>

      <div className="grid two security-admin-grid">
        <form className="panel security-invite-form" onSubmit={submitInvitation}>
          <h2>{supabaseAuth ? "사용자 초대" : "사용자 추가"}</h2>
          <p className="muted">{supabaseAuth
            ? "초대 메일의 일회용 링크를 수락한 사용자가 최초 비밀번호를 설정하면 활성화됩니다."
            : "일회용 설정 코드는 생성 직후 한 번만 표시됩니다. 실제 사용자에게 안전한 별도 채널로 전달하세요."}</p>
          <label>
            {supabaseAuth ? "이메일" : "사용자 이름"}
            <input
              className="input"
              type={supabaseAuth ? "email" : "text"}
              autoComplete="off"
              maxLength={supabaseAuth ? 320 : 32}
              pattern={supabaseAuth ? undefined : "[A-Za-z][A-Za-z0-9._-]{2,31}"}
              value={identifier}
              onChange={(event) => { setIdentifier(event.target.value); resetAttempt(); }}
              disabled={invitation.isPending}
              required
            />
          </label>
          <label>
            이름
            <input
              className="input"
              type="text"
              autoComplete="off"
              maxLength={120}
              value={name}
              onChange={(event) => { setName(event.target.value); resetAttempt(); }}
              disabled={invitation.isPending}
              required
            />
          </label>
          <label>
            역할
            <select
              className="select"
              value={role}
              onChange={(event) => { setRole(event.target.value as AppRole); resetAttempt(); }}
              disabled={invitation.isPending}
            >
              {APP_ROLES.map((item) => <option key={item} value={item}>{roleLabel(item)}</option>)}
            </select>
          </label>
          {formError ? <div className="auth-error" role="alert">{formError}</div> : null}
          {invitation.error ? <div className="auth-error" role="alert">{invitationErrorMessage(invitation.error, WEB_AUTH_PROVIDER)}</div> : null}
          {!supabaseAuth && issuedSetupToken ? (
            <div className="auth-help" role="status">
              <strong>일회용 설정 코드</strong>
              <code>{issuedSetupToken}</code>
              <button className="button" type="button" onClick={() => setIssuedSetupToken(null)}>표시 닫기</button>
            </div>
          ) : null}
          <div className="toolbar">
            <button className="button primary" type="submit" disabled={invitation.isPending}>
              {invitation.isPending
                ? supabaseAuth ? "초대 요청 중…" : "추가 중…"
                : supabaseAuth ? "초대 보내기" : "사용자 추가"}
            </button>
            {attempt && invitation.isError ? (
              <button className="button" type="button" onClick={() => runInvitation(attempt)}>
                같은 요청 다시 시도
              </button>
            ) : null}
          </div>
        </form>

        <div className="panel">
          <h2>수명주기 원칙</h2>
          <div className="security-lifecycle-list">
            <span>{supabaseAuth
              ? "초대 발송 → 링크 수락 → 최초 비밀번호 설정 → 활성화"
              : "설정 코드 전달 → 코드 수락 → 최초 비밀번호 설정 → 활성화"}</span>
            <span>일반 로그인은 {supabaseAuth ? "이메일" : "사용자 이름"}과 비밀번호만 사용</span>
            <span>계정은 삭제하지 않고 비활성화하며 마지막 총관리자는 서버가 보호</span>
          </div>
        </div>
      </div>

      <div className="panel security-users-panel">
        <div className="security-panel-heading">
          <div>
            <h2>등록 사용자</h2>
            <p className="muted">{supabaseAuth
              ? "provider 식별자, 세션 정보, 초대 확인 값은 표시하지 않습니다."
              : "credential, 세션 정보, 저장된 설정 코드 hash는 표시하지 않습니다."}</p>
          </div>
          <button className="button" type="button" disabled={users.isFetching} onClick={() => void users.refetch()}>
            {users.isFetching ? "새로고침 중…" : "새로고침"}
          </button>
        </div>
        {users.error ? <div className="auth-error" role="alert">사용자 목록을 불러오지 못했습니다.</div> : null}
        {users.isLoading ? <div className="security-empty">사용자 목록을 불러오는 중입니다.</div> : null}
        {!users.isLoading && (users.data?.length ?? 0) === 0 ? <div className="security-empty">등록된 사용자가 없습니다.</div> : null}
        <div className="security-user-list">
          {(users.data ?? []).map((user) => (
            <UserEditor
              key={user.id}
              currentUserId={auth.user?.id ?? null}
              user={user}
              onSetupToken={(token) => setIssuedSetupToken(token)}
              onChanged={async (changedUser) => {
                await invalidateManagementQueries();
                if (changedUser.id === auth.user?.id) await auth.refreshAuth();
              }}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function UserEditor({
  user,
  currentUserId,
  onChanged
  ,onSetupToken
}: {
  user: UserSummary;
  currentUserId: string | null;
  onChanged(user: UserSummary): Promise<void>;
  onSetupToken(token: string): void;
}) {
  const supabaseAuth = WEB_AUTH_PROVIDER === "supabase";
  const accountIdentifier = supabaseAuth ? user.email ?? user.username : user.username;
  const [name, setName] = useState(user.name);
  const [role, setRole] = useState(user.role);
  const [isActive, setIsActive] = useState(user.isActive);

  useEffect(() => {
    setName(user.name);
    setRole(user.role);
    setIsActive(user.isActive);
  }, [user]);

  const update = useMutation({
    mutationFn: async () => {
      const body: { name?: string; role?: AppRole; isActive?: boolean } = {};
      const normalizedName = name.trim();
      if (normalizedName !== user.name) body.name = normalizedName;
      if (role !== user.role) body.role = role;
      if (isActive !== user.isActive) body.isActive = isActive;
      if (Object.keys(body).length === 0) return user;
      if (normalizedName.length < 1 || normalizedName.length > 120) throw new Error("INVALID_LOCAL_NAME");
      if (body.isActive === false && !window.confirm(`${user.name} 계정을 비활성화할까요? 기존 세션은 즉시 차단됩니다.`)) {
        throw new Error("CANCELLED");
      }
      return parseUserSummary(await apiPatch<unknown>(`/users/${encodeURIComponent(user.id)}`, body));
    },
    onSuccess: onChanged
  });

  const reconcile = useMutation({
    mutationFn: async (action: "RETRY_INVITATION" | "CANCEL") => {
      if (action === "CANCEL" && !window.confirm(`${accountIdentifier} ${supabaseAuth ? "초대를" : "설정 요청을"} 취소할까요?`)) throw new Error("CANCELLED");
      return parseUserSummary(await apiRequest<unknown>(
        `/users/${encodeURIComponent(user.id)}/reconcile-invitation`,
        { method: "POST", body: { action } }
      ));
    },
    onSuccess: onChanged
  });

  const passwordReset = useMutation({
    mutationFn: async () => {
      if (supabaseAuth) throw new Error("LOCAL_PASSWORD_RESET_UNAVAILABLE");
      if (!window.confirm(`${user.username} 사용자의 기존 세션을 폐기하고 새 설정 코드를 발급할까요?`)) {
        throw new Error("CANCELLED");
      }
      const changed = parseUserSummary(await apiRequest<unknown>(
        `/users/${encodeURIComponent(user.id)}/password-reset`,
        { method: "POST" }
      ));
      if (changed.setupToken) onSetupToken(changed.setupToken);
      const { setupToken: _discarded, ...safe } = changed;
      return safe;
    },
    onSuccess: async (changed) => {
      await onChanged(changed);
    }
  });

  const visibleError = [update.error, reconcile.error, passwordReset.error]
    .find((error) => error && (error as Error).message !== "CANCELLED");
  const dirty = name.trim() !== user.name || role !== user.role || isActive !== user.isActive;
  const canRetry = user.reconciliationActions.includes("RETRY_INVITATION");
  const canCancel = user.reconciliationActions.includes("CANCEL");

  return (
    <article className="security-user-card">
      <div className="security-user-identity">
        <strong>{user.name}{user.id === currentUserId ? " (현재 계정)" : ""}</strong>
        <span>{accountIdentifier}</span>
        <div className="toolbar">
          <span className={`badge ${user.isActive ? "scale" : "stop_candidate"}`}>{user.isActive ? "활성" : "비활성"}</span>
          <span className="security-status-chip">{inviteStatusLabel(user.inviteStatus, WEB_AUTH_PROVIDER)}</span>
        </div>
        <small>최근 로그인 {formatTimestamp(user.lastLoginAt)} · {supabaseAuth ? "초대" : "설정 요청"} {formatTimestamp(user.invitedAt)}</small>
      </div>
      <div className="security-user-fields">
        <label>
          이름
                <input className="input" maxLength={120} value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label>
          역할
          <select className="select" value={role} onChange={(event) => setRole(event.target.value as AppRole)}>
            {APP_ROLES.map((item) => <option key={item} value={item}>{roleLabel(item)}</option>)}
          </select>
        </label>
        <label className="security-checkbox">
          <input type="checkbox" checked={isActive} onChange={(event) => setIsActive(event.target.checked)} />
          활성 계정
        </label>
      </div>
      {visibleError ? <div className="auth-error" role="alert">{invitationErrorMessage(visibleError, WEB_AUTH_PROVIDER)}</div> : null}
      <div className="toolbar security-user-actions">
        <button className="button primary" type="button" disabled={!dirty || update.isPending} onClick={() => update.mutate()}>
          {update.isPending ? "저장 중…" : "변경 저장"}
        </button>
        {dirty ? (
          <button className="button" type="button" onClick={() => {
            setName(user.name);
            setRole(user.role);
            setIsActive(user.isActive);
          }}>취소</button>
        ) : null}
        {canRetry ? <button className="button" type="button" disabled={reconcile.isPending} onClick={() => reconcile.mutate("RETRY_INVITATION")}>{supabaseAuth ? "재초대" : "설정 코드 재발급"}</button> : null}
        {canCancel ? <button className="button danger" type="button" disabled={reconcile.isPending} onClick={() => reconcile.mutate("CANCEL")}>{supabaseAuth ? "초대 취소" : "설정 요청 취소"}</button> : null}
        {!supabaseAuth && user.id !== currentUserId ? (
          <button className="button" type="button" disabled={passwordReset.isPending} onClick={() => passwordReset.mutate()}>
            {passwordReset.isPending ? "재설정 중…" : "비밀번호 재설정"}
          </button>
        ) : null}
      </div>
    </article>
  );
}

function formatTimestamp(value: string | null) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "short",
    timeStyle: "short"
  }).format(date);
}
