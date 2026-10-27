# Meta API 리포트 표시 복원 — 2026-10-26

## 변경 범위

- API 자동 수집과 기존 일별/주별 일정 유지. DB 스키마 변경 없음.
- Daily Report와 Meta Ads의 CPA 및 Excel 출력은 `cpaKrw`로 통일. 환율이 없으면 `-`이며 달러로 대체하지 않음.
- 화면/정렬/Excel의 Meta ROAS는 `providerPurchaseRoas`(Meta 구매전환금액 USD / 광고비 USD). 제품 판매가로 계산한 추정 매출 ROAS를 표시하지 않음.
- 집계일수는 동일 연결/소재의 저장된 최초 관측일~조회 종료일 이전 마지막 관측일(양 끝 포함). 조회 기간이나 현재 활성상태 필터로 1일로 축소하지 않음. 중간 공백도 포함하는 기존 기간 개념이며 실제 집행 날짜 수는 아님.
- CSV 이력은 동일 Meta 캠페인 ID가 한 연결에만 속할 때만 API 이력에 연결. 다른 계정에서 같은 소재명을 사용해도 합치지 않음.
- 화면을 차지하던 수집 설명은 접힌 상세 정보와 툴팁으로 이동.

## 추가 자동 수집

기존 `PURCHASE_V1` 캡처를 그대로 읽을 수 있는 `REPORTING_V2` 프로필을 추가했다.

| 저장 지표 | MCP 필드 | 수집 수준 |
| --- | --- | --- |
| 랜딩 페이지 조회 | `landing_page_view` | 광고, 광고세트 |
| 샵 클릭 | `shop_clicks` | 광고, 광고세트 |
| 장바구니 | `omni_add_to_cart` | 광고 |
| 영상 25/50/75/100% 재생수 | `video_p25/50/75/100_watched_actions` | 광고 |

LPV당 비용은 동일 행의 광고비 / LPV로 계산한다. 영상 재생률은 기존 정의(재생수 / 도달)를 유지한다. 여러 광고/날짜의 고유 도달을 단순 합산하지 않으므로 그 경우 도달 및 도달 기반 재생률은 비어 있을 수 있다.

광고별 3초 재생수는 현재 MCP 카탈로그에서 지원하지 않는다. 다른 영상 지표나 광고세트 값을 광고별로 나누어 대체하지 않는다. 일반적인 `결과`도 목적별 의미가 검증되지 않으면 비워 둔다. API의 기여 기준과 과거 CSV 설정이 달랐던 수치는 완전 일치를 보장하지 않는다.

제공되지 않은 값은 `null`, 명시적으로 받은 0은 0이다. 추가 지표에도 원본 행 지문과 필드별 값이 저장되며 저장 전 일치 검사를 한다. 기존 구매/부모합계 검증과 재실행 버전 보존을 유지한다. 기본 지표가 0이어도 추가 액션이 양수인 행은 기존 0행 제외 규칙으로 버리지 않는다.

## 검증

- `npm run lint`: API/Web 통과.
- Linux Docker 빌드 통과: API와 Next.js 16.3.8 전체 빌드, C7 대비 API 변경 허용목록(278개 검사/35개 변경), 런타임 폐쇄 검사 통과. 운영 DB 연결 없이 비루트 실행과 Prisma OpenSSL 3 네이티브 모듈 로드를 확인했다.
- `node --import tsx --test scripts/cloud/daily-data-sync/meta-reporting-v2.test.mjs scripts/cloud/daily-data-sync/meta-parent-purchase.test.mjs scripts/cloud/daily-data-sync/meta-null-basic-projection.test.mjs scripts/cloud/daily-data-sync/meta-day-batch.test.mjs`: 21/21 통과.
- `node node_modules/tsx/dist/cli.mjs --tsconfig apps/web/tsconfig.json --test scripts/cloud/daily-data-sync/meta-report-ui.test.tsx`: 4/4 통과.
- 실제 React 구성요소로 예시 데이터 화면을 렌더링해 원화 CPA, API ROAS, 55일 집계일수와 상세 설명 접기/펼치기를 확인했다. 예시는 운영 데이터가 아니다.
- 실제 Meta API 2026-10-25 읽기 전용 확인: 광고 553행, 광고세트 200행, 9페이지, DB 쓰기 0회. LPV 50행, 장바구니 35행, 영상 25% 45행 / 50% 45행 / 75% 43행 / 100% 40행에서 양수 관측. 샵 클릭은 553행 모두 명시적 0. 나머지는 미제공 상태 유지.

## 배포 및 기존 날짜 적용

기존 `production-source-setup.Dockerfile`은 API만 교체한다. 신규 `deploy/cloud/production-reporting.Dockerfile`은 동일 C7 OS 기준 이미지에서 API와 Next.js 16.3.8을 함께 빌드한다. 기존 소스 준비 런처, 비루트 실행, 런타임 폐쇄 검사, 컴파일 결과 변경 허용목록을 유지한다. 허용목록의 `reporting` 프로필에는 이번 API 변경 9개 파일만 추가한다.

사용자가 Railway에서 배포를 적용한 뒤 운영 반영과 2026-10-25 재수집을 완료했다. 이전 날짜의 누락 값은 해당 날짜를 재수집하기 전까지 비어 있다.

- 운영 코드: `fc9b89cc084e4e3e519cce5916366aaa2a8b4a65`.
- Railway 배포: `5aa90de5-d42e-49ff-aed2-79f92ebe096a`, 상태 `SUCCESS`. 신규 Dockerfile 적용과 운영 `/backend-api/health/live`의 `live` 응답을 확인했다.
- 운영 화면의 정상 수동 수집 경로로 2026-10-25 하루를 재수집했다. 완료 시각은 2026-10-26 09:54:51 KST이며 광고/광고세트 모두 1/1일 성공, 미수집·실패·진행 0일이다.
- Daily Report와 Meta Ads를 새로 열어 활성 소재 58개, 공통 15개 표시 항목을 대조했다. 불일치 0개. CPA에 달러 표시가 없고 집계일수, API ROAS, 영상 25/50/75/100% 재생률 표시를 확인했다.
- 대표 소재 풀업바 `경빈0001`: 집계일수 55일, 광고비 $645.18, 구매 58건, CPA 14,735원, ROAS 291.44%. 양쪽 값이 일치한다.
- 광고세트 화면의 활성 12행 모두 LPV가 표시된다. 예: `260723_풀업바` 3,644회.
- API에서 지원하지 않는 광고별 3초 재생률은 `-`를 유지한다. 10월 24일 비교 데이터의 신규 영상 지표는 이번 재수집 범위 밖이므로 비어 있다.
- 실제 화면 증빙과 대조 결과는 git에서 제외된 `reports/2026-10-26-meta-api-restore/production-*.png`, `production-verification.json`, `production-lpv-verification.json`에 저장했다.

운영 배포 전 기준: `2db2aee0b12f793e0bfbd9c0554b8503dc4af7a8`, Dockerfile `deploy/cloud/production-source-setup.Dockerfile`. 이번 작업에서는 데이터 삭제·마이그레이션·스케줄 변경을 하지 않는다.
