# Meta Ads Performance Hub 구현 계획서

작성일: 2026-05-28  
목표: 다음 개발 세션에서 이 파일 하나만 읽고 `Meta Ads Performance Hub`를 누락 없이 안정적으로 구현한다.

## 0. 원문 기준과 최종 결정

이 계획서는 아래 문서를 읽고 병합한 구현 지시서다.

- `C:\Users\seong\Desktop\workspace\Meta-Ads-Performance\메타광고관리기_요구사항.html`
- `C:\Users\seong\Desktop\workspace\Meta-Ads-Performance\메타광고관리기_DB스키마_설계.md`

추가로 사용자가 지정한 조건을 최종 결정으로 반영한다.

- 제품명은 `Meta Ads Performance Hub`를 사용한다.
- 이 프로그램은 Meta Ads Manager 같은 광고 직접 제어 도구가 아니다.
- 메타 광고 CSV 업로드 기반의 광고 성과 분석/운영 판단 보조 도구다.
- 광고 ON/OFF, 예산 변경, 메타 API 제어는 실행하지 않는다. UI에는 추천/후보/변경 로그만 제공한다.
- DB는 PostgreSQL을 사용한다.
- DB 이름: `meta_ads_performance`
- DB 계정: `meta_ads_app`
- Host: `localhost`
- Port: `5432`
- Schema: `public`
- DB 테이블은 pgAdmin에서 손으로 만들지 않는다.
- DB 테이블, enum, index는 Prisma schema와 Prisma migration으로 생성한다.
- Prisma가 직접 표현하지 못하는 partial index나 raw SQL view가 필요하면 Prisma migration SQL 파일 안에 작성한다. pgAdmin 수동 생성은 금지다.
- `.env`의 `DATABASE_URL`은 사용자가 직접 입력한다. 구현자는 실제 비밀번호가 들어간 `.env`를 만들거나 커밋하지 않는다.

## 1. 제품 정의

`Meta Ads Performance Hub`는 매일 메타 광고 관리자에서 내려받는 광고 세트 단위 CSV를 업로드하고, 사용자가 지정한 기간의 성과를 누적/평균/비교/자동 판정/그래프로 확인하는 내부 운영 웹앱이다.

핵심 사용자는 광고 운영자다. 첫 화면은 랜딩 페이지가 아니라 바로 업무용 대시보드여야 한다. 전체 UI는 SaaS 운영 도구처럼 조용하고 밀도 있게 만든다.

반드시 제공할 핵심 가치:

1. 광고 세트 CSV 업로드와 검증
2. 날짜별/광고세트별 성과 누적 저장
3. 제품 자동 매칭과 수동 매칭
4. SC/CBO/ASC 단계 추정 및 수동 이력 관리
5. 기간별 누적값과 일평균값 동시 표시
6. 전일 대비, 이전 동일 기간 대비, 선택 기간 첫날 대비 비교
7. 제품별 손익분기 CPA와 실제 CPA 비교
8. 확대/유지/관찰/중단 후보 자동 판정
9. SC -> CBO, CBO -> ASC, SC -> ASC, ASC -> SC 후보 표시
10. HTML/XLSX 보고서 다운로드
11. 운영 변경 로그 기록

MVP 비범위:

- 메타 API 자동 수집
- 광고 자동 ON/OFF
- 광고 예산 자동 변경
- GA4 자동 연동
- 광고 소재 단위 자동 분석
- 실시간 알림
- 세분화된 로그인/권한 관리

## 2. 기술 스택과 저장소 구조

확정 스택:

- Frontend: Next.js, React, TypeScript
- Backend: NestJS, TypeScript
- Database: PostgreSQL
- ORM/Migration: Prisma
- Chart: Recharts
- CSV parsing: `csv-parse`
- XLSX export: `exceljs`
- Date handling: `date-fns`, `date-fns-tz`
- Validation: `class-validator`, `class-transformer`
- Frontend data fetching: `@tanstack/react-query`
- Icons: `lucide-react`

권장 구조는 하나의 monorepo 안에 frontend/backend를 분리하는 방식이다.

```text
Meta-Ads-Performance/
  apps/
    api/
      prisma/
        schema.prisma
        migrations/
        seed.ts
      src/
        common/
        uploads/
        products/
        mappings/
        metrics/
        decisions/
        reports/
        change-logs/
        domain/
      storage/
        uploads/
        reports/
      package.json
      .env.example
    web/
      src/
        app/
        components/
        lib/
        types/
      package.json
      .env.example
  packages/
    shared/
      src/
  package.json
  README.md
  .gitignore
```

구현 시 실제 `.env`는 만들지 않는다. 대신 `apps/api/.env.example`에 아래 형태만 둔다.

```env
DATABASE_URL="postgresql://meta_ads_app:<PASSWORD>@localhost:5432/meta_ads_performance?schema=public"
PORT=4000
UPLOAD_STORAGE_DIR="./storage/uploads"
REPORT_STORAGE_DIR="./storage/reports"
```

`apps/web/.env.example`:

```env
NEXT_PUBLIC_API_BASE_URL="http://localhost:4000/api"
```

## 3. 백엔드 모듈 구조

NestJS는 OOP 기반 구조로 구현한다. 컨트롤러는 얇게 유지하고 CSV 파싱, 매칭, 계산, 판정은 서비스와 domain class로 분리한다.

필수 모듈:

- `UploadsModule`: CSV 업로드, 파일 해시, 컬럼 검증, 행별 파싱, 원본 행 저장, 중복 처리
- `ProductsModule`: 제품 마스터, 원가/마진 기준, CPA 기준 관리
- `MappingsModule`: 광고세트명 -> 제품 매칭 규칙, 수동 매칭, SC/CBO/ASC 단계 이력
- `MetricsModule`: 기간별 KPI, 제품별/광고세트별 성과, 추세, 비교 계산
- `DecisionsModule`: 자동 판정 실행과 판정 로그 조회
- `ReportsModule`: HTML/XLSX 보고서 생성과 다운로드 이력
- `ChangeLogsModule`: 사람이 수행한 운영 변경 기록
- `CommonModule`: PrismaService, config, error filter, DTO helpers

