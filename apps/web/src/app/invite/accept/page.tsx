"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useAuth } from "@/features/auth/use-auth";
import {
  invitationAcceptanceError,
  takeInvitationTokenHash
} from "@/features/user-management/user-management";

type AcceptanceState = "initializing" | "ready" | "submitting" | "error" | "accepted" | "unavailable" | "restored";

export default function InvitationAcceptPage() {
  const auth = useAuth();
  const router = useRouter();
  const initialized = useRef(false);
  const tokenHash = useRef<string | null>(null);
  const submitting = useRef(false);
  const [state, setState] = useState<AcceptanceState>("initializing");
  const [message, setMessage] = useState<string | null>(null);
  const [activeSessionConflict, setActiveSessionConflict] = useState(false);

  useLayoutEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    tokenHash.current = takeInvitationTokenHash(window.location, window.history);
    setState(tokenHash.current ? "ready" : "unavailable");
  }, []);

  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      tokenHash.current = null;
      submitting.current = false;
      setState("restored");
      setMessage("브라우저 기록에서 복원된 초대 화면은 다시 사용할 수 없습니다. 원래 초대 링크를 다시 열어 주세요.");
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

  async function accept() {
    if (submitting.current || !tokenHash.current || state === "accepted") return;
    submitting.current = true;
    setState("submitting");
    setMessage(null);
    setActiveSessionConflict(false);
    try {
      await auth.acceptInvitation(tokenHash.current);
      tokenHash.current = null;
      setState("accepted");
      router.replace("/complete-invitation");
    } catch (error) {
      const result = invitationAcceptanceError(error);
      setMessage(result.message);
      setActiveSessionConflict(result.activeSession);
      if (!result.retryable) tokenHash.current = null;
      setState(result.retryable ? "error" : "unavailable");
    } finally {
      submitting.current = false;
    }
  }

  return (
    <main className="auth-screen">
      <section className="auth-card" aria-labelledby="invitation-heading">
        <div className="auth-brand">Meta Ads Performance Hub</div>
        <h1 id="invitation-heading">업무 계정 초대 확인</h1>
        {state === "initializing" ? (
          <p aria-busy="true" aria-live="polite">초대 링크를 안전하게 준비하고 있습니다.</p>
        ) : (
          <p>아래 버튼을 눌러야 초대 링크가 확인됩니다. 링크를 연 것만으로는 계정이 활성화되지 않습니다.</p>
        )}
        {state === "ready" ? (
          <div className="read-only-notice">초대를 확인한 뒤 최초 비밀번호 설정 화면으로 이동합니다.</div>
        ) : null}
        {message ? <div className="auth-error" role="alert">{message}</div> : null}
        {tokenHash.current ? (
          <button
            className="button primary"
            type="button"
            disabled={state === "submitting" || state === "accepted"}
            onClick={() => void accept()}
          >
            {state === "submitting" ? "초대 확인 중…" : state === "error" ? "다시 시도" : "초대 수락"}
          </button>
        ) : null}
        {activeSessionConflict ? (
          <button className="button" type="button" onClick={() => void auth.logout()}>
            현재 계정에서 로그아웃
          </button>
        ) : null}
        {state === "unavailable" || state === "restored" ? (
          <Link className="button" href={auth.isAuthenticated ? "/dashboard" : "/login"}>
            {auth.isAuthenticated ? "현재 계정으로 돌아가기" : "로그인 화면"}
          </Link>
        ) : null}
        {state !== "initializing" ? (
          <p className="auth-help">초대 확인 값은 이 화면의 메모리에만 보관되며 주소와 브라우저 저장소에는 남기지 않습니다.</p>
        ) : null}
      </section>
    </main>
  );
}
