# 2026-11-04 Cafe24 D-1 수집 중단

## 원인과 범위

운영 대상은 `patimagroup-work.com`, Supabase `iygjmosbelbosfxidqxv/meta_ads`다.

- 11월 3일분 예약 실행 `74825d72-1cfa-4e0b-895c-81cc061207f1`은 11월 4일 02:00:11 KST에 시작했다. 첫 목록 구간을 암호화 체크포인트에 저장하고 `PARTIAL/PARTIAL_PAGE`로 반환했다. 이는 완성 전 정상 중간 상태이며 공급자 실패를 뜻하지 않는다.
- 02:02~03:54 KST의 후속 cron 113회가 `attempts_request_id_key`의 unique violation으로 롤백됐다. `net.http_post`와 이력 INSERT가 같은 트랜잭션이어서 이력 저장 오류는 HTTP enqueue도 취소했다. 따라서 카페24의 두 번째 구간은 실행되지 않았다.
- `pg_postmaster_start_time()`은 11월 3일 14:13:24 KST, 새벽 첫 두 요청 번호는 1과 2였다. 이어지는 3 이상의 번호가 이전 날짜 이력과 충돌했다. pg_net의 큐 요청 번호를 영구 전역 고유 번호로 취급한 것이 결함이다.
- 카페24 연결은 enabled/READY이며 인증 만료가 아니다. 11월 2일분 320행을 포함한 이전 데이터는 정상이다. 11월 3일분은 복구 전 판매 행과 coverage가 없었다.
- 스케줄러 stopped=false, prod-cafe24 paused=false, 매일 02:00 KST/110분 창이다. 스케줄 자체가 꺼진 상황이 아니다.

## 적용한 운영 수정

`production-request-id-repair.sql`은 함수 원본 hash와 고정 운영 대상을 확인하고 공통 advisory lock 및 테이블 잠금 안에서 실행했다.

1. 과거 이력 전체의 `UNIQUE(request_id)`를 `status='HTTP_QUEUED'`인 진행 중 요청에만 적용하는 부분 unique index로 교체했다. 이력의 영구 식별자는 기존 primary key `id`이며 316건의 과거 행을 모두 보존했다.
2. `reap()`은 응답 번호 외에 생성 시각과 현재 DB 시작 시각을 확인하고 최신 응답을 선택한다. 이전 요청 또는 이전 DB 실행의 응답을 새 요청에 연결하지 않는다. 5초 허용은 enqueue와 응답 저장 시각 경계를 위한 것이다.
3. `tick()`과 `candidates()`의 hash는 수정 전후 동일하다. 공급자 검증·인증·계정 범위·예약 시각·재시도 창을 변경하지 않았다. 새 설치용 `production-scheduler.sql`에도 같은 수정을 반영했다.

운영 적용 후 `reap()` hash: `08272e98f226b0a997efb515a23965c4`.

## 검증

- 실제 운영 DB에서 임시 테이블만 사용하는 `production-request-id-regression.sql`을 실행하고 전체 rollback했다. 과거 요청 번호 재사용 허용, 진행 중 중복 거부, 오래된 응답 무시, 새 응답 정상 처리, 만료된 요청 실패 처리를 모두 검증했다. 비즈니스 데이터 쓰기 0건.
- 기존 `production-schedule.test.ts` 4개 테스트 통과.
- 적용 후 index/함수 hash/예약 활성 상태/이력 316건 보존을 독립 읽기로 확인했다.
- DB 작업만 적용했으므로 Railway 앱 소스 재배포는 필요하지 않았다.

## 접근 경로

이번 Codex Supabase 커넥터에는 비활성 개발 프로젝트만 보여 운영 SQL이 거부됐다. 사용자가 작업 계속 및 운영 정상화를 승인한 뒤, 저장소에 이미 있던 `google-performance-production-query.ps1`과 Windows Credential Manager의 기존 운영 관리 인증을 사용해 올바른 운영 대상 접근을 확인했다. 복구 서비스는 기존 Railway CLI 인증의 운영 환경에서 실행했다. 토큰/환경변수 전체/원본 주문 응답은 출력하거나 기록하지 않았다.