필수 domain class 또는 순수 함수:

- `AdsetNameNormalizer`: trim, 연속 공백 정리, lowercase, key 생성
- `CsvHeaderValidator`: 필수 컬럼 검증
- `MetaCsvParser`: CSV row -> typed parsed row 변환
- `AdsetProductMatcher`: manual history 우선, active rule priority 순서 적용
- `AdsetStageMatcher`: manual history 우선, 이름의 SC/CBO/ASC 추정
- `MarginCalculator`: 공헌이익, 손익분기 CPA, 목표/관찰/중단 CPA, 마진 계산
- `PeriodMetricCalculator`: 기간 합계에서 CPA/CTR/CPC 재계산
- `DecisionClassifier`: 확대/유지/관찰/중단/승격/강등 분류
- `ComparisonCalculator`: 전일 대비, 이전 동일 기간 대비, 첫날 대비 변화 계산

## 4. Prisma 데이터 모델

Prisma model은 PascalCase로 만들고 `@@map`으로 snake_case 테이블명을 고정한다. 날짜 전용 필드는 `DateTime @db.Date`를 사용한다. 금액/비율은 `Decimal`과 적절한 `@db.Decimal`을 사용한다.

필수 enum:

- `UploadStatus`: `PENDING`, `VALIDATING`, `VALIDATED`, `IMPORTED`, `PARTIAL`, `FAILED`, `CANCELLED`
- `UploadLevel`: `ADSET`, `AD`, `CAMPAIGN`
- `ConflictPolicy`: `SKIP`, `OVERWRITE`, `NEW_VERSION`
- `RowValidationStatus`: `VALID`, `WARNING`, `ERROR`, `UNMATCHED`
- `MatchType`: `CONTAINS`, `EXACT`, `REGEX`, `MANUAL`
- `MatchSource`: `RULE`, `MANUAL`, `INFERRED`, `UNMATCHED`
- `AdStage`: `SC`, `CBO`, `ASC`, `UNKNOWN`
- `DecisionType`: `SCALE`, `KEEP`, `WATCH`, `STOP_CANDIDATE`, `SC_TO_CBO`, `CBO_TO_ASC`, `SC_TO_ASC`, `ASC_TO_SC`, `PROFIT`, `LOSS`
- `ReportType`: `DAILY_HTML`, `PERIOD_XLSX`, `CHANGE_LOG_XLSX`, `CPA_RULE_XLSX`

필수 테이블과 주요 필드:

### 4.1 AppUser

MVP는 단일 사용자여도 `createdBy`, `uploadedBy` 추적을 위해 둔다.

- `id uuid`
- `email unique nullable`
- `name`
- `role default ADMIN`
- `isActive default true`
- `createdAt`, `updatedAt`

### 4.2 Product

- `id uuid`
- `code unique`
- `name`
- `displayName`
- `sku nullable`
- `sortOrder default 100`
- `isActive default true`
- `createdAt`, `updatedAt`

### 4.3 ProductCostRule

제품 원가와 환율은 날짜별 이력이다. 과거 데이터는 해당 날짜에 유효했던 기준으로 본다.

- `id uuid`
- `productId`
- `salePriceKrw Decimal(14,2)`
- `vatKrw Decimal(14,2) default 0`
- `productCostKrw Decimal(14,2) default 0`
- `shippingKrw Decimal(14,2) default 0`
- `extraCostKrw Decimal(14,2) default 0`
- `fxRateKrwPerUsd Decimal(12,4)`
- `adCostMultiplier Decimal(6,3) default 1.100`
- `effectiveFrom Date`
- `effectiveTo Date nullable`
- `note nullable`
- `createdAt`, `updatedAt`

Index: `(productId, effectiveFrom, effectiveTo)`

### 4.4 ProductCpaRule

- `id uuid`
- `productId`
- `targetRatio Decimal(6,4) default 0.8000`
- `watchRatio Decimal(6,4) default 1.1000`
- `stopRatio Decimal(6,4) default 1.2500`
- `effectiveFrom Date`
- `effectiveTo Date nullable`
- `note nullable`
- `createdAt`, `updatedAt`

Index: `(productId, effectiveFrom, effectiveTo)`

### 4.5 MetaAdset

CSV에 광고세트 ID가 없는 MVP에서는 `adsetNameKey`를 식별자로 쓴다. 추후 `externalAdsetId`가 들어오면 우선한다.

- `id uuid`
- `platform default META`
- `externalAdsetId nullable`
- `adsetName`
- `adsetNameKey`
- `firstSeenOn Date nullable`
- `lastSeenOn Date nullable`
- `currentProductId nullable`
- `currentStage AdStage default UNKNOWN`
- `isActive default true`
- `createdAt`, `updatedAt`

Prisma schema가 partial unique index를 직접 표현하지 못하면 migration SQL에 아래를 추가한다.

- unique `(platform, external_adset_id)` where `external_adset_id is not null`
- unique `(platform, adset_name_key)` where `external_adset_id is null`

### 4.6 AdsetNameAlias

- `id uuid`
- `metaAdsetId`
- `aliasName`
- `aliasKey unique`
- `source MatchSource default INFERRED`
- `firstSeenOn Date nullable`
- `lastSeenOn Date nullable`
- `createdAt`

### 4.7 ProductMatchRule

광고 세트명 포함/정확/정규식 매칭 규칙이다.

- `id uuid`
- `matchType MatchType`
- `pattern`
- `patternKey nullable`
- `productId`
- `priority default 100`
- `isActive default true`
- `validFrom Date default today`
- `validTo Date nullable`
- `note nullable`
- `createdBy nullable`
- `createdAt`, `updatedAt`

