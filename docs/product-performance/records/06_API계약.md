# 06 통합 집계·조회 API 계약

2026-10-28 KST. 외부 계약 `product-performance-v1.1.0`, 계산 버전 `unified-report-v1`. 실제 구현은 `apps/api/src/unified-performance/report.*`, `aggregation.*`, `domain/report-*`다. 01 문서는 변경하지 않았다. 서버 `/api` prefix를 포함하며 `UNIFIED_PERFORMANCE_ENABLED=true`에서만 동작한다. 기본 OFF다.

## 경로와 권한

| 요청 | 권한 | 동작 |
| --- | --- | --- |
| GET `/api/unified-performance/options` | data.read | 기준 제품, 플랫폼 구성, 허용 범위, 발행 보유기간 |
| GET `/api/unified-performance/summary` | data.read | 선택 범위 합계·제품별 합계·동일 선택 전기 비교 |
| GET `/api/unified-performance/timeseries` | data.read | 일/월요일 시작 주/달력 월별 합계와 부분기간 표시 |
| GET `/api/unified-performance/diagnostics` | data.read | 구성요소별 미수집·미매핑·원가·환율·원천 대조 |
| GET `/api/unified-performance/relationships` | data.read | 선택 광고비와 매출·광고 전 이익의 일별 관측 관계·시차·전후 비교 |
| POST `/api/unified-performance/rebuild` | operations.run | HTTP 202, 영속 큐에 원천·계정·하루별 작업 등록 |
| GET `/api/unified-performance/rebuild/:jobId` | operations.run | 해당 작업 상태·단계·시도 횟수·안전한 오류 코드 |

라우트 guard와 서비스에서 권한을 검사한다. 현재 인증 체계는 workspace 전체 권한이며 새 사용자별 계정 ACL을 발명하지 않았다. 범위는 플랫폼/provider가 일치하는 SourceConnection 메타데이터, 확인된 쿠팡 단일 업로드, NAVER 서버 허용 목록으로 제한한다. 등록되지 않은 범위는 403이다. 웹 역할은 원천 판매/광고/네이버 JSONB에 접근할 필요가 없다. `relationships`는 2026-10-29의 09단계에서 추가했다.

모든 응답은 `Cache-Control: no-store`다. 서버/브라우저 캐시를 새로 도입하지 않았으며 정규화 조건의 `selectionHash`와 원자 스냅샷의 `snapshotHash`를 반환한다. 후속 UI 캐시는 두 값과 사용자 권한 범위를 보존해야 한다.

## 조회 조건

```text
GET /api/unified-performance/summary?from=2026-10-20&to=2026-10-26&platforms=%5B%22META%22,%22CAFE24%22%5D
```

| 키 | 실제 의미 |
| --- | --- |
| from/to | 양끝 포함. 함께 생략하면 KST 어제까지 최근 30일. 한쪽만 지정하면 400 |
| compareFrom/compareTo | 함께 생략하면 직전 같은 일수. 직접 지정할 수 있고 양끝 포함 |
| platforms | JSON 배열 문자열. META, GOOGLE, NAVER, COUPANG, CAFE24. 생략 전체, `[]`는 전체 해제. 순서/중복 정규화 |
| scopeKeys | JSON 배열 문자열. 생략은 선택 플랫폼의 허용 전체 범위, `[]`는 범위 없음. 최대 50개 |
| productName | 기준 제품명 정확 조회. 미등록 기준명 404 |
| grain | day(기본), week, month |
| limit/cursor | limit 1~100(기본 100). summary 제품/시계열 버킷/진단 행의 페이지 크기. cursor는 응답의 nextCursor 사용 |

당기와 비교기간 각각 최대 366일이다. 계정×당기·전기 고유 날짜는 최대 20,000개, 저장 집계 사실은 최대 100,000개, 설정은 각각 최대 10,000개로 제한한다. 크기를 초과하면 범위를 줄여 다시 조회한다. 판매/광고의 원천 API나 원문 JSONB 조회·재계산은 GET에서 실행하지 않는다.

