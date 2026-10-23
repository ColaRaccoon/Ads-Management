# 운영 Storage 토큰 자동 갱신

## 2026-10-08 갱신 배포 장애 수정

운영 Edge Function 버전 4에 반영했다. 토큰 교체는 `skipDeploys:true`로 저장하고,
기존 활성 배포를 `deploymentRedeploy(usePreviousImageTag:true)`로 실행한다.
변수 자동 배포가 변경 없는 소스를 매번 재빌드하면서 Debian 패키지 버전 폐기에 막히는
문제를 피하고, 동일 이미지에 새 인증정보를 적용한다. 활성 배포가 없거나 배포 진행 중이면
토큰 변경 전에 실패한다. 결과가 불명확한 쓰기·배포 요청은 자동 반복하지 않는다.
후속 readiness 검사는 새 토큰 발급 이후의 성공 배포를 계속 요구한다.

실제 `renew-now` → 이미지 재사용 배포 SUCCESS → `check` HEALTHY 및 보호 readiness 200을
검증했다. 인증 없는 함수 호출은 403이다. 예약 시각과 보호 secret은 유지했다.
추가 검증: `node --test scripts/cloud/storage-renewal/railway-deployment.test.mjs`.

2026-09-14 적용·첫 갱신 검증 완료. PC가 꺼져 있어도 Supabase에서 실행한다.
앱의 권한·서명키·Storage subject를 유지한다. 업무 데이터는 변경하지 않는다.

## 현재 실행

- Supabase `iygjmosbelbosfxidqxv`, Edge Function `storage-renewal` 버전 4 / ACTIVE (2026-10-08).
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

### 절전 복귀 대응 (2026-09-16 소스 변경, 별도 Edge 배포 필요)

- 현재 토큰 발급 시각 이후 생성된 활성 배포의 `SUCCESS` 또는 `SLEEPING` 상태를 확인한 뒤
  readiness를 요청한다. 잠든 배포도 깨울 수 있지만 과거 토큰의 배포나 실패·배포 중 상태는 통과하지 못한다.
  상태 정의는 [Railway 배포 API 문서](https://docs.railway.com/integrations/api/manage-deployments)를 따른다.
- 보호된 앱 readiness GET에만 최대 3회, 회당 최대 20초, 2초 간격으로 재시도한다.
  readiness 전체 상한은 35초이며, 함수 시작부터 80초가 지나면 추가 요청을 중단한다.
  기존 Cron HTTP 제한 90초 안에 응답할 여유를 두며 앞선 JWKS/Storage/Railway 호출도 같은 남은 예산을 사용한다.
- 네트워크 오류·요청 시간 초과·게이트웨이 502/503만 재시도한다. 앱이 반환한 구조화된 오류
  (`SERVICE_NOT_READY` 포함), 401/403, 리다이렉트, 잘못된 200 응답은 즉시 실패한다.
  실제 DB/인증 공급자/Storage 장애 및 만료 자격증명으로 발생한 앱 503을 숨기지 않는다.
- 토큰 검증, 대상 검사, Storage sentinel, 갱신 mutation에는 재시도를 추가하지 않는다.
  만료 토큰은 기존대로 점검 실패이며, 갱신 경로의 제한된 교체 동작은 유지한다.
- `node --test scripts/cloud/storage-renewal/core.test.mjs scripts/cloud/storage-renewal/readiness.test.mjs`
  로 기존 갱신 안전성 및 복귀 재시도 경계를 함께 검사한다.
- 운영 반영 시 `index.ts`, `core.mjs`, `readiness.mjs`를 포함해 기존 Edge 함수를 배포해야 한다.
  보호 secret·Cron 일정은 유지하고 `cron.sql`을 다시 실행하지 않는다.
  배포 후 인증 거부와 실제 수면 상태에서 `check` 성공을 별도로 관측해야 한다.
  이 변경은 첫 HTML 문서 요청의 502를 해결하거나 콜드 스타트 성공을 보장하지 않는다.

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


## 2026-10-23 진단 전용 변경안 — 로컬 준비, 운영 미배포

운영 version4는 실패 예외를 폐기한다. `safe-diagnostics.mjs`와 `index.ts`의 로컬 변경은 고정 단계/Railway 작업/숫자HTTP status/허용 GraphQL code만 기존 실패 marker에 기록한다. 예외 원문·응답본문·query·variables·headers·token은 기록하지 않는다. 공개403/400/503·기존 인증/갱신 동작은 유지한다.

검토 기준은 `docs/daily-data-automation/records/11_환경이동_인계_20261023/storage-diagnostics-change.review.json`과 준비서12절이다. 새 개인정보 보호 테스트5개와 구문 검사는 통과했지만 운영 함수는 아직 바꾸지 않았다. 별도 배포 승인 후에는 `index.ts`, `core.mjs`, `readiness.mjs`, `railway-deployment.mjs`, **`safe-diagnostics.mjs`까지5개**를 모두 포함해야 한다. 기존 secret/job/시각/verify_jwt와별도Bearer 검사도 보존한다.

지금 수동 renew/check·refresh/발급/폐기·과거 Deploy/Role/Refresh helper를 실행하지 않는다. 진단 배포가 승인되면 다음 기존 정시 실행 로그로 원인/회복을 확인하고 입증된 수리만 별도 제안한다. 제품 배포는 다른 승인 범위다.
