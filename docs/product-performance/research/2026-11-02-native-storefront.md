# 자사몰 채널 분리와 native 계산 일치

2026-11-02. 작업 브랜치 `codex/performance-speedup`, 시작점 `621239e`. 구현·독립 검토·실데이터 읽기 검증 통과, 운영 발행/화면 검증은 아래 후속 기록으로 확정한다.

## 원인과 확인한 금액

11/1 native Meta 상품 마진은 매출 12,545,080원, 원가 4,915,808원, 쿠폰 19,000원, 광고비 5,067,824.031원, 최종 이익 2,542,447.969원이다. native Google은 매출 521,800원, 원가 203,080원, 쿠폰 1,000원, 광고비 446,889.026713원, 이익 -129,169.026713원이다. 해당 날짜 YouTube 17행은 기존 Meta 상품 매칭에서 제외돼 실제 중복 판매는 없었다.

기존 통합 집계는 별도 이름/판매단위/원가 매칭과 오래된 Google SALE 설정을 사용했다. 원가를 계산하지 못한 일부 상품 이익이 제외된 광고 전 이익 6,683,373원에서 양쪽 광고비를 차감해 1,168,659.942287원을 표시했다. 이는 단순히 Google 광고비 차감만의 차이가 아니다.

새 native 판매 결과 합계는 매출 13,066,880원, 광고 전 이익 7,927,992원, 광고비 5,514,713.057713원, 이익 2,413,278.942287원이다. Meta/Google 상품 30건의 광고비 및 최종 이익을 각각 대조해 차액 0을 확인했다. Google 캠페인 4개 상품의 통합 이름 귀속 차이도 native 캠페인 matcher를 재사용해 수정했다. 원천 광고금액·FX·전체 광고비는 변하지 않는다.

## 저장·조회 계약

- 기존 worker만 native Meta/Google 판매 계산을 실행한다. 전체 주문 쿠폰을 먼저 처리하며, 혼합 채널 주문만 공유한 한 번의 제품→행 배분 원장을 사용한다. 단일 Meta 주문의 기존 미매칭 쿠폰 정책은 보존한다. 기존 HTTP 계산 경로의 기본 동작은 유지한다.
- 기존 source/day 원장·대조 합계와 함께 `STOREFRONT_RESULT`를 같은 불변 run과 원자적 publication에 저장한다. native 매출/광고 전 이익/최종 이익/포함 광고비를 저장한다. 새 버전이 있는 파티션의 이전 SALE만 조회에서 교체한다. 기존 사실·발행 이력은 삭제하지 않는다.
- 최종 이익은 선택된 저장 광고비를 한 번만 차감한다. 저장 시점 native 최종 이익도 감사값으로 남기지만, 광고비만 갱신되거나 조회 계정/매체가 달라졌을 때 오래된 최종값을 그대로 쓰지 않는다. GET은 주문·원가·쿠폰을 재조회하거나 계산하지 않고 저장 집계의 합계/차감/비율만 수행한다.
- 0원/미수집/미확정/음수는 분리한다. 두 채널의 비금전적 마커는 SQL 상품 필터를 통과하며 금액 0을 만들지 않는다. 여러 자사몰에 광고 계정의 소유 근거가 없으면 native 광고 감사값만 미확정으로 두고 계정별 판매 결과는 유지한다.
- `unified-report-v2-native-storefront`와 native 의존성 fingerprint로 재발행한다. 상품/원가/쿠폰/광고 설정 변경이 갱신을 유발한다.
- 데일리는 자사몰(메타), 자사몰(유튜브), 네이버, 쿠팡을 표시한다. 기존 변화 분석의 표·차트·CSV도 새 키를 사용한다. 이전 발행본은 별도 자사몰 키로 유지하고 혼합 범위의 증감을 만들지 않는다.

## DB와 권한