cursor는 조회 조건·발행 포인터·실패 상태·설정·허용 범위가 달라지면 409로 무효화한다. 다른 플랫폼 선택의 cursor를 재사용할 수 없다. 페이지 이동 중 발행 변경을 다른 데이터의 연속 페이지로 오인하지 않게 한다.

## 공통 응답

금액·수량은 십진 문자열/null이며 금액은 소수 6자리, MER/비율은 소수 10자리다. 숫자에 Number 변환을 적용하지 않는다.

- `selection`: selectedPlatforms, excludedPlatforms, scopeKeys, productName, 당기/전기, grain, selectionHash. 같은 선택을 당기와 전기에 적용한다.
- `selectedPlatforms`, `excludedPlatforms`, `excludedByUser`: 제외 플랫폼은 `EXCLUDED_BY_USER`이며 미수집과 다르다. 제외 원천을 추가로 조회하지 않는다.
- `scopeLabel`, `profitLabel`, `metricAvailability`: 선택 플랫폼과 제품 참여 정책의 교집합. EMPTY_SELECTION/NOT_APPLICABLE/AD_ONLY/SALE_ONLY/SALE_AND_AD 및 지표별 boolean. 광고만 선택하면 매출·이익·MER null, 판매만 적용되면 광고 전 이익이다.
- `versions`: 실제 선택 발행 버전들의 계산/이름/단위/배분/범위/환율 버전. 복수 버전이면 `MIXED`, 발행 없음은 null. `publishedVersions`가 run별 정확한 버전이다. `latestConfigurationVersions`는 현재 설정이며 과거 결과의 계산 버전으로 가장하지 않는다.
- `publishedRunIdsBySource`, `asOfBySource`: 원천·범위·날짜·revision·run ID, 발행 시각, 구성요소 중 가장 오래된 원천 기준시각, stale. 전체 플랫폼이 한 시각에 수집됐다고 주장하지 않는다.
- `knownTotals`, `completeTotals`: revenue, adSpend, profitBeforeAds, estimatedProfit, mer. known은 확인된 부분합, complete는 선택·적용된 필수 입력의 수치 완전성이다.
- `productProfitSubtotal`: 분류된 판매·광고·배분비용의 제품이익 소계. 무분류 판매손익/미배분 광고/공통비/배송수입은 별도 잔액이다.
- `unclassifiedSales`, `unallocatedAdSpends`, `unallocatedExpenses`, `scopeBalances`: 플랫폼·범위·날짜별 잔액. 원천 주문키·광고명·옵션·payload는 반환하지 않는다. scopeBalances는 무분류 매출/광고 전 이익, 미배분 광고비/비용/배송수입 및 배송수입 소계를 구분한다.
- `coverage`, `comparisonCoverage`: 당기·전기의 구성요소별 participation, collectionState, rowsPresent, zeroConfirmed, 기준시각·누락 행수·부분금액·추정 여부·안전한 issue 코드.
- `comparison`: known/complete 각각 current/previous/change/changePct/reason와 일평균, 매체별 비중·비중 변화 %p·선택 광고비 증감 기여 %p. 다른 길이 기간은 unequalPeriods=true.
- 08단계에서 `comparison.previousByMarketplace`를 추가했다. 당기 `byMarketplace`와 같은 선택·발행 스냅샷의 비교기간 판매처별 확인 매출이며, 별도 원천 읽기·재계산이나 기존 금액 필드의 의미 변경은 없다.
- `warnings`, `provisional`: 부분합·미분류·미배분·0분모·현재 설정 변경 등을 표시한다. KST 오늘 이후를 포함하면 잠정이다.

`summary.items`는 productName, saleUnits, knownTotals, completeTotals, productProfitSubtotal, metricAvailability, byMarketplace, byMedium, comparison, mediumComparison, quality, isEstimate, commonExpenseAllocationStatus다. `total`, `nextCursor`를 함께 반환한다. 제품 페이지로 범위 합계가 줄어들지 않는다.

