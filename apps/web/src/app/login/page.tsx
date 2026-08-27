"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { safeNextPath } from "@/features/auth/auth-redirect";
import { useAuth } from "@/features/auth/use-auth";

export default function LoginPage() {
  const auth = useAuth();
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSubmitting) return;
    setIsSubmitting(true);
    setError(null);
    try {
      await auth.login(username, password);
      const next = safeNextPath(new URLSearchParams(window.location.search).get("next"));
      router.replace(next);
    } catch {
      setError("로그인할 수 없습니다. 사용자 이름과 비밀번호를 확인하거나 관리자에게 문의해 주세요.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="auth-screen">
      <section className="auth-card" aria-labelledby="login-heading">
        <div className="auth-brand">Meta Ads Performance Hub</div>
        <h1 id="login-heading">로그인</h1>
        <p>발급된 로컬 업무 계정으로 로그인해 주세요.</p>
        <form className="auth-form" onSubmit={submit}>
          <label>
            사용자 이름
            <input
              type="text"
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              pattern="[A-Za-z][A-Za-z0-9._-]{2,31}"
              required
              disabled={isSubmitting}
            />
          </label>
          <label>
            비밀번호
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              disabled={isSubmitting}
            />
          </label>
          {error ? <div className="auth-error" role="alert">{error}</div> : null}
          <button className="button primary" type="submit" disabled={isSubmitting}>
            {isSubmitting ? "로그인 중…" : "로그인"}
          </button>
        </form>
        <p className="auth-help">계정 또는 비밀번호 도움이 필요하면 총관리자에게 문의해 주세요.</p>
      </section>
    </main>
  );
}
