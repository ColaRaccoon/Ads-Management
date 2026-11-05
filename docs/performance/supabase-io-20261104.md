# Supabase I/O 조사 및 로컬 최적화 — 2026-11-04

> 후속 상태: [실제 배포·정규 실행 측정](supabase-io-deployment-20261104.md)을 참고한다. 아래 원천별 DISTINCT 후보는 운영 병렬 스캔 회귀로 복귀 후 수정됐다. 현재 최종 버전은 날짜 타입·검사 이력 조인만 유지하며, 전체 결과 일치 판정과 디스크 I/O 감소는 확정되지 않았다.

운영 대상 `iygjmosbelbosfxidqxv`와 이 저장소의 연결을 확인했고, 대사 날짜 탐색 SQL을 로컬에서 개선했다. 동일 데이터의 PostgreSQL 결과 대조와 성능 측정을 완료했다. 운영 배포·DB 변경·마이그레이션 적용·스케줄 변경·데이터 정리·사양 변경은 수행하지 않았다. 실제 운영 디스크 I/O 감소는 아직 측정하지 않았다.

## 작업 기준과 연결 확인

- 시작 브랜치: `codex/platform-product-mapping`, HEAD `c610260a693c7ff84ce7525566238794c90731ef`.
- 루트와 부모 경로에 AGENTS.md는 없고, 저장소에는 `apps/web/AGENTS.md`가 있다. README, 제품별 공통 작업규칙, 발행 최신화/최종 결과 문서, 배포·스케줄 문서와 관련 코드를 읽었다. 웹 코드는 수정하지 않았다. README의 과거 테스트 제거 기록보다 현재 존재하는 테스트와 사용자의 회귀 테스트 요청을 기준으로 검증했다.
- 시작 시 기존 수정: `apps/web/src/lib/google-daily-xlsx.ts`, `scripts/cloud/daily-data-sync/production-scheduler.sql`. 기존 미추적 파일: Cafe24/Meta 11월 4일 incident 도구·문서, collection preflight/check 도구, production-request-id repair/regression 도구, `outputs/`. 모두 보존했고 stage/commit/push하지 않았다.
- 로컬 API `.env`를 값 출력 없이 파싱한 결과 `DATABASE_URL`은 Seoul session pooler, port 5432, DB `postgres`, schema `meta_ads`, 사용자명의 프로젝트 suffix는 지정 ref와 일치했다. 로컬 작업 디렉터리라는 이유로 이 DB를 테스트 DB로 취급하지 않았다.
- 운영 Railway 대사 서비스 `ca20108c-9ca1-41c4-a440-556416e18ba3`는 동일 저장소 `ColaRaccoon/Ads-Management`, 동일 브랜치, Dockerfile `deploy/cloud/unified-reconciliation.Dockerfile`을 사용한다. 관측 source commit은 `6a5cc5d144c22325c7873c313cce8ce2916f4cb2`, 최신 deployment `054b5ec7-ef54-43ce-9aa2-4a235b58f7e2`이다. 로컬 변경은 이 배포에 포함되지 않는다.
- Supabase connector의 project/SQL 조회는 권한 오류였다. 기존 보호 credential reader와 기존 관리 API `/database/query/read-only` 경로를 사용한 조회는 `supabase_read_only_user`, HTTP 201로 성공했다. 자격 증명이나 권한을 새로 만들거나 변경하지 않았다. SQL은 통계·카탈로그·작은 스케줄 레지스트리만 읽었다.
- 공개 프로젝트 메타데이터: Seoul, `ACTIVE_HEALTHY`. 운영에 대량 원천 조회, EXPLAIN ANALYZE, 작업 재실행을 하지 않았다. 운영 계정·주문·금액 행이나 비밀값을 출력하지 않았다. 통계의 SQL도 문자열 리터럴을 가린 뒤 확인했다.
- 연결 도구에서 Railway 변수 **이름**은 확인됐으나 값은 OAuth 정책으로 가려져 있다. 따라서 배포된 worker URL 값 자체를 직접 재확인한 것은 아니다. 저장소의 target 검증, 로컬 연결 ref, 동일 운영 DB의 일치하는 SQL/테이블, 동일 Railway source/entrypoint가 연결 근거다.

## 환경·실행·중복 방지