`timeseries.items`는 date(주/월의 달력 시작일), bucketFrom, bucketTo, partial 및 같은 범위의 집계·coverage다. 요청 범위 밖의 날짜는 합산하지 않는다. `diagnostics.items`는 구성요소 coverage와 해당 partition의 원천 controlTotals다. `options`는 products, platformOptions, scopes, availableDateRanges, defaultSelection을 추가한다. 보유기간은 발행된 집계의 min/max이며 연속 수집 완료를 뜻하지 않는다.

## 품질·계산과 배분

SALE, AD_SPEND, COMMON_EXPENSE, SHIPPING_INCOME을 별도로 합친다. 판매처×광고 매체 조인은 없다. 광고 전환매출은 통합 매출에 포함하지 않는다. 광고 후 범위 이익은 확인된 광고 전 이익−선택 광고비−선택 공통비+선택 배송수입이다. 부분 입력이면 `PARTIAL_TOTAL`과 누락 상태를 유지한다.

수집 완료의 사실 없는 제품은 0이 될 수 있지만, 미수집은 null이다. 제품 조회에서 해당 원천의 미분류 판매/광고가 남아 있으면 완전 제품 총액을 확정하지 않는다. 다른 제품만의 원가 누락을 정상 제품의 직접 이익에 전파하지 않는다. 제품별 미배분 비용이 남으면 공통비 배분 전 이익과 완전 이익을 구별한다.

NAVER의 ESTIMATED/기존 계산 지문 부재/갱신 정확성 미확인은 계산을 차단하지 않는다. 읽기·정규화 실패, 물리적 누락, 필수 금액/원가/환율 null은 차단한다. NAVER의 DIRECT_COST coverage는 SALE의 비용 진단을 상속한다. Cafe24/쿠팡에 별도 공통비 사실이 없으면 이미 직접비에 포함된 비용을 다시 차감하지 않고 COMMON_EXPENSE를 NOT_APPLICABLE로 저장한다.

REVENUE_SHARE는 원천·범위·날짜의 원래 판매금액을 분모로 사용한다. 다른 플랫폼을 해제해도 배분을 다시 하지 않는다. 광고만 있는 Meta/Google 원천은 자체 판매분모가 없으므로 매출비중 배분을 임의로 다른 판매처에 연결하지 않고 미배분으로 남긴다. 직접 귀속을 배분 규칙으로 덮어쓰지 않는다. FIXED_WEIGHTS와 결정적 소수 6자리 잔여 배분은 음수 정정도 보존한다.

MER는 선택 매출/선택 광고비이며 분모가 양수일 때만 계산한다. 매체 비중의 분모도 선택 광고비다. 비교는 금액 합계부터 계산하고 일별 비율을 평균하지 않는다. 전기 0은 ZERO_BASE, 이익의 비양수 기저/적자 전환은 NON_POSITIVE_PROFIT_BASE로 비율 null, 누락은 MISSING_INPUT이다.

## 비동기 재집계·발행

```json
{
  "from": "2026-10-20", "to": "2026-10-26",
  "platforms": ["META", "CAFE24"],
  "reason": "최근 7일 원천 재대조",
  "expectedContractVersion": "product-performance-v1.1.0",
  "idempotencyKey": "recent-20261026-attempt-1"
}
```

platforms/scopeKeys 생략·빈 목록 규칙은 조회와 같다. from/to는 필수이고 최대 92일이다. `productNames`를 주면 기준 제품 존재를 검증하지만 배분 보존을 위해 같은 원천·날짜 전체를 재계산한다. 응답 `executionScope=FULL_SOURCE_DAY`, `requestedProductNames`로 이 확장 범위를 명시한다. 제품 일부만 바꾼 불완전 발행은 하지 않는다.

응답은 contractVersion, status=QUEUED, execution=ASYNC_WORKER와 `jobs[]`다. jobId는 각 run ID이며 플랫폼·계정·날짜당 하나다. 상태는 STAGING(phase QUEUED/READING), READY, PUBLISHED, FAILED다. 조회 응답은 attempts, 안전한 issues, startedAt/completedAt을 포함하고 lease token·원문 오류·DB URL을 노출하지 않는다.

