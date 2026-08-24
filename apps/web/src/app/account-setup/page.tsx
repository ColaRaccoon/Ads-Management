"use client";

import { useState } from "react";
import { useAuth } from "@/features/auth/use-auth";

export default function AccountSetupPage() {
  const { logout } = useAuth();
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  return (
    <main className="auth-screen">
      <section className="auth-card" aria-labelledby="account-setup-heading">
        <div className="auth-brand">Meta Ads Performance Hub</div>
        <h1 id="account-setup-heading">계정 설정이 필요합니다</h1>
        <p>
          초대 확인과 최초 비밀번호 설정을 완료한 뒤 업무 화면을 사용할 수 있습니다.
          계정 설정 기능은 다음 보안 단계에서 제공됩니다.
        </p>
        <div className="read-only-notice">설정이 완료될 때까지 업무 메뉴와 데이터는 표시되지 않습니다.</div>
        <button
          className="button"
          type="button"
          disabled={isLoggingOut}
          onClick={async () => {
            setIsLoggingOut(true);
            try {
              await logout();
            } finally {
              setIsLoggingOut(false);
            }
          }}
        >
          {isLoggingOut ? "로그아웃 중…" : "로그아웃"}
        </button>
      </section>
    </main>
  );
}