| 환경/작업 | 실행 경로·주기 | 중복 방지와 한계 |
|---|---|---|
| 운영 대사 | Railway project `6fe72710-1fc8-445a-a77f-da2da8fee200`, environment `01ab3d5a-1036-45b0-aa9c-47179339c9be`; 이름은 staging이지만 실제 운영. entrypoint `reconciliation-entrypoint.js --lookback=1 --limit=24 --deadline-seconds=90`, cron `*/5 * * * *`, replica 1, restart NEVER, 공개 HTTP 없음 | scope별 날짜 탐색 1회, 선택한 날짜마다 adapter 사전 읽기. fingerprint+계산 버전이 같으면 재발행하지 않음. 실행 전체의 전역 mutex/singleflight는 없음. 일반 주기보다 deadline이 짧지만 수동/다른 프로세스 중복 탐색 가능성은 남음. 실제 겹침 발생은 확정하지 못함 |
| 운영 집계·발행 | `aggregation.repository.ts`, `aggregation.worker.ts`; 웹 요청의 자동 집계 fallback 없음 | 5분 bucket idempotency key, 파티션 advisory lock, 5분 lease/token, 이전 publication pointer CAS. 실패/이전 정상 발행 보존. 변경이 발견되면 사전 읽기 이후 worker가 다시 읽는 것은 snapshot 검증을 위한 경로이며 이번에 합치지 않음 |
| 운영 수집 | Supabase GMT cron `* 17,18 * * *`, `daily_data_sync_prod_ops` → 보호된 내부 daily-sync 경로 → scheduled-sync/각 provider runner | scheduler advisory lock/attempt 상태, occurrence request key, connection lease+generation, 완료 unit 재사용. 반복 tick은 continuation/retry이며 전부 새 원천 수집으로 해석하면 안 됨 |
| 운영 상품명 교정 | `platform-product-mapping-maintenance.mjs`, `platform-product-corrections-maintenance.mjs`; CLI 운영자 유지보수, 대사 cron과 별도 | plan hash/버전으로 이미 적용된 작업 skip, 파티션·설정 advisory lock, 활성 source worker 검사, 재무 보존 대조, pointer CAS. 매 정시 대사마다 이전 매칭을 복사하는 구조는 아님 |
| 격리 phase08 | 문서상 별도 project `ehnfrrmbkvlsbpvqcvkr`, schema `phase08_meta_ads`, 별도 서비스·보호 경로 | 운영 ref 거부 guard가 있음. 이번에 접속/수정하지 않았고 과거 문서 상태를 현재 활성 상태로 단정하지 않음 |
| 이번 로컬 테스트 | 임시 PG17 cluster를 생성하여 `127.0.0.1` random port에만 bind; 외부 DB URL 미사용 | 고유 임시 디렉터리, 합성 데이터, NOSUPERUSER/NOBYPASSRLS worker, FORCE RLS, 두 개 별도 client의 동시 읽기. 종료 시 server stop |

현재 운영 collection registry 읽기 결과는 stopped=false다. Cafe24 매일 02:00 KST, Google daily 02:01 및 d7 recheck 02:04, Meta daily 02:03, Meta weekly anchor 10/31 02:02는 활성이다. 과거 Google weekly는 paused=true다. daily와 weekly/recheck의 날짜 중첩은 수정·지연 수집을 위한 정책일 수 있으므로 없애지 않았다. 실제 원천 API 재호출량은 이 메타데이터만으로 확정할 수 없다. 기존 미커밋 scheduler SQL과 운영 레지스트리는 구분했다.

주요 변수 이름은 `DATABASE_URL`, `SUPABASE_DATABASE_PROJECT_REF/HOST/SCHEMA/RUNTIME_USER/CONNECTION_MODE/CA_CERT_PATH`, `PRISMA_CONNECTION_LIMIT`, `UNIFIED_RUNTIME_DATABASE_URL`, `UNIFIED_AGGREGATION_DATABASE_URL`, `UNIFIED_PERFORMANCE_ENABLED`, `DAILY_SYNC_FEATURE_ENABLED`, `DAILY_SYNC_SCHEDULE_ENABLED`, `DAILY_SYNC_SCHEDULES`다. worker/report 역할과 엄격한 TLS 구분을 유지했다.

## 운영 관측과 원인별 확신도

비식별 원본 수치: [supabase-io-20261104-evidence.json](supabase-io-20261104-evidence.json). 관측 시각은 JSON의 UTC를 기준으로 하며 첫 통계 조회는 11월 4일 13:37 KST다. 통계 reset은 **11월 3일 14:13:24 KST**다. 호출 횟수는 이 구간의 누적 통계이고 하루 작업 횟수가 아니다.