멱등 키는 사용자·요청·partition에 고정된다. 같은 키/같은 범위·사유는 같은 작업을 반환하고 다른 payload는 409다. 완료 후 새 정정을 반영하려면 새 키 또는 키 생략으로 새 실행을 만든다. 실패 재시도도 새 요청 키로 등록한다. 중도 중단된 STAGING은 lease 만료 후 같은 run에서 재개할 수 있고 이전 token은 발행할 수 없다.

worker는 수동 CLI로만 실행한다. 전용 `UNIFIED_AGGREGATION_DATABASE_URL`은 웹 DB 사용자와 달라야 하며 소유자/SUPERUSER/BYPASSRLS/CREATEDB/CREATEROLE 역할은 거부한다. 원천은 로컬/원격 DB 저장 결과를 읽고 외부 수집 API를 시작하지 않는다. 전체 일자 재대조를 하므로 updated_at watermark만으로 삭제·업로드 교체·0건 정정·원가/이름 변경을 놓치지 않는다. 운영 예약은 활성화하지 않았다.

단일 transaction에서 STAGING 사실/coverage/내부 이름 판정 audit를 교체하고 보존 대조 후 READY, 포인터 CAS, PUBLISHED를 발행한다. READY/PUBLISHED 사실은 DB trigger로 불변이다. 제품 참여정책도 해당 run의 participationOverrides에 고정하므로 현재 설정 변경이 과거 발행 결과를 즉시 바꾸지 않는다. 실패 원천은 이전 정상 포인터를 유지하고 이후 조회에서 STALE/LATEST_REBUILD_FAILED를 표시한다. 다른 플랫폼 작업은 계속한다.

내부 audit에는 논리 원천키 SHA, nameInputHash, 규칙/원천 버전, 제품 판정·후보·금액만 보존한다. 원문 이름·주문키·전체 SourceRef는 저장/공개하지 않는다. 공통비 행별 이름 판정을 가장하지 않으며 그 근거는 원천 지문/controlTotals와 버전 규칙으로 재현한다.

## 오류와 운영 경계

400: UNIFIED_QUERY_INVALID/UNIFIED_CURSOR_INVALID/UNIFIED_REBUILD_INVALID/UNIFIED_REBUILD_EMPTY 및 DTO 오류. 403: PERMISSION_DENIED/UNIFIED_SCOPE_FORBIDDEN. 404: UNIFIED_PRODUCT_NOT_FOUND/UNIFIED_JOB_NOT_FOUND. 409: UNIFIED_CURSOR_CHANGED/UNIFIED_CONTRACT_CHANGED/REBUILD_IDEMPOTENCY_CONFLICT 및 lease/CAS 충돌. 503: UNIFIED_PERFORMANCE_DISABLED/UNIFIED_REPORT_TOO_LARGE/UNIFIED_SCOPE_LIMIT/UNIFIED_REPORT_REBUILD_REQUIRED.

웹/API 역할은 집계 SELECT와 제한된 STAGING 큐 INSERT만 필요하다. worker만 원천 SELECT·집계 쓰기·발행을 수행한다. 06의 실제 역할 검증은 새 로컬 PG17 fixture이며 운영 권한을 부여한 증거가 아니다. 운영 migration/최소 GRANT·RLS·예약·활성화·배포는 10~11에서 준비·적용한다.

## 09 관계 분석 추가 계약

`GET /api/unified-performance/relationships`는 같은 공통 조회 조건과 `analysisMedia`, `changeDate`를 받는다. `analysisMedia`는 JSON 문자열 배열이며 META/GOOGLE/NAVER_DA/COUPANG_ADS 중 포함 플랫폼에 속한 매체만 허용한다. 생략하면 포함된 광고 매체 전체, `[]`면 분석 대상 없음이다. 숨은 플랫폼 매체나 잘못된 날짜는 `UNIFIED_RELATIONSHIP_QUERY_INVALID` 400이다. `changeDate`는 선택 기간 안의 YYYY-MM-DD이며 선택 사항이다. cursor는 받지 않고 최대 366일의 분석을 한 응답으로 반환한다. grain은 공통 선택을 보존하지만 관계 계산 표본은 항상 원래 일별 값이다.

