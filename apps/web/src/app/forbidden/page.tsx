"use client";

import Link from "next/link";
import { useAuth } from "@/features/auth/use-auth";

export default function ForbiddenPage() {
  const auth = useAuth();
  return (
    <main className="auth-screen auth-screen-inline">
      <section className="auth-card" aria-labelledby="forbidden-heading">
        <h1 id="forbidden-heading">접근할 수 없습니다</h1>
        <p>이 계정에 필요한 권한이 없거나 아직 업무 계정 연결이 완료되지 않았습니다.</p>
        <div className="toolbar">
          {auth.isAuthenticated ? <Link className="button primary" href="/dashboard">Dashboard로 이동</Link> : null}
          {auth.status === "anonymous" ? (
            <Link className="button" href="/login">로그인 화면</Link>
          ) : (
            <button
              className="button"
              type="button"
              onClick={() => void auth.logout().catch(() => undefined)}
            >
              다른 계정으로 로그인
            </button>
          )}
        </div>
      </section>
    </main>
  );
}
