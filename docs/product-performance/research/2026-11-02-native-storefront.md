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

배포/발행/실제 브라우저 검증 대기. source 원본과 과거 immutable 발행본은 보존한다. 앱 롤백은 새 컴포넌트를 이해하지 않는 이전 코드도 기존 원장을 읽을 수 있지만, 수정 전 금액으로 돌아가므로 코드·worker를 함께 추적한다.