Index: `(isActive, priority)`

### 4.8 AdsetProductHistory

특정 광고세트의 제품 수동 매칭 이력이다. 자동 rule보다 우선한다.

- `id uuid`
- `metaAdsetId`
- `productId`
- `effectiveFrom Date`
- `effectiveTo Date nullable`
- `source MatchSource default MANUAL`
- `matchRuleId nullable`
- `note nullable`
- `createdBy nullable`
- `createdAt`

Index: `(metaAdsetId, effectiveFrom, effectiveTo)`

### 4.9 AdsetStageHistory

SC/CBO/ASC 단계 이력이다.

- `id uuid`
- `metaAdsetId`
- `stage AdStage`
- `effectiveFrom Date`
- `effectiveTo Date nullable`
- `source MatchSource default MANUAL`
- `note nullable`
- `createdBy nullable`
- `createdAt`

Index: `(metaAdsetId, effectiveFrom, effectiveTo)`

### 4.10 UploadBatch

- `id uuid`
- `originalFilename`
- `storedFilePath nullable`
- `fileHashSha256 char(64) unique`
- `reportStart Date nullable`
- `reportEnd Date nullable`
- `level UploadLevel default ADSET`
- `columnSchema Json`
- `rowCount default 0`
- `validRowCount default 0`
- `warningCount default 0`
- `errorCount default 0`
- `conflictPolicy ConflictPolicy default SKIP`
- `status UploadStatus default PENDING`
- `timezone default Asia/Seoul`
- `uploadedBy nullable`
- `uploadedAt`
- `validatedAt nullable`
- `importedAt nullable`
- `note nullable`

Index: `(reportStart, reportEnd)`

### 4.11 UploadRow

행별 원본과 파싱 결과를 저장해 업로드 미리보기/오류/재처리에 사용한다.

- `id uuid`
- `uploadBatchId`
- `rowNumber`
- `sourceRowHash char(64)`
- `rawRow Json`
- `parsedRow Json nullable`
- `dateStart Date nullable`
- `dateEnd Date nullable`
- `adsetName nullable`
- `adsetNameKey nullable`
- `metaAdsetId nullable`
- `productId nullable`
- `stage AdStage default UNKNOWN`
- `productMatchSource MatchSource default UNMATCHED`
- `productMatchRuleId nullable`
- `validationStatus RowValidationStatus default VALID`
- `validationErrors Json default []`
- `createdAt`

Unique: `(uploadBatchId, rowNumber)`  
Index: `(uploadBatchId, validationStatus)`  
Partial index for unmatched rows may be added in migration SQL.

### 4.12 UploadRowError

- `id uuid`
- `uploadBatchId`
- `uploadRowId nullable`
- `rowNumber nullable`
- `columnName nullable`
- `severity default ERROR`
- `errorCode`
- `message`
- `rawValue nullable`
- `createdAt`

Index: `(uploadBatchId, severity)`

### 4.13 MetaAdsetDailyMetric

대시보드와 리포트의 중심 fact table이다. CSV 원본 값은 최대한 보존하고, 계산 지표는 service에서 만든다.

- `id uuid`
- `uploadBatchId`
- `uploadRowId unique nullable`
- `metaAdsetId`
- `metricDate Date`
- `dateStart Date`
- `dateEnd Date`
- `adsetName`
- `adsetNameKey`
- `deliveryStatus nullable`
- `attributionSetting nullable`
- `resultCount Int default 0`
- `resultIndicator nullable`
- `reach Int default 0`
- `frequency Decimal(12,6) nullable`
- `costPerResultUsd Decimal(14,4) nullable`
- `adsetBudgetLabel nullable`
- `adsetBudgetType nullable`
- `spendUsd Decimal(14,4) default 0`
- `endStatus nullable`
- `startDate Date nullable`
- `impressions BigInt default 0`
- `cpmUsd Decimal(14,4) nullable`
- `linkClicks Int default 0`
- `shopClicks Int default 0`
- `cpcLinkUsd Decimal(14,4) nullable`
- `ctrLinkPct Decimal(10,6) nullable`
- `clicksAll Int default 0`
- `ctrAllPct Decimal(10,6) nullable`
- `cpcAllUsd Decimal(14,4) nullable`
- `landingPageViews Int default 0`
- `costPerLandingPageViewUsd Decimal(14,4) nullable`
- `productId nullable`
- `stage AdStage default UNKNOWN`
- `productMatchSource MatchSource default UNMATCHED`
- `stageMatchSource MatchSource default UNMATCHED`
- `productMatchRuleId nullable`
- `importVersion default 1`
- `isCurrent default true`
- `supersededByMetricId nullable`
- `rawRow Json`
- `createdAt`, `updatedAt`

Prisma migration SQL에 partial unique/index를 추가한다.

- unique `(metric_date, meta_adset_id)` where `is_current = true`
- unique `(metric_date, meta_adset_id, import_version)`
- index `metric_date` where `is_current = true`
- index `(product_id, metric_date)` where `is_current = true`
- index `(stage, metric_date)` where `is_current = true`
- index `metric_date` where `is_current = true and product_id is null`

### 4.14 DecisionRun

- `id uuid`
- `periodStart Date`
- `periodEnd Date`
- `compareType nullable`
- `filters Json default {}`
- `status default DONE`
- `createdBy nullable`
- `createdAt`

### 4.15 DecisionLog

- `id uuid`
- `decisionRunId nullable`
- `decisionDate Date default today`
- `periodStart Date`
- `periodEnd Date`
- `scopeType` values: `OVERALL`, `PRODUCT`, `ADSET`, `STAGE`
- `productId nullable`
- `metaAdsetId nullable`
- `stage nullable`
- `decision DecisionType`
- `severity smallint default 1`
- `reason`
- `recommendedAction nullable`
- `metricsSnapshot Json`
- `ruleSnapshot Json default {}`
- `isAuto default true`
- `createdBy nullable`
- `createdAt`