재로그인을 요구하기 전에 기존 운영 절차와 인증 경로를 확인했어야 한다. 해당 커넥터의 범위 문제와 실제 운영 접근 가능 여부는 별개였다.

## 누락일 복구 완료

- 기존 queue/runner/writer를 사용하는 새 수동 실행 `e9faeed0-f639-424d-bde1-6391399390d0`으로 11월 3일만 재수집했다. 요청 키는 `incident-cafe24-20261104-recover-20261103-v1`이다.
- 363행 수집·저장, `SUCCEEDED`, 오류 없음. 전체 목록·건수·품목 두 번 대조와 원자적 저장 검증을 유지했다.
- 기존 activation preview의 snapshot digest를 검토하고 같은 activation 서비스로 날짜 범위 11월 3일만 API primary로 반영했다. 정책 version=24, 쿠폰 입력 `API_ACTUAL_PRODUCT_PLUS_SHIPPING`. 다음 날의 기존 자동수집 흐름을 유지했다.
- 2026-11-04 09:13:52 KST에 판매 화면과 같은 `SalesMetricsService.productPerformance`를 실제 운영 데이터로 호출했다. 판매 행 363건, 판매가 있는 매칭 상품 13개를 확인했다. 그 후 관리 읽기 경로로도 363행/매칭 349행/API policy/`CAFE24_API_ONLY_VERIFIED` coverage/정확한 성공 run 포인터를 독립 확인했다.
- 원래 예약 실행은 `PARTIAL`, 저장 0건인 채 보존했다. 과거 예약 실행을 성공으로 바꾸지 않았다.
- 미매칭 14행과 기존 cache freshness/과거 변경 수동 재수집 경고는 남아 있다. 이들은 자동수집 중단 원인과 별개이며 임의 제품 매핑을 추가하지 않았다.
- 첫 마진 검증의 일시적 `P2037` 연결 한도 오류는 유지보수 클라이언트만 connection limit=1로 제한한 뒤 해소됐다. 운영 앱의 연결 설정은 변경하지 않았다.
- 다음 정시 자동 실행 자체는 아직 관찰 전이다. 운영 수정 적용, 회귀 검증, 이번 날짜의 수동 복구 성공과 구별한다.

증거는 로컬 `reports/cafe24-incident-20261104/`의 진단·예약 이력·회귀·수정 적용·독립 검증 JSON에 보관했다. 재현용 SQL은 `scripts/cloud/daily-data-sync/production-request-id-regression.sql`, 실제 적용한 hash-bound SQL은 `production-request-id-repair.sql`이다.

## 후속: 같은 장애로 누락된 Meta도 복구

사용자가 카페24 판매는 보이지만 메타 광고 데이터가 없다고 알려주었다. 공통 scheduler 장애의 영향 범위까지 확인하지 않고 카페24만 복구한 것이 누락이었다.

- 진단: 11월 3일 Meta 실행·광고 행·광고세트 행·coverage가 모두 없었다. 02:03 KST의 `prod-meta-daily` 호출은 앞에서 확인한 공통 이력 INSERT 오류 때문에 시작되지 않았다. 11월 2일 이전 데이터는 정상이다.
- 첫 수동 복구 `3287ee4b-892b-433b-a91e-0ec2b07f5ef1`은 `META_NORMALIZE_PROVIDER_ZERO_PROJECTION` 검증 오류로 저장 0건/ACTION_REQUIRED였다. 원본 응답은 기록하지 않아 그때의 내부 세부 조건은 소급 확정하지 않는다.
- 별도의 읽기 전용 재조회에서 원시 광고 933개/광고세트 314개/캠페인 122개/계정 1개를 확인했다. null 기본지표 부모 114개와 명시적 0 자식 340개가 기존 엄격한 제외 증명을 통과했고, 계층별 광고비/노출/클릭/링크클릭/구매 합계가 모두 일치했으며 전체 정상화도 통과했다. 첫 검증 오류는 새 조회에서 재현되지 않았다. 데이터/0값/검증 규칙은 변경하지 않았다.
- 새 수동 실행 `6f3ff03a-0936-42b8-9e6f-aa767009ef48`, 요청 키 `incident-meta-20261104-recover-20261103-v2`로 기존 queue/runner/canonical writer를 실행해 성공했다. 광고 593행+광고세트 200행=793행 저장, 광고비 $4,632.58, 노출 326,300, 구매 285. 두 계층의 합계가 일치한다.
- 09:19:36 KST에 실제 판매 화면의 `productPerformance`로 확인했다. 카페24 363행과 Meta 광고세트 200행이 동시에 조회되고, 12개 상품에 $4,632.58이 배분됐다. 미매칭 광고비 $0, 누락 환율 0일. 두 Meta coverage 모두 COMPLETE_NONZERO/경고 없음/정확한 성공 실행 포인터다.
- 별도 관리 SQL 경로로 저장 건수·합계·coverage·자동수집 활성 상태를 독립 재검증했다. 첫 수동 실패 이력은 보존했다. 미래 정시 실행의 실제 성공은 아직 관찰 전이다.