공통 envelope의 당기·전기 금액과 selectionHash는 summary와 같고 analysisMedia/changeDate로 바뀌지 않는다. 저장된 집계의 from 이전 14일~to 및 비교기간을 동일한 읽기 전용 RR snapshot에서 읽는다. `snapshotHash`는 확장 범위 전체, `baseSnapshotHash`는 같은 snapshot에서 원래 당기·전기 포인터·실패·설정·범위를 선택한 해시로 summary.snapshotHash와 대조한다. 발행 버전·시각 메타데이터에는 lookback이 포함될 수 있다. 추가 범위에도 같은 계정 권한·제품 참여정책·발행 버전을 적용하며 원천 호출·재집계·DB 쓰기는 없다.

`analysis` 추가 필드는 다음과 같다.

- `analysisMedia`, `availableMedia`, `changeDate?`, `lookbackFrom`, `outcomeLabel`, `interpretation`, `events`: 분석 조건과 해석. 제품 지정+판매 플랫폼 3개 전체+전체 계정일 때만 제품 전체 매출로 표기한다. 명시적 계정 선택은 보수적으로 선택 판매처 합산 매출로 표시한다. 가격·행사·품절 기록은 UNAVAILABLE이며 지어내지 않는다.
- `policy`: minimumPairs=60, maximumMissingFraction="0.2", lagDirection=AD_BEFORE_OUTCOME, movingAverageUse=VISUAL_ONLY. 60쌍은 확정된 표시 정책이며 통계적 보장이 아니다. 09에서 제외율 20% 초과도 계수를 숨기는 보수적 표시 정책을 추가했다.
- `lags`: 시차 0/1/3/7/14일 × revenue/profitBeforeAds 10개. 결과일 t는 from~to, 광고일은 t−lag다. from/to, expectedDays, usedDays, excludedDays, excludedDates의 광고일/결과일/사유, pairs의 원금액과 나머지 매체 광고비·추정·품질, coefficient, reasons, volatility의 모집단 표준편차를 제공한다. 표준편차는 신뢰구간이 아니다.
- `daily`: 조회 기간 안의 원래 일별 대상 광고비·나머지 광고비·매출·광고 전 이익, weekday(일=0), issues/isEstimate, 연속 7일 전부 완전할 때만 movingAverage7을 제공한다. 이동평균은 시각화 참고이며 표본수·계수에 넣지 않는다.
- `beforeAfter`: changeDate 지정 시 전후7/14일. 변경일은 이후 구간에만 포함한다. 각 창은 from/to/expectedDays 및 지표별 usedDays/excludedDays/mean/complete, changes는 change/changePct/reason을 반환한다. 사용자 기간 밖·누락을 제외한 평균을 부분 창으로 표시하고, 어느 창이라도 불완전하면 전체 창의 변화는 null+INCOMPLETE_WINDOW다. 비양수 평균 기저는 증감률 null이다.

금액 입력은 completeTotals의 수치적 완전성으로 판단한다. 실제 미수집·미분류·원가·환율 누락을 0으로 채우지 않고 매출과 광고 전 이익의 제외를 별도로 판정한다. 계정 선택 또는 제품 참여정책에서 해당 없는 매체는 합산 대상에서 제외하고, 적용 매체가 모두 없으면 분석 광고비 null이다. 나머지 매체 누락은 맥락 null로 남기되 정상 대상-결과 쌍을 제거하지 않는다. ESTIMATED 자체는 표본을 막지 않는다. 플랫폼 제외는 원천 금액·경고·시차·전후 입력에 동일하게 적용한다.

Pearson은 Decimal 중심화로 계산하고 60쌍 미만, 광고비/결과 상수, 제외율20% 초과면 coefficient null과 이유를 반환한다. 원금액은 기존 문자열을 보존하고 통계량(계수·평균·평균 증감·표준편차)은 소수10자리다. 전후 변화는 표시 평균을 재계산하지 않고 원래 Decimal 평균에서 계산한다. 최대 시차 계수를 효과 발생일로 고르거나 인과효과·자동 예산 제안으로 사용하지 않는다.
