# 새 세션 인계 프롬프트 — 최종 결정 반영

`C:\Users\seong\Desktop\workspace\Meta-Ads-Performance-security-rbac`의
`codex/security-rbac`에서 작업한다. 먼저 `보안단계별적용/AGENTS.md`,
`00_전체요구사항과실행순서.md`, `0826로컬다중사용자보안전환계획.md`,
`진행상태.md`를 끝까지 읽고 HEAD, status, 전체 diff를 확인한다. 기존 변경을
reset/checkout/discard하지 않는다.

최종 아키텍처는 **기존 Supabase PostgreSQL DB만 유지**, local native username
Auth, repository 밖 NTFS local Storage다. Supabase Auth/Storage/self-hosting과
로컬 PostgreSQL을 사용하지 않는다. Web/API는 loopback, 승인된 client는 private
LAN의 HTTPS 443 Edge만 사용한다. hostname/IP/CIDR/client/path는 install-time이며
미설정 상태는 fail-closed다. router forwarding/UPnP/인터넷 공개/외부 배포·과금,
실제 이메일, push, 원본 main worktree와 기존 3100/4100 변경은 금지한다.

client certificate trust, Windows Firewall/service/principal right/ACL, production
DB migration/restore, 기존 process 전환은 exact target·impact·rollback을 제시하고
실행 직전 승인을 받는다. 비밀값·개인정보·파일 원문은 출력·기록·commit하지 않는다.

전체 test/lint/build/Prisma, 승인된 isolated Supabase migration/restore/integration,
LAN 경계, 네 역할·inactive·setup-pending, KPI, file restore hash, reboot,
maintenance/rollback을 검증한다. 실제 대상/승인이 없는 항목을 PASS로 가장하지
않는다. 마지막에는 원 요구사항과 최종 결과물만 받은 local 운영·통합, 업무 회귀,
적대적 보안 세 독립 평가를 수행하고 열린 P0–P3가 0개일 때 진행상태/운영·복구
절차, 논리적 commit, clean worktree로 종료한다.
