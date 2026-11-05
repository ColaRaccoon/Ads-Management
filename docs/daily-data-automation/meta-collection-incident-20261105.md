# 2026-11-05 정시 수집 점검과 Meta 복구

## 실제 자동 실행 결과

KST 08:51 첫 heartbeat 점검에서 전일(11월 4일)의 카페24 예약 실행 `7a2ae74c-204e-41e3-80eb-542b1ae71d0d`은 SUCCEEDED/328행이었다. Cafe24 API primary 및 완료 coverage, 정확한 성공 포인터를 확인했다.

Meta 예약 실행 `d2635b0c-47f7-4966-9367-0ed672b11152`는 ACTION_REQUIRED/저장 0행, `RECONCILIATION_FAILED`/`META_NORMALIZE_PROVIDER_ZERO_PROJECTION`이었다. 공통 scheduler와 요청 번호 수정 index는 정상 유지돼 전날의 enqueue 충돌은 재발하지 않았다. 이번에는 공급자 응답 검증 단계에서 실패했다. 양쪽 자동수집 성공이라고 보고하지 않는다.

## 복구

- 기존 Meta 복구 스크립트에 `--day`를 추가하고, 완료된 최근 7일 이내 날짜만 허용했다. 요청 키는 실행일/대상일/시도로 결속하고 새 날짜의 진단·영수증은 별도 디렉터리에 저장한다. 기존 11월 3일 데이터는 다시 처리하지 않았다.
- 읽기 전용 재조회는 정상화 전체를 통과했다. 광고/광고세트/캠페인/계정 네 계층의 광고비 $3,938.21 및 기본/클릭/구매 합계가 일치했다. null 부모 114개와 명시적 0 자식 340개에 관측 활동이나 0 증명 위반은 없었다.
- 첫 수동 실행 `2f135d51-dabe-40ee-81ac-0aea2b8a3151`은 같은 ZERO_PROJECTION 검증 실패/저장 0행이었다. 당시 원시 capture는 보관하지 않아 내부 세부 위반을 소급 확정하지 않는다.
- 두 번째 수동 실행 `ea390a42-7332-4fdf-b8d1-05161020c67f`에서는 **그 수집에 실제 사용된 동일 capture**를 변경 없이 aggregate-only 진단했다. 원시 광고 937/광고세트 314/캠페인 122/계정 1, null 부모 114/0 자식 340, 위반 0. 계층별 합계 일치와 기존 전체 정상화 검증을 통과했다. 이때 광고비는 $3,938.27/노출 280,475로 앞선 재조회와 달랐다. 과거 날짜의 공급자 응답도 갱신 중일 수 있다는 관측이며, 실패 capture의 구체적 위반을 증명하는 것은 아니다.
- 08:54 KST 복구 성공: 광고 597행+광고세트 200행=797행, $3,938.27/노출 280,475/구매 269. 양 coverage COMPLETE_NONZERO/경고 없음/정확한 복구 run 포인터다.
- 판매 화면의 실제 `productPerformance`에서 카페24 328행과 Meta 광고세트 200행, 광고비 반영 상품 12개를 동시에 확인했다. 광고비 미매칭 $0, 환율 누락 0일. 별도 관리 읽기 점검으로 데이터/정책/행 수/합계도 재검증했다.

기존 queue/runner/canonical writer, 계정·자격 범위와 전체 검증을 유지했다. 실패 실행/자동 실행 이력을 성공으로 바꾸지 않았다. 구조적 0 증명을 완화하거나 null을 0으로 채우지 않았다. 앱 재배포나 스케줄 변경은 없었다. Meta의 실제 정시 성공은 아직 확인되지 않았으며 계속 점검한다.

## 증거

- 읽기 전용 점검: `reports/daily-collection-health/2026-11-04-*/database.json`, `summary.json`.
- 재조회/복구: `reports/meta-recovery/2026-11-04/`의 `meta-diagnostic.json`, `collection-capture-diagnostic.json`, `meta-recovery.json`.
- 진단 helper `scripts/meta-capture-diagnostic.ts`는 같은 capture에서 집계와 위반 코드만 반환하며 원시 식별자·광고명·토큰을 직렬화하지 않는다.
- 다른 세션이 수정 중인 unified reconciliation 및 Google Excel 파일은 변경하지 않았다.