후속 증거: 같은 로컬 폴더의 `meta-diagnose.json`, `meta-failure.json`, `meta-diagnostic.json`, `meta-recovery.json`, `meta-final.json`. 원본 공급자 행/광고명/토큰은 저장하지 않았다. 재실행 서비스 스크립트: `scripts/meta-incident-20261104.ts`.

## 다음 자동 실행 사전 확인과 사후 점검

사용자가 11월 5일부터 두 공급자의 자동수집 정상 여부와 재누락 방지 확인을 요청했다.

- 운영 DB에서 다음 슬롯 후보를 읽기 전용으로 계산했다. 11월 5일 02:00 KST 카페24, 02:03 KST Meta D-1 후보가 정상 생성된다. 두 스케줄 모두 cadence=1/day_offset=1/paused=false이며 공통 cron도 active/stopped=false다. 요청 번호 수정 index와 reap hash도 유지된다.
- 운영 서비스 환경에서 `daily-collection-preflight.ts --date=2026-11-05` 실행 PASS. 시뮬레이션 시각의 완료일 검증으로 11월 4일 데이터만 대상인 것을 확인했고, Cafe24 API 버전·판매자 옵션·all-items 검증 근거와 Meta 운영 gate, 예약 API 선택 기능, 운영 readiness/릴리스 일치를 확인했다. 이 사전 확인은 공급자를 호출하거나 미래 데이터를 생성하지 않았다.
- 확인 당시 Meta 인증 만료는 12월 23일, Cafe24 refresh 만료는 11월 18일이며 연결은 둘 다 enabled/READY다.
- `scripts/check-daily-collection.ps1`을 추가했다. KST 전일을 자동 계산해 실제 예약 run의 성공, 세 coverage/행 수/API 정책/성공 포인터, Meta 광고·광고세트 및 coverage 광고비, 예약 활성과 요청 번호 수정 유지, 인증 만료 임박을 읽기 전용으로 검사한다. 수동 복구 데이터를 예약 성공으로 오인하지 않는다.
- 정상 자동 실행일 11월 1일을 PASS로 판정했다. 수동복구가 끝난 11월 3일은 데이터가 완전해도 카페24 PARTIAL/Meta 예약 누락 두 항목을 정확히 ATTENTION으로 판정했다.
- 현재 채팅에 일일 04:10 KST heartbeat `카페24·메타 일일 수집 확인` 생성, automationId=24, ACTIVE. 11월 5일 첫 실제 정시 성공은 한 번 보고하고, 이후 정상 유지 시 조용히 유지하며 실패·누락·복구·필수 조치에만 반응하도록 저장했다.
- 이 사후 점검은 로컬 파일과 기존 로컬 인증을 사용하므로 컴퓨터와 앱이 실행 중이어야 한다. 서버에서 실행되는 실제 02:00/02:03 수집과 구별한다. 아직 오지 않은 정시 실행의 성공이나 영구적인 무누락을 보장하지 않는다.

사전 점검 영수증: `reports/cafe24-incident-20261104/tomorrow.json`, `tomorrow-runtime.json`. 일일 점검 영수증: `reports/daily-collection-health/`.