| 항목 | 재확인 값 | 판단 |
|---|---|---|
| Cafe24 복합 날짜 탐색 | 278 calls, 평균 3,971.18ms, 누적 shared read 84,763 blocks | 운영 hotspot 존재: 높음. 특정 기간 디스크 I/O 비율: 미확정 |
| 쿠팡 날짜 탐색 | 277 calls, 평균 3,748.97ms, shared read 1,328,276 blocks | 동일. 모두 원천 날짜 UNION/DISTINCT 및 날짜별 publication/check 확인 |
| 매칭 복사 | 982 calls, 누적 150,410 rows, 평균 161.76ms, shared dirtied 58,685 blocks | SQL은 두 상품명 교정 스크립트와 일치: 높음. 1.48M 전체 매칭 행/1.76GiB 전체 용량의 단독 원인이라는 주장은 근거 부족 |
| `DELETE FROM order_items WHERE NOT (id = ANY($1::text[]))` | 9 calls, 평균 14,138.11ms, **삭제 0행**, dirtied/written 0 | 목록 외 전역 삭제 검사 비용: 높음. 이 저장소에서 실행 코드 없음. 별도 Naver 원천 시스템 또는 다른 writer의 호출 주체·목록 완전성은 미확인. 추측해서 코드/조건을 수정하지 않음 |
| 매칭 결과 테이블 | total 1,889,738,752 bytes = 약 1.760GiB, heap 1,419,378,688, 전체 index 469,934,080 | unique `(run_id,source_key,name_input_hash)` index 392,323,072 bytes = 약 374.15MiB. 추정 live 1,478,234/dead 2,269이며 autovacuum/autoanalyze 기록 존재. 크기만으로 bloat 단정 불가 |
| DB 용량 | `pg_database_size` 3,201,485,971 bytes | 대시보드 전체 disk/WAL/시스템 용량과 다른 지표. 8GB 전체 디스크 여유와 동일 수치로 보지 않음 |
| 메모리 관련 설정 | shared_buffers 224MiB, effective_cache_size 384MiB, work_mem 2184KiB, max_connections 60, track_io_timing=off | 설정값이며 실제 RAM/RSS나 commitment가 아님. 현재 Nano/RAM 상한, Pro 조직, commitment 경고와 IOPS/throughput 그래프는 직접 재확인하지 못함 |

운영 source/publication/check의 인덱스를 확인했다. 원천에는 날짜 및 일부 connection/date 인덱스가 있고, publication에는 `(platform,scope_key,business_date)`, checks에는 PK `(platform,scope_key,business_date)` 및 oldest-check 인덱스가 이미 있다. 기존 날짜 탐색은 날짜를 text로 바꾼 뒤 비교하고, checks를 날짜마다 scalar subquery로 조회한다. 이 구조가 로컬에서 같은 scope의 검사 이력을 반복 방문하게 되는 것을 재현했다. **코드 구조와 합성 재현의 확신도는 높고, 운영 실행계획·개선폭의 확신도는 중간**이다. 운영의 EXPLAIN ANALYZE는 실행하지 않았다.

block read/hit/dirtied/written 누적 카운터는 물리 디스크 지연/IOPS 비율이 아니다. OS cache 및 비동기 flush를 포함한 한계가 있어, CPU 실행시간 점유율을 실제 I/O 점유율로 바꾸어 해석하지 않았다.

## 적용한 로컬 개선

수정 파일:

1. `apps/api/src/unified-performance/reconciliation.repository.ts`: 각 원천에서 날짜를 먼저 DISTINCT 처리한다. 비네이버 날짜는 PostgreSQL date 타입을 유지하여 기존 publication/check 날짜 인덱스를 활용할 수 있게 한다. checks scalar subquery를 동일 unique key의 LEFT JOIN으로 변경한다.
2. `apps/api/src/unified-performance/reconciliation.test.ts`: 변경된 SQL projection에 맞춰 소유권 검증을 유지한다.
3. `scripts/supabase-io-postgres.test.ts`: 실제 격리 PG17 회귀·동시 조회·성능 비교. `scripts/fixtures/reconciliation-date-baseline.ts`는 수정 전 SQL의 동결본이다.
4. `scripts/supabase-io-{readonly,detail-readonly,schedule-readonly}.sql`: 통계·인덱스·스케줄의 비식별 읽기 전용 확인 쿼리. 재사용 시 고정 운영 target과 조회 권한을 다시 확인한다.
5. 이 문서와 evidence JSON.