`20261102071000_native_storefront_results`는 기존 `unified_fact_valid` CHECK에 한 종류만 추가한다. 원래 attribution/key/JSON 검증과 immutable/RLS는 유지한다. 운영 CHECK 원문을 읽고 md5 `a6953af049a1cef48375d5ee265a2de5`를 실행 전 조건으로 고정했다. migration SHA256는 `1967771fe0506cbbf3677045adbed2f928a5f1af2a868125eddaab7ef5e06b3b`이다.

기존 제한 worker 역할에 필요한 세 business matching 열만 SELECT 추가했다: products.name, meta_adset_daily_metrics.product_id, cafe24_order_lines.row_number. 전체 테이블, source DML, 개인정보·자격 증명, report 역할의 원천 접근은 추가하지 않았다. 기존 보호된 관리 API 경로에서 고정 SQL/hash를 적용하고 임시 소유자 membership은 같은 트랜잭션 안에서 정확히 복원했다. 실제 worker/report 역할의 허용·거부 검증을 통과했다.

## 검증과 병렬 검토

- data 에이전트: native producer/쿠폰 원장/제한 projection/실제 PostgreSQL 게시 검증.
- ui 에이전트: 데일리/변화 분석 UI, native Google 광고 매핑, 독립 통합 회귀.
- review 에이전트: 수정 없이 평가만 수행. 상품 필터·마커·관계 분석·구글 누락·쿠폰 보존·DB CHECK·기존 비교 화면·권한을 검토했다.
- API 통합 모듈 310개 테스트 통과. 전체 웹 통합 성과 테스트 91개 통과. native/Google/공유 쿠폰 추가 회귀 및 API 빌드, 웹 38페이지 빌드, 소스 보호 guard 10개 통과.
- 새로운 격리 PostgreSQL 17에서 전체 migration, 실제 non-owner enqueue/claim/stageAndPublish, native 금액 변조 거부, duplicate/잘못된 CHECK 값 거부, 기존·신규 published 불변성 및 FORCE RLS를 확인했다. 운영 원천 쓰기는 없다.
- 실제 운영 읽기 probe는 서로 다른 native/runtime 역할의 READ ONLY RepeatableRead 시점을 분리 기록한다. 개인/주문/제품 식별자와 비밀값을 출력하지 않는다.

증거: [금액 대조](2026-11-02-native-storefront-parity.json), [격리 PostgreSQL](2026-11-02-native-results-postgres.json), [실제 역할 검증](11-runtime-role-check.json), [세 열 권한](11-role-native-result.json), [운영 migration](11-native-component-migration.json).

## 운영 배포와 후속 확인

구현 커밋 `1a8b00d`를 원격 `codex/performance-speedup`에 올리고 웹과 비공개 reconciliation worker에 배포했다. 첫 웹 실행은 `RELEASE_GIT_SHA`가 이미지 SHA와 달라 시작 검사에서 거부됐다(`4d3c0f91-f4fa-46f3-9f30-76c6a97621a8`). 검사를 끄지 않고 설정을 정확한 SHA로 맞춰 재배포했고 `add7a638-9291-4790-897d-0a5eb0d61f5a`가 성공했다.

11/1과 10/31 저장 집계를 갱신한 실제 운영 관리자 화면에서 자사몰(메타) 이익 2,542,448원, 자사몰(유튜브) 이익 -129,169원, 전체 이익 5,978,555원을 확인했다. 전체 매출은 35,550,970원, 광고비는 12,069,169원이다. 네이버 이익 999,104원과 쿠팡 이익 2,566,173원도 유지된다. 같은 11/1 보고서의 실제 브라우저 인쇄 미리보기에서 PDF 1페이지를 확인했다(물리 인쇄는 실행하지 않음).

화면 확인 중 합성된 미수집 LEGACY_UNBOUND coverage가 빈 `자사몰(이전집계)` 행을 만드는 것을 발견했다. `b5526db`는 새 채널 집계가 있고 실제 이전 SALE/확인된 0원이 없는 경우에만 그 빈 행을 숨긴다. 실제 legacy 부분금액과 확인된 0원은 유지하고 coverage 누락 상태·총액은 바꾸지 않는다. 추가 회귀 3건, 관련 54개 테스트, 독립 검토 45개 테스트와 API 빌드가 통과했다. 최종 배포/갱신 결과는 아래에 기록한다.

