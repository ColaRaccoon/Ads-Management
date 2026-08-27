"use client";

import { FormEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { passwordErrorMessage } from "@/features/user-management/user-management";
import { useAuth } from "@/features/auth/use-auth";

export default function CompleteInvitationPage() {
  const auth = useAuth();
  const router = useRouter();
  const submitting = useRef(false);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (auth.status !== "onboarding") {
    return (
      <main className="auth-screen">
        <section className="auth-card auth-loading" aria-busy="true" aria-live="polite">
          최초 설정 세션을 확인하고 있습니다.
        </section>
      </main>
    );
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    if (password.length < 12 || password.length > 128) {
      setError("비밀번호는 12자 이상 128자 이하로 입력해 주세요.");
      return;
    }
    if (password !== confirmation) {
      setError("비밀번호 확인이 일치하지 않습니다.");
      return;
    }
    submitting.current = true;
    setIsSubmitting(true);
    setError(null);
    try {
      await auth.completeInvitation(password);
      setPassword("");
      setConfirmation("");
      router.replace("/dashboard");
    } catch (requestError) {
      setError(passwordErrorMessage(requestError));
    } finally {
      submitting.current = false;
      setIsSubmitting(false);
    }
  }

  return (
    <main className="auth-screen">
      <section className="auth-card" aria-labelledby="complete-invitation-heading">
        <div className="auth-brand">Meta Ads Performance Hub</div>
        <h1 id="complete-invitation-heading">최초 비밀번호 설정</h1>
        <p>앞으로 일반 로그인에서 사용할 비밀번호를 설정해 주세요. 추가 인증 단계나 OTP는 사용하지 않습니다.</p>
        <form className="auth-form" onSubmit={submit}>
          <label>
            새 비밀번호
            <input
              type="password"
              autoComplete="new-password"
              minLength={12}
              maxLength={128}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={isSubmitting}
              required
            />
          </label>
          <label>
            새 비밀번호 확인
            <input
              type="password"
              autoComplete="new-password"
              minLength={12}
              maxLength={128}
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              disabled={isSubmitting}
              required
            />
          </label>
          {error ? <div className="auth-error" role="alert">{error}</div> : null}
          <button className="button primary" type="submit" disabled={isSubmitting}>
            {isSubmitting ? "설정 중…" : "비밀번호 설정 완료"}
          </button>
        </form>
        <button className="button" type="button" disabled={isSubmitting} onClick={() => void auth.logout()}>
          설정을 중단하고 로그아웃
        </button>
        <p className="auth-help">설정이 완료되면 사용자 이름과 비밀번호로 로그인합니다.</p>
      </section>
    </main>
  );
}