Indexes: `(periodStart, periodEnd, decision)`, `(productId, decisionDate)`, `(metaAdsetId, decisionDate)`

### 4.16 ChangeLog

사람이 실제 운영에서 수행한 변경을 기록한다. 광고를 직접 제어하지 않는다.

- `id uuid`
- `actionDate Date default today`
- `actionType` 예: `TURN_OFF`, `BUDGET_CHANGE`, `PROMOTE_STAGE`, `DEMOTE_STAGE`, `CREATIVE_EXCLUDE`, `NOTE`
- `targetType` 예: `PRODUCT`, `ADSET`, `STAGE`
- `productId nullable`
- `metaAdsetId nullable`
- `stageFrom nullable`
- `stageTo nullable`
- `previousValue Json nullable`
- `newValue Json nullable`
- `reason`
- `relatedDecisionId nullable`
- `nextCheckDate Date nullable`
- `createdBy nullable`
- `createdAt`

Indexes: `(actionDate, actionType)`, partial `nextCheckDate is not null`

### 4.17 ReportExport

- `id uuid`
- `reportType ReportType`
- `periodStart Date`
- `periodEnd Date`
- `parameters Json default {}`
- `filePath nullable`
- `fileHashSha256 char(64) nullable`
- `status default CREATED`
- `createdBy nullable`
- `createdAt`

Index: `(reportType, periodStart, periodEnd)`

### 4.18 AppSetting

- `key primary`
- `valueJson Json`
- `description nullable`
- `updatedBy nullable`
- `updatedAt`

초기 seed 설정:

- `timezone`: `"Asia/Seoul"`
- `default_ad_cost_multiplier`: `1.1`
- `default_conflict_policy`: `"SKIP"`
- `default_target_ratio`: `0.8`
- `default_watch_ratio`: `1.1`
- `default_stop_ratio`: `1.25`
- `good_ctr_link_pct`: `1.0`
- `good_landing_page_view_count`: `3`
- `purchase_result_indicators`: `["구매", "웹사이트 구매", "purchase"]`

## 5. CSV 업로드 명세

MVP에서 지원하는 CSV는 메타 광고 세트 단위 UTF-8 CSV다. BOM이 있어도 처리한다. 필수 컬럼 26개는 아래와 같다.

| 순서 | CSV 컬럼 | 저장 필드 |
|---:|---|---|
| 1 | 보고 시작 | `dateStart`, `metricDate` |
| 2 | 보고 종료 | `dateEnd` |
| 3 | 광고 세트 이름 | `adsetName`, `adsetNameKey` |
| 4 | 광고 세트 게재 | `deliveryStatus` |
| 5 | 기여 설정 | `attributionSetting` |
| 6 | 결과 | `resultCount` |
| 7 | 결과 표시 도구 | `resultIndicator` |
| 8 | 도달 | `reach` |
| 9 | 빈도 | `frequency` |
| 10 | 결과당 비용 | `costPerResultUsd` |
| 11 | 광고 세트 예산 | `adsetBudgetLabel` |
| 12 | 광고 세트 예산 유형 | `adsetBudgetType` |
| 13 | 지출 금액 (USD) | `spendUsd` |
| 14 | 종료 | `endStatus` |
| 15 | 시작 | `startDate` |
| 16 | 노출 | `impressions` |
| 17 | CPM(1,000회 노출당 비용) (USD) | `cpmUsd` |
| 18 | 링크 클릭 | `linkClicks` |
| 19 | shop_clicks | `shopClicks` |
| 20 | CPC(링크 클릭당 비용) (USD) | `cpcLinkUsd` |
| 21 | CTR(링크 클릭률) | `ctrLinkPct` |
| 22 | 클릭(전체) | `clicksAll` |
| 23 | CTR(전체) | `ctrAllPct` |
| 24 | CPC(전체) (USD) | `cpcAllUsd` |
| 25 | 랜딩 페이지 조회 | `landingPageViews` |
| 26 | 랜딩 페이지 조회당 비용 (USD) | `costPerLandingPageViewUsd` |

파싱 규칙:

- 필수 컬럼 누락 시 업로드를 막고 누락 컬럼명을 반환한다.
- 추가 컬럼은 허용하고 `rawRow`에 보존한다.
- 빈 숫자는 count 계열이면 0, rate/cost 계열이면 null로 저장한다.
- 숫자는 쉼표, 공백, 통화기호, `%`를 제거하고 파싱한다.
- 퍼센트 컬럼의 `1.107011`은 `1.107011%`로 저장한다. 0.01107011로 나누지 않는다.
- 날짜는 `YYYY-MM-DD`, `YYYY. M. D.`, `YYYY. M. D`, `YYYY/MM/DD`를 받아 `Date @db.Date`로 정규화한다.
- 날짜/시간 해석 기준은 `Asia/Seoul`이다.
- `adsetNameKey`는 trim, 연속 공백 1칸, lowercase로 생성한다.
- 파일 해시는 SHA-256으로 계산한다.
- 원본 파일은 `storage/uploads/YYYY/MM/<batchId>-<originalFilename>` 형태로 보관한다.
- `upload_batches.column_schema`에는 업로드 당시 컬럼명 배열과 순서를 저장한다.
- `upload_rows.raw_row`에는 원문 값을 보존한다.

중복 처리:

- 기본 정책은 `SKIP`이다.
- 중복 기준은 현재 CSV에 광고세트 ID가 없으므로 `(metricDate, metaAdsetId, isCurrent=true)`이다.
- `SKIP`: 기존 current row 유지, 새 row는 upload row에는 남기되 metric import는 건너뛴다.
- `OVERWRITE`: 기존 current row를 `isCurrent=false`로 바꾸고 새 row를 `importVersion + 1`, `isCurrent=true`로 저장한다.
- `NEW_VERSION`: UI에서 명확히 선택하게 한다. MVP에서는 `OVERWRITE`와 동일하게 current를 새 버전으로 둘 수 있지만 로그에 정책을 남긴다.

업로드 저장 흐름:

1. 파일 수신
2. SHA-256 계산
3. `upload_batches` 생성 또는 동일 해시 중복 반환
4. CSV header 검증
5. 모든 row를 `upload_rows`에 raw/parsed 형태로 저장
6. row별 숫자/날짜 검증 실패 시 `upload_row_errors` 저장
7. `meta_adsets` upsert, first/last seen 갱신
8. 제품/단계 매칭 적용
9. valid row를 `meta_adset_daily_metrics`에 import
10. batch status/count 갱신
11. summary, errors, unmatched rows 반환

제품 매칭 우선순위:

1. 해당 날짜에 유효한 `AdsetProductHistory` 수동 이력
2. active `ProductMatchRule` priority 오름차순
3. 미매칭

단계 매칭 우선순위:

1. 해당 날짜에 유효한 `AdsetStageHistory` 수동 이력
2. 광고세트명에 `ASC`, `CBO`, `SC` 포함 여부로 추정
3. `UNKNOWN`

초기 seed로 넣을 수 있는 제품/규칙 예시:

- `버닝웨이브바` 포함 -> `버닝 웨이브바`
- `버닝슬라이드` 포함 -> `버닝 슬라이드`
- `플로우라이트` 포함 -> `플로우라이트`

단, 실제 판매가/원가/환율은 사용자가 설정 화면에서 입력해야 한다. 임의 숫자로 실제 비용 rule을 만들지 않는다.

## 6. 계산 규칙

핵심 원칙: CPA, CTR, CPC 같은 비율 지표는 일별 값을 단순 평균하지 않는다. 선택 기간의 합계를 먼저 만든 뒤 다시 계산한다.

제품별 기준:

```text
광고 전 공헌이익 = 판매가 - 부가세 - 원가 - 배송비 - 기타비용
손익분기 CPA = 광고 전 공헌이익 / 광고비 부대비용 계수
목표 CPA = 손익분기 CPA * targetRatio
관찰 상한 CPA = 손익분기 CPA * watchRatio
중단 후보 CPA = 손익분기 CPA * stopRatio
```

성과 계산:

```text
spendKrw = spendUsd * fxRateKrwPerUsd
purchaseCount = resultCount
revenueKrw = purchaseCount * salePriceKrw
grossCostKrw = purchaseCount * (vatKrw + productCostKrw + shippingKrw + extraCostKrw)
adCostWithMultiplierKrw = spendKrw * adCostMultiplier
marginKrw = revenueKrw - grossCostKrw - adCostWithMultiplierKrw
cpaKrw = spendKrw / purchaseCount
cpaUsd = spendUsd / purchaseCount
ctrAllPctWeighted = clicksAll / impressions * 100
ctrLinkPctWeighted = linkClicks / impressions * 100
cpcAllUsdWeighted = spendUsd / clicksAll
cpcLinkUsdWeighted = spendUsd / linkClicks
roas = revenueKrw / spendKrw
```

분모가 0이면 null을 반환하고 UI에서는 `-`로 표시한다.

기간 계산:

- 프리셋: 최근 1일, 3일, 7일, 14일
- 직접 날짜 범위 지원
- 선택 기간의 총합과 일평균을 동시에 제공
- 일평균은 기본적으로 데이터가 존재하는 distinct `metricDate` 수로 나눈다.
- UI에는 선택 기간 전체 일수와 실제 데이터 일수를 함께 표시한다.
- 광고 수명이 짧으면 `운영 2일차`, `7일 평균 데이터 부족`처럼 표시한다.

비교 계산:

- 전일 대비: 선택 기간 종료일과 전일 비교
- 이전 동일 기간 대비: 선택 기간 바로 앞의 동일 길이 기간과 비교
- 첫날 대비: 선택 기간 첫날과 마지막날 비교
- CPA/비용 상승은 위험 색상, 구매/마진 상승은 긍정 색상으로 표시한다.

미매칭/기준 누락 처리:

- `productId`가 없으면 마진/CPA 기준 계산에서 제외하고 `미매칭`으로 표시한다.
- cost rule 또는 cpa rule이 없으면 해당 row는 성과 합계에는 포함하되 손익/판정은 `기준 미설정`으로 표시한다.
- 대시보드 상단에 미매칭 행 수와 기준 미설정 제품 수를 경고한다.

## 7. 자동 판정 규칙

판정은 사람이 검토할 추천이다. 광고를 직접 끄거나 예산을 바꾸지 않는다.

기본 scope:

- 전체 계정
- 제품별
- 광고세트별
- 단계별

제품/광고세트 성과 판정:

- `SCALE`: 구매수 > 0, 기간 CPA <= 목표 CPA, 마진 > 0
- `KEEP`: 구매수 > 0, 목표 CPA < 기간 CPA <= 손익분기 CPA, 마진 >= 0
- `WATCH`: SC 단계, 구매수 = 0, 지출 < 중단 후보 CPA, 그리고 CTR 링크 >= `good_ctr_link_pct` 또는 랜딩 페이지 조회 >= `good_landing_page_view_count`
- `STOP_CANDIDATE`: 구매수 = 0 이면서 지출 >= 중단 후보 CPA
- `STOP_CANDIDATE`: 구매수 > 0 이면서 기간 CPA > 중단 후보 CPA
- `STOP_CANDIDATE`: 선택 기간 마진 < 0 이고 데이터 일수 >= 2
- `PROFIT`: 전체/제품 scope에서 마진 > 0
- `LOSS`: 전체/제품 scope에서 마진 < 0