source 원본과 과거 immutable 발행본은 보존한다. 앱 롤백은 새 컴포넌트를 이해하지 않는 이전 코드도 기존 원장을 읽을 수 있지만, 수정 전 금액으로 돌아가므로 코드·worker를 함께 추적한다.

최종 운영 코드 SHA는 `b5526dbe70db2d8bb79fa8f2a3e87b088527b24d`다. 웹 deployment `7529150b-286f-4aa5-b697-a595436487e8`, private worker `20d6a532-8a2a-467c-8fd4-d7b44255ce40` 모두 SUCCESS, 기존 `asia-southeast1-eqsg3a`에서 실행한다. 소스는 정확한 커밋으로 pin돼 문서/보수 도구 후속 커밋은 자동 배포되지 않는다. 실제 운영 페이지를 새로고침해 빈 이전집계 행이 사라지고 네 판매처의 금액이 유지됨을 확인했다.

최종 화면 증거: `C:/Users/seong/.codex/visualizations/2026/10/30/product-performance-production/daily-2026-11-01-native-storefront.png`. 원본 관리자/보고서 화면을 로컬에만 저장했으며 비식별 집계 검증은 저장소의 JSON 증거를 사용한다.

최근 15일(10/18~11/1) 재발행은 368.815초에 88건을 조사·enqueue했고 87건 게시, 1건 실패였다. 실패한 COUPANG 10/20은 `SOURCE_EXECUTION_FAILED`로 이전 정상 게시를 보존했다. 같은 날짜 read-only 진단은 READY였고, 제한 역할·최근 FAILED·허용 scope를 검사하는 단건 retry를 독립 검토 후 실행해 해당 날짜만 revision 4, 새 계산 버전으로 게시했다. 결과적으로 대상 88건을 모두 갱신했다. 최초 원인의 상세 예외는 보존되지 않아 일시적 조회 오류로 추정할 뿐 timeout으로 확정하지 않는다.

보수 도구 `unified-reconcile-current.ts`에 읽기 전용 실패 metadata 조회와 명시 UUID 한 건 재시도 옵션을 추가했다. 재시도는 원천 쓰기 없이 기존 enqueue/runOne/원자적 publication을 사용하고 다른 queue를 drain하지 않는다. 재실행 key는 실패 job 기반으로 고정한다. 보호 wrapper 실제 실행과 독립 검토를 통과했다.

최종 운영 저장값의 read-only 대조에서 자사몰 전체 매출 13,066,880원·광고 전 이익 7,927,992원·최종 이익 2,413,278.942287원을 확인했다. `publishedProductParity`는 실제 저장된 사실을 읽은 상품 30건의 광고비/순이익 차액이 모두 0이다. 기존 `adProductParity`는 재계산 결과 대조이며 두 검증을 구분한다. 증거: [최근 재발행](2026-11-02-native-reconciliation.json), [실패 1건 복구](2026-11-02-native-reconciliation-retry.json), [게시 후 상품별 대조](2026-11-02-native-storefront-published-parity.json).

최종 배포 worker의 실제 실행 `a2c07380-3793-4f31-8797-bbb8cb9a6d4c`는 07:38:19~07:43:38 UTC, 318초에 EXITED했다. 완료 로그는 through 11/2, lookback 7, examined 42, unchanged 28, enqueued/published 14, failed 0, discoveryFailures [], exhausted false다. 기존 매시 10분 UTC cron을 유지한다. 이는 배포 이미지 수동 1회 실행 검증이며 미래 정시 실행을 미리 성공으로 주장하지 않는다.

후속 사용자 제보인 네이버 수동 프로그램 약270만원과 통합999,104원의 차이는 별도 조사로 이어간다. 이 기록의 native 일치 검증은 자사몰 Meta/YouTube에 한정하며 네이버 기존 계산과의 일치까지 입증한 것이 아니다.