최근/과거 날짜별 한도·정렬, publication만 남은 삭제 날짜, API의 검증된 0행 날짜, validation/current/connection/CSV ownership 조건은 동일하다. publication이 같은 날짜에 여러 source_system을 가질 수 있어, publication은 JOIN으로 증식시키지 않고 EXISTS를 유지했다. Naver JSON 날짜는 잘못된 달력 문자열이 있을 수 있어 date cast를 하지 않는다. 기존 날짜 문자열 필터와 상위 후보 검증을 유지했다.

증분 watermark만 쓰면 과거 수정·삭제·금액/원가/이름 규칙 변경을 놓칠 수 있어 도입하지 않았다. 캐시도 도입하지 않았다. 실행 간 무효화 상태나 stale 결과는 새로 생기지 않는다. scope 간 Cafe24/Meta/Google 원천 중첩은 보고 의미가 달라 임의로 통합하지 않았다. 인덱스는 새로 추가하지 않아 추가 저장/쓰기 비용이 없다.

매칭 결과는 개별 source-line의 이름 분류·규칙·금액 근거를 run에 귀속시킨 감사 자료다. 교정 스크립트의 복사를 제거하면 새 run의 근거가 빠지고 이전 run에 대한 숨은 의존성이 생긴다. 안전하게 쓰기를 줄이려면 별도 immutable evidence set 및 run reference, reader/감사 조회·삭제 방지·권한·복구 계약까지 바꿔야 한다. 이번에는 근거 없는 중복 제거/보존기간 삭제를 하지 않았다. 이미 적용된 plan의 skip도 유지했다. 날짜 탐색 자체는 수정 전후 모두 읽기 전용이다.

DELETE는 전역 목록 동기화로 보이지만 caller를 찾지 못했다. 실행 주체가 확인되면 빈 목록이 전체 삭제를 의미하는지, 목록이 전체 스토어를 포함하는지, NULL id 가능성, 트랜잭션 snapshot/동시 삽입을 먼저 검증해야 한다. 단순히 store 조건이나 청크를 추가하면 삭제 의미가 달라질 수 있다. `NOT ANY`의 NULL/빈 배열 의미를 보존하는 anti-join/temp relation 비교는 해당 저장소에서 별도 수행해야 한다.

## 결과 일치·측정

격리 PG17의 동일 데이터/통계/역할/인덱스/`work_mem=2184kB`에서 before/after를 비교했다. 각 native source table에 합성 48,000행, 2,400일, 5개 플랫폼의 publication/check 이력을 넣었다. fixture 최소 스키마는 운영 전체 스키마의 복제가 아니다. Naver 측정은 작은 JSON 원천과 긴 publication/check 이력을 사용하므로 native 48,000행 fixture와 데이터 분포가 다르다. warm-cache 3회 중앙값이며 운영 예상 시간으로 해석하면 안 된다.

| 플랫폼 | 실행 ms 전→후 | shared buffer hit 전→후 | scan 노드 검사행 전→후 | 반환행 / 쿼리 호출 / 변경행 |
|---|---:|---:|---:|---|
| Cafe24 | 927.627 → 131.464 | 65,935 → 1,027 | 11,705,498 → 163,893 | 26→26 / 1→1 / 0→0 |
| 쿠팡 | 871.339 → 98.453 | 99,588 → 1,065 | 11,700,467 → 163,663 | 26→26 / 1→1 / 0→0 |
| Naver | 2326.577 → 6.300 | 239,609 → 86 | 37,536,230 → 19,392 | 26→26 / 1→1 / 0→0 |

scan 검사행은 각 scan 노드의 `(Actual Rows + Rows Removed by Filter) × Actual Loops` 합이다. 중간 CTE scan도 포함하므로 물리적으로 고유한 원천 행 수가 아니다. 양쪽 shared read/temp write는 모두 0이다. 최대 단일 plan 노드 memory는 Cafe24·쿠팡 1537→1537KiB, Naver 97→133KiB였다. 전체 backend/app RSS는 측정하지 않았고, memory가 항상 감소했다고 주장하지 않는다. 쿼리 호출 횟수나 매칭 쓰기 행 수를 줄인 변경도 아니다. 감소가 확인된 것은 **로컬 날짜 탐색의 반복 검사·버퍼 접근·실행시간**이다.

검증:

- PostgreSQL 별도 테스트 6개 PASS: 빈 입력, 중복, 잘못된 JSON 날짜, 미래 날짜, CSV/API scope/소유권, COMPLETE_ZERO 증명, 여러 source_system의 동일 날짜, publication-only 삭제일, 지연 도착, 날짜 정정, 취소/삭제, UTC/Seoul/LA 세션 날짜 경계, 두 client 동시 조회, 재시도 후 새 데이터 관측, 전후 SQL 결과 및 버퍼 접근 비교. 제한된 worker 역할과 FORCE RLS로 조회했다.
- 통합 성과측정 기존 테스트: 392개 중 **391 PASS, 1 SKIP, 0 FAIL**. skip은 기존 `UNIFIED_DAILY_PRODUCTS_BENCHMARK=true` 선택 실행 벤치마크다. 원천 금액/수량 보존, fingerprint, 계산 버전, 기존 발행 보존, permission/lease/retry 회귀를 포함한다.
- workspace `npm.cmd run lint` PASS, `npm.cmd run prisma:validate` PASS, API build PASS, `git diff --check` PASS. 웹 production build는 변경 범위에 없어 실행하지 않았다.

재현 명령(PowerShell):

```powershell
$env:TSX_TSCONFIG_PATH='apps/api/tsconfig.json'
node --import tsx --test scripts/supabase-io-postgres.test.ts
$ioTests = @(rg --files apps/api/src/unified-performance | Where-Object { $_ -match '\.test\.ts$' })
node --import tsx --test @ioTests
npm.cmd run lint
npm.cmd run prisma:validate
npm.cmd --workspace @meta-ads-performance/api run build
```

로컬 PG 도구는 기존 `%LOCALAPPDATA%/UnifiedPerformanceStage02/node_modules`의 `pg` 및 `@embedded-postgres/windows-x64`를 사용한다. 없으면 테스트는 실패하며 운영 DB로 fallback하지 않는다. 임시 PG 디렉터리는 증거 보존을 위해 남기고 서버는 종료한다.

## 적용·관측·롤백과 남은 과제

1. 이번 파일만 검토하고 별도 승인을 받은 뒤, 기존 개발 변경과 분리하여 릴리스를 준비한다. 현 브랜치는 실제 운영 cron source에 연결되어 있어 push만으로 배포가 발생할 가능성을 고려해야 한다. 이번에는 commit/push/deploy하지 않았다.
2. 승인이 나면 대사 서비스 이미지에 SQL 변경을 포함해 배포한다. 새 migration, 새 인덱스, 새 변수, 스케줄 변경은 필요 없다. 이전 deployment/source와 현재 feature flag·command를 보관한다.
3. 정상 cron 관측으로 결과·실패/timeout·게시 최신성을 확인한다. 통계를 reset하지 말고 시각 및 queryid별 calls/rows/blocks/실행시간 **차분**을 기록한다. 변경 후 query shape/queryid가 바뀌므로 기존 누적 평균과 직접 비율 비교하지 않는다. 실제 IOPS/throughput과 데이터 규모·호출량을 함께 비교해야 운영 I/O 감소를 말할 수 있다.
4. 문제 발생 시 직전 대사 이미지/commit을 재배포한다. DB 구조/원천/기존 발행은 이번에 바꾸지 않았으므로 데이터 rollback은 필요 없다. 로컬 복구는 이번 두 API 파일의 diff만 역적용하며 사용자 기존 변경을 되돌리지 않는다.
5. 장기간 전체 날짜 원천 탐색은 여전히 남는다. 증분화는 모든 수집·수정·취소·삭제·규칙 변경 writer가 영향을 받은 business-date를 정확히 남기는 계약이 갖춰진 뒤 검토한다. 실행 내 재사용은 동일 snapshot·권한·scope에 한정해야 한다.
6. 감사 evidence 공유 설계와 외부 Naver DELETE caller 확인은 미해결이다. 이번 변경으로 1.76GiB 테이블이나 기존 중복 저장량이 줄지는 않는다. 보존기간/정리 정책은 별도 승인과 복구 증거가 필요하다.
7. Nano→Micro는 코드 최적화와 별도 용량 결정이다. 사용자가 관측한 0.5GB Nano/commitment 경고를 실제 RAM 사용량으로 간주하지 않는다. 현재 컴퓨트/조직·요금·일시 중단 시간은 이번 조회로 재검증하지 못했다. 적용 전 대시보드의 실제 요금 견적, compute credit/무료 전환 조건, 재시작·연결 중단, 백업/복구 조건을 다시 확인하고 승인받아야 한다.

기술 참고: Supabase [Query Optimization](https://supabase.com/docs/guides/database/query-optimization), [Database inspection/EXPLAIN](https://supabase.com/docs/guides/database/inspect). 이번 EXPLAIN ANALYZE는 합성 로컬 DB에서만 사용했다.