단계 이동 판정:

- `SC_TO_CBO`: stage=SC, 구매수 >= 1, CPA <= 손익분기 CPA
- `SC_TO_ASC`: stage=SC, 구매수 >= 2, CPA <= 목표 CPA, 마진 > 0
- `CBO_TO_ASC`: stage=CBO, 데이터 일수 >= 2, 구매수 >= 2, CPA <= 손익분기 CPA, 마진 > 0
- `ASC_TO_SC`: stage=ASC, 데이터 일수 >= 2, CPA > 중단 후보 CPA 또는 마진 < 0

판정 저장:

- 매번 `/api/decisions/run` 실행 시 `decision_runs`를 만들고 결과를 `decision_logs`에 저장한다.
- `metricsSnapshot`에는 당시 합계, CPA, CTR, CPC, 마진, 데이터 일수, 제품/단계 정보를 넣는다.
- `ruleSnapshot`에는 당시 cost rule, cpa rule, 설정 threshold를 넣는다.
- 같은 기간/필터로 다시 실행해도 새 run으로 남겨 보고 근거를 보존한다.

## 8. API 명세

공통:

- 모든 API prefix는 `/api`
- 날짜 query는 `YYYY-MM-DD`
- 모든 응답 DTO에 타입을 명확히 둔다.
- 실패 응답은 `{ code, message, details }` 형태로 통일한다.
- 금액은 원본 USD와 KRW 환산값을 구분한다.

필수 endpoint:

| Method | Path | 기능 |
|---|---|---|
| POST | `/api/uploads/meta-adset-csv` | CSV 업로드, 검증, 저장, import |
| GET | `/api/uploads` | 업로드 이력 목록 |
| GET | `/api/uploads/:id/preview` | 행별 파싱 결과, 오류, 미매칭 목록 |
| GET | `/api/uploads/:id/errors` | 오류 목록 |
| GET | `/api/dashboard/summary?from=&to=&compare=` | 상단 KPI, 비교 지표, 전체 판정 |
| GET | `/api/dashboard/trends?from=&to=&groupBy=` | 날짜별 그래프 데이터 |
| GET | `/api/metrics/adsets?from=&to=&productId=&stage=&decision=` | 광고세트별 기간 성과 |
| GET | `/api/metrics/products?from=&to=` | 제품별 손익/CPA 성과 |
| GET | `/api/metrics/unmatched?from=&to=` | 미매칭 광고세트 목록 |
| POST | `/api/decisions/run` | 선택 기간 자동 판정 실행/저장 |
| GET | `/api/decisions?from=&to=` | 자동 판정 목록 |
| GET | `/api/products` | 제품 목록 |
| POST | `/api/products` | 제품 생성 |
| PATCH | `/api/products/:id` | 제품 수정 |
| GET | `/api/product-cost-rules?productId=` | 제품 원가 rule 이력 |
| POST | `/api/product-cost-rules` | 제품 원가 rule 생성 |
| GET | `/api/product-cpa-rules?productId=` | CPA rule 이력 |
| POST | `/api/product-cpa-rules` | CPA rule 생성 |
| GET | `/api/mappings/product-rules` | 제품 매칭 rule 목록 |
| POST | `/api/mappings/product-rules` | 제품 매칭 rule 생성 |
| POST | `/api/mappings/product/manual` | 광고세트 수동 제품 매칭 |
| POST | `/api/mappings/stage/manual` | 광고세트 수동 단계 매칭 |
| GET | `/api/change-logs?from=&to=` | 변경 로그 목록 |
| POST | `/api/change-logs` | 변경 로그 생성 |
| POST | `/api/reports/export` | HTML/XLSX 보고서 생성 |
| GET | `/api/reports` | 보고서 이력 |
| GET | `/api/reports/:id/download` | 보고서 다운로드 |
| GET | `/api/settings` | 설정 목록 |
| PATCH | `/api/settings/:key` | 설정 변경 |

업로드 API 반환 예시:

```json
{
  "batchId": "uuid",
  "status": "IMPORTED",
  "rowCount": 20,
  "validRowCount": 18,
  "warningCount": 2,
  "errorCount": 0,
  "importedMetricCount": 18,
  "skippedDuplicateCount": 0,
  "unmatchedCount": 2,
  "reportStart": "2026-05-27",
  "reportEnd": "2026-05-27"
}
```

Dashboard summary 응답에는 최소한 아래가 있어야 한다.

- selectedPeriod: from, to, selectedDays, dataDays
- totals: spendUsd, spendKrw, purchaseCount, revenueKrw, marginKrw, cpaKrw, cpaUsd, roas
- averages: dailySpendKrw, dailyPurchaseCount, dailyMarginKrw
- comparisons: previousDay, previousSamePeriod, firstDay
- health: unmatchedCount, missingCostRuleCount, missingCpaRuleCount
- decisions: counts by type, top recommendations

## 9. Frontend 화면 계획

라우팅:

- `/`는 `/dashboard`로 redirect
- `/dashboard`
- `/uploads`
- `/adsets`
- `/products/performance`
- `/mappings`
- `/settings/products`
- `/change-logs`
- `/reports`

공통 레이아웃:

- 좌측 사이드바: Dashboard, Uploads, Adsets, Products, Mappings, Product Settings, Change Logs, Reports
- 상단 바: 현재 기간 선택, 빠른 프리셋, 새로고침
- 업무용 밀도 높은 화면. 큰 마케팅 hero, 장식용 카드 남발 금지.
- 표는 데스크톱 기준으로 고정 헤더와 가로 스크롤을 허용한다.
- 버튼에는 lucide icon을 사용하고, 낯선 아이콘에는 tooltip을 붙인다.

필수 컴포넌트:

- `DateRangePicker`: 1일/3일/7일/14일/직접 범위
- `KpiCard`: 총 광고비, 구매수, CPA, 매출, 마진
- `ComparisonDelta`: 전일/이전기간/첫날 대비
- `DecisionBadge`: SCALE/KEEP/WATCH/STOP 등 색상 표시
- `TrendChart`: 광고비, 구매수, CPA, 마진 선 그래프
- `ProductBarChart`: 제품별 광고비/구매수/마진 막대
- `StageDonutOrBar`: SC/CBO/ASC 단계별 비중
- `DataTable`: 정렬, 필터, sticky header
- `UploadDropzone`: CSV drag/drop
- `UploadPreviewTable`: row status, error, unmatched 표시
- `ManualMappingEditor`: 제품/단계 수동 매칭
- `ProductRuleEditor`: 원가/CPA rule 이력 관리
- `ReportExportButton`: HTML/XLSX 생성

화면별 요구:

### 9.1 Dashboard

- 상단 KPI: 총 광고비, 총 구매수, 누적 CPA, 총 매출, 총 마진
- 비교: 전일 대비, 이전 동일 기간 대비
- 경고: 미매칭 행, 기준 미설정 제품, 업로드 오류
- 그래프: 추세 선 그래프, 제품별 막대 그래프, 단계별 현황
- 자동 판정 리스트: 확대/유지/관찰/중단/승격/강등 후보

### 9.2 Uploads

- CSV 업로드
- batch history
- 파싱 요약
- 오류 row/column 표시
- 미매칭 광고세트 표시
- 중복 정책 선택: skip/overwrite/new version

### 9.3 Adsets

- 광고세트별 기간 성과표
- 제품/단계/게재상태/판정 필터
- 지출, 구매수, CPA, CTR, CPC, LPV, 마진, 판정
- 전일 대비 CPA 상승/하락 표시

### 9.4 Products Performance

- 제품별 광고비, 구매수, CPA, 매출, 마진
- 목표 CPA, 손익분기 CPA, 중단 후보 CPA 기준선
- 제품별 판정과 추천 액션

### 9.5 Mappings

- 미매칭 광고세트 목록
- 제품 수동 매칭
- SC/CBO/ASC 단계 수동 지정
- 적용 범위 선택: 특정 날짜 이후만 적용 또는 과거 current metric 일괄 재매칭
- 매칭 rule 목록과 우선순위 관리

### 9.6 Product Settings

- 제품 master CRUD
- 판매가, 부가세, 원가, 배송비, 기타비용, 환율, 광고비 부대비용 계수 관리
- CPA 비율 target/watch/stop 관리
- effective period 이력 표시

### 9.7 Change Logs

- 사람이 수행한 변경 기록
- 광고세트/제품/단계별 필터
- related decision 연결
- next check date 표시

### 9.8 Reports

- 기간 선택
- 보고서 타입 선택: 일일 HTML, 기간 XLSX, 변경 로그 XLSX, CPA rule XLSX
- 생성 이력과 다운로드

## 10. 보고서 요구사항

HTML 보고서:

- 선택 기간 요약 문장 자동 생성
- KPI table
- 제품별 성과 table
- 자동 판정 top list
- 미매칭/기준 누락 warning

XLSX 보고서:

- `Summary` sheet
- `Product Performance` sheet
- `Adset Performance` sheet
- `Decisions` sheet
- `Unmatched` sheet
- `Change Logs` sheet

보고서 파일은 `storage/reports/YYYY/MM/<reportId>.<ext>`에 저장하고 `report_exports`에 이력과 해시를 남긴다.

대표 문장 예시:

```text
선택 기간 기준 총 광고비는 {spendKrw}원, 구매수는 {purchaseCount}건, 누적 CPA는 {cpaKrw}원입니다.
제품별로는 {bestProduct}가 목표 CPA 이내로 흑자를 유지했고, {worstProduct}는 손익분기 CPA를 초과해 점검 후보입니다.
SC 테스트 중 {scToCboCount}개 세트는 CBO 후보이며, ASC에서는 {ascToScCount}개 세트의 CPA 급등 또는 마진 악화가 확인되었습니다.
```

## 11. 구현 순서

다음 세션에서는 아래 순서대로 구현한다.

1. 저장소 초기화
   - 현재 폴더에 기존 코드가 없으면 monorepo를 만든다.
   - `.gitignore`에 `.env`, `storage/uploads/*`, `storage/reports/*`, `node_modules`, `.next`, `dist`를 추가한다.

2. NestJS API 생성
   - `apps/api`
   - ConfigModule, PrismaService, global validation pipe, global error filter 구성
   - CORS는 frontend localhost만 허용

3. Prisma 구성
   - `apps/api/prisma/schema.prisma` 작성
   - PostgreSQL provider
   - 모든 enum/model/table map 작성
   - migration 생성
   - partial index는 migration SQL에 추가
   - seed 작성: app user, settings, 기본 제품 이름/매칭 rule만 생성. 실제 비용 수치는 임의 생성 금지.

4. Products/Settings API
   - 제품 CRUD
   - cost rule 생성/조회
   - cpa rule 생성/조회
   - app settings 조회/수정

5. Mapping domain/API
   - adset name normalize
   - product rule matching
   - stage inference
   - manual mapping 저장
   - 과거 current metric 일괄 재매칭 옵션 구현

6. Uploads API
   - multipart upload
   - file hash/storage
   - CSV header validation
   - row parsing/error collection
   - meta_adsets upsert
   - product/stage matching
   - duplicate policy
   - upload preview/errors endpoint

7. Metrics domain/API
   - period totals
   - weighted CPA/CTR/CPC
   - daily trends
   - product performance
   - adset performance
   - unmatched/missing rules health
   - comparison calculator

8. Decisions API
   - decision run 생성
   - product/adset/stage 판정
   - decision logs 저장/조회

