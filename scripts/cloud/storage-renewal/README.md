# 운영 Storage 토큰 자동 갱신

2026-09-14 적용·첫 갱신 검증 완료. PC가 꺼져 있어도 Supabase에서 실행한다.
앱의 권한·서명키·Storage subject를 유지한다. 업무 데이터는 변경하지 않는다.

## 현재 실행

- Supabase `iygjmosbelbosfxidqxv`, Edge Function `storage-renewal` 버전 1 / ACTIVE.
- 매일 한국시간 04:00: 남은 기간이 3일 이하일 때 같은 `storage_app` 역할의 6일 JWT를 발급한다.
- 04:15: 서명·Storage sentinel·갱신 이후 Railway 성공 배포·보호된 앱 readiness를 검사한다.
- 04:20: 앞선 두 실행의 존재·성공·만료 여유를 확인한다.
- 최초 갱신 배포 `f34a212d-9d2c-4d91-b957-fa3a1a2e24b3` SUCCESS.
  새 토큰 만료는 **2026-09-20 10:38:05 KST**다.
- 최종 DB 호출 경로와 후속 감사의 실제 실행은 통과했다. 첫 정시 예약 실행은 9월 15일 04:00이다.

## 비밀값과 호출 방식

기존 서명 JWK, 환경 전용 Railway Project Token, 별도 호출 비밀값은 사용자 명시 승인 후
Supabase Functions 프로젝트 보호 secret에 저장했다. 다른 함수도 프로젝트 secret에 접근할 수
있으며, 현재 이 프로젝트에는 이 함수 하나만 있다. 서명 개인키를 Railway 앱에는 전달하지 않는다.
Railway 토큰 자체는 해당 환경의 변수·배포 권한을 가지며, 함수 코드가 수정 대상을 토큰 변수 하나로 제한한다.

호출은 별도 무작위 Bearer 비밀값으로 보호한다. Supabase 기본 JWT 검증 설정은 false지만,
함수의 비밀값 검사를 통과해야 실행된다. 비인증 요청과 이전 호출 비밀값은 403으로 거부됨을 확인했다.

Cron은 Vault에서 호출 비밀값을 읽고 공식 `http` 확장으로 직접 HTTPS 요청한다.
비밀값을 요청 큐에 넣지 않는다. 새 관리 스키마 `storage_renewal_ops`에는 시각·결과만 저장하며,
anon/authenticated/업무 runtime 역할의 스키마·Vault 접근은 거부된다.

초기 pg_net 시험에서 공급자 소유 큐의 PUBLIC 권한을 postgres가 제거할 수 없음을 발견했다.
최종 함수는 pg_net을 사용하지 않으며, 초기 호출 비밀값은 교체하고 이전 값의 거부를 검증했다.
초기 시험 기록과 사용하지 않는 pg_net 확장은 보존되어 있다. `secure-http.sql`은 이미 적용한 전환 기록이다.
`cron.sql`은 최종 방식의 신규 설치용이며 **현재 운영 DB에 다시 실행하지 않는다**.

## 검증·장애 확인

- `node --test scripts/cloud/storage-renewal/core.test.mjs`: 9개 통과.
- Deno 타입 검사, 실제 함수 배포, 인증 거부, 첫 갱신·배포·readiness, Vault/HTTP 호출과 감사 통과.
- HTTP 실패와 배포 미완료를 성공으로 인정하지 않는 DB 검사 통과.
- 과거 runtime DPAPI 사본을 보존하고 원격 토큰을 로컬 사본에 동기화했다.

실패 시 Cron 실행은 실패로 기록된다. 이메일·문자 자동 발송은 설정하지 않았다.
관리자는 Supabase Cron 실행 내역과 Edge Function 로그를 확인한다.
다음 SQL은 비밀값 없이 최근 예약 실행을 확인한다.

```sql
select j.jobname, r.status, r.return_message, r.start_time, r.end_time
from cron.job_run_details r join cron.job j using (jobid)
where j.jobname like 'storage-renewal-%'
order by r.start_time desc limit 12;
```

통신 오류가 난 갱신을 즉시 반복하지 않는다. 원격 변수와 배포 상태부터 확인한다.
변수에 새 토큰이 있어도 새 성공 배포가 없으면 후속 검사는 실패한다.
로컬 과거 token/candidate 파일을 그대로 원격에 덮어쓰지 않는다.
갱신 오류를 해결하려고 운영 DB 복원·마이그레이션·계정 재생성을 하지 않는다.

근거: [Supabase 예약 실행](https://supabase.com/docs/guides/functions/schedule-functions),
[HTTP 확장](https://supabase.com/docs/guides/database/extensions/http),
[Railway 변수 API](https://docs.railway.com/integrations/api/manage-variables).