9. Reports API
   - HTML generation
   - XLSX generation with exceljs
   - report_exports 저장
   - download endpoint

10. Next.js frontend
    - route/layout/sidebar
    - dashboard first
    - upload workflow
    - adsets/products/mappings/settings/change logs/reports
    - TanStack Query API client
    - Recharts graphs

11. 검증
    - backend unit tests
    - API smoke tests
    - frontend build
    - sample CSV upload manual QA
    - Playwright/browser screenshot QA if frontend is running

## 12. 테스트 계획

필수 단위 테스트:

- `AdsetNameNormalizer`
- 날짜 파서: `2026-05-27`, `2026. 5. 27.`, `2026/05/27`
- 숫자 파서: 빈칸, `1,234`, `$12.34`, `1.107011%`
- CSV header validator: 필수 컬럼 누락
- margin calculator
- break-even/target/watch/stop CPA calculator
- period metric calculator: CPA는 일별 평균이 아니라 합계 기반
- matching: manual history가 rule보다 우선
- rule priority
- stage inference
- duplicate policy
- decision classifier

필수 통합/수동 검증:

- `.env`에 사용자가 DATABASE_URL 입력 후 `prisma migrate dev`가 성공해야 한다.
- pgAdmin에서 손으로 테이블 만들지 않아야 한다.
- 업로드할 CSV에 필수 컬럼이 모두 있으면 batch/rows/metrics가 생성된다.
- 필수 컬럼 누락 CSV는 metrics import 없이 오류를 반환한다.
- 같은 파일 재업로드 시 hash 중복을 감지한다.
- 같은 날짜/광고세트 재업로드 시 conflict policy가 동작한다.
- 미매칭 광고세트를 수동 매칭하면 다음 업로드부터 자동 적용된다.
- 최근 1일/3일/7일/14일 조회가 동작한다.
- 대시보드 그래프가 최소 3개 표시된다.
- 제품별 손익분기 CPA와 자동 판정이 표시된다.
- HTML/XLSX 보고서가 생성되고 다운로드된다.

권장 명령:

```powershell
npm install
npm run lint
npm run test
npm run build
cd apps/api
npx prisma validate
npx prisma migrate dev
npx prisma db seed
```

실제 명령은 생성한 package script에 맞춰 조정한다.

## 13. 인수 기준

MVP 완료 기준:

1. 사용자가 직접 입력한 `DATABASE_URL`로 PostgreSQL `meta_ads_performance`에 연결된다.
2. Prisma migration만으로 public schema에 필요한 테이블/enum/index가 생성된다.
3. pgAdmin에서 테이블을 손으로 만들 필요가 없다.
4. 메타 광고 세트 CSV 26개 컬럼을 업로드할 수 있다.
5. 업로드 오류는 행 번호와 컬럼명까지 보여준다.
6. 업로드 원본 파일명, 파일 해시, row count, column schema가 저장된다.
7. 날짜별/광고세트별 metric이 저장된다.
8. 동일 날짜/광고세트 중복 업로드 정책이 동작한다.
9. 제품 자동 매칭과 수동 매칭이 동작한다.
10. SC/CBO/ASC 자동 추정과 수동 지정이 동작한다.
11. 기간별 총 광고비, 구매수, CPA, 매출, 마진이 표시된다.
12. CPA/CTR/CPC는 합계 기반으로 계산된다.
13. 일평균과 데이터 일수가 같이 표시된다.
14. 전일 대비와 이전 동일 기간 대비가 표시된다.
15. 목표 CPA, 손익분기 CPA, 중단 후보 CPA가 제품별로 적용된다.
16. 확대/유지/관찰/중단 후보가 자동 표시된다.
17. SC -> CBO, CBO -> ASC, SC -> ASC, ASC -> SC 후보가 표시된다.
18. 미매칭/기준 미설정 데이터가 대시보드 상단에 경고된다.
19. HTML/XLSX 보고서 다운로드가 된다.
20. 변경 로그를 기록하고 조회할 수 있다.
21. frontend/backend build가 통과한다.
22. 핵심 계산 단위 테스트가 통과한다.

## 14. 주의할 구현 함정

- `.env`에 실제 `DATABASE_URL`을 대신 입력하지 않는다.
- pgAdmin에서 테이블을 만들지 않는다.
- 마이그레이션 없이 DB schema를 바꾸지 않는다.
- 광고 제어 기능처럼 보이는 ON/OFF 실행 버튼을 만들지 않는다. 변경 로그 기록 버튼만 둔다.
- CPA를 일별 CPA 평균으로 계산하지 않는다.
- CTR/CPC를 일별 비율 평균으로 계산하지 않는다.
- 미매칭 row를 손익 판정에 몰래 포함하지 않는다.
- 제품 비용 rule이 없는데 마진을 0으로 계산하지 않는다. 반드시 기준 미설정으로 표시한다.
- 수동 매칭 변경 시 과거 데이터 적용 범위를 묻는다.
- CSV 원본값과 계산값을 섞어 덮어쓰지 않는다.
- 삭제보다 비활성화/버전 관리를 우선한다.
- 대시보드 API는 프론트가 바로 그래프를 그릴 수 있는 shape로 반환한다.

## 15. 다음 세션 첫 작업 체크리스트

1. 이 파일을 먼저 읽는다.
2. 대상 폴더에 이미 생성된 코드가 있는지 확인한다.
3. 기존 코드가 없으면 monorepo를 생성한다.
4. `.env.example`만 만들고 실제 `.env` 값은 사용자 입력으로 남긴다.
5. Prisma schema부터 작성한다.
6. migration으로 DB 구조를 생성한다.
7. CSV 업로드와 계산 domain test를 먼저 통과시킨다.
8. 그 다음 API와 frontend를 붙인다.
9. 마지막에 브라우저로 대시보드/업로드/보고서를 확인한다.
