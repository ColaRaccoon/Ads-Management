# 2026-11-03 Meta D-1 수집 장애

## 확인한 원인

- 운영 대상: `patimagroup-work.com`, Supabase `iygjmosbelbosfxidqxv/meta_ads`.
- 2026-11-03 02:03:05 KST에 2026-11-02 일일 수집 실행이 시작됐다.
- 02:03:19 KST에 `RECONCILIATION_FAILED`, `META_NORMALIZE_PROVIDER`로 종료됐다. 스케줄/날짜 선택 오류나 인증 실패가 아니다.
- 원래 실행 `9f6da3c9-3bf8-48eb-b3c3-124398a65ff7`은 `ACTION_REQUIRED`, 저장 0건이다. 스케줄러는 이 상태를 최종 상태로 취급하여 추가 시도를 하지 않았다.
- 새벽 원본 응답은 보관되지 않아 정확히 어떤 합계/관계 조건이 불일치했는지는 소급 확정할 수 없다. 같은 날 오전 재조회는 기존 검증을 모두 통과했다. 일시적 응답 불일치가 해소된 것으로 판단한다.

## 데이터 복구

사용자 요청에 따라 기존 애플리케이션의 queue/runner/writer와 정상 인증 검증을 사용해 11월 2일만 수동 재수집했다. 원래 실패 실행과 스케줄 시각은 수정하지 않았다.

- 복구 실행: `cc521409-5410-4ab2-b91b-516bdcebad1f`, `MANUAL`, `SUCCEEDED`.
- 요청 키: `incident-meta-20261103-recover-20261102-v1`.
- 광고 582건, 광고세트 200건, 전체 저장 782건.
- 양쪽 현재 API 데이터의 광고비 합계 $4,385.61, 노출 329,747회, 구매 264건이 일치한다.
- 두 종류의 coverage 모두 `COMPLETE_NONZERO`, 경고 없음, 성공 실행 포인터가 복구 실행과 일치한다.
- 운영 DB 독립 읽기 검증 완료. scheduler stopped=false, prod-meta-daily paused=false, cadence=1, day_offset=1, 02:03 KST/100분 창 유지.
- 과거 예약 실패 이력은 보존한다. 과거 예약 실행 자체의 성공을 주장하지 않는다.

## 재발 방지

`meta-sync-runner.service.ts`에서 MCP 예약 수집의 `RECONCILIATION_FAILED` 중 정상화 단계의 `PARENT_IDENTITY`, `BASIC_TOTALS`, `LINK_TOTALS`, `PURCHASE_TOTALS`만 기존 예약 재시도 대상으로 분류한다. 초기 수정은 정상화 단계 전체를 대상으로 했지만, 사용자 후속 질문에 따라 진단을 세분화하고 재시도를 이 네 원인으로 제한했다. 세 번째 실패는 다시 `ACTION_REQUIRED`로 종료한다. 기존 5분 cron 간격, 최대 3회 시도, 예약 마감, lease, 전체 검증 및 원자적 저장은 유지한다. 수동 실행·인증 오류·canonical 저장 오류는 이 재시도 예외에 포함하지 않는다.

- 최종 코드 릴리스: `efe0d34cf5acedc349537c7f58cd6bb114689bb4`.
- 회귀 테스트: 재시도·진단·부모 구매·부모 링크·null 기본지표·reporting V2 테스트 6개 파일의 총 25개 테스트 통과. 과거 정상 입력의 proof/hash 및 business row 불변 검사 포함.
- API TypeScript 검사 및 전체 API/Web 빌드 통과.
- 운영 Docker source guard에 변경된 runner/진단/residual-proof 모듈을 명시적으로 추가했다. 기존 허용 목록의 capture/purchase/normalizer도 원인 코드 전달만 변경했다.
- 초기 수정 배포 `24819937-5d82-4125-b084-6a039a52df9c` 성공 및 08:54:58 KST readiness 확인. 원인별 진단을 포함한 최종 배포 상태는 아래에 기록한다.


## 진단과 장기 과제

오류의 외부 안전 코드는 유지하고 감사 이력과 coverage warning에 허용 목록에 속한 세부 원인만 남긴다. 응답 형식, 부모 관계, zero projection, 광고세트 선택, 링크/구매 증명, 기본/링크/구매 합계를 구분한다. 임의 공급자 오류 문자열, 토큰, 광고명, 원본 응답은 기록하지 않는다. 형식/증명 오류는 재시도하지 않는다.

네 계층은 별도 요청으로 읽으므로 동일 시점 스냅샷이 아니다(`snapshotAtomic:false`). 제한 재시도는 이 제약에 대한 복원력이며 공급자 집계의 근본 원인 해결을 입증하지 않는다. 추후 원인별 실패 추이를 근거로 수집 시각 또는 지표별 기준 데이터를 검토해야 한다. 상위 집계와의 차이를 경고로 바꾸거나 광고 행을 합산해 상위 지표를 대체하는 것은 측정 의미 변경이므로 이번 수정에는 포함하지 않았다.

## 최종 배포 확인

- 최종 Railway 배포 9b5c5799-a89f-45d4-94d0-39aad42b82e5: SUCCESS.
- 2026-11-03 09:00:42 KST 운영 health/ready 응답: ready, releaseId=efe0d34cf5acedc349537c7f58cd6bb114689bb4.
- DAILY_SYNC_SCHEDULE_ENABLED=true 및 prod-meta-daily 설정 확인.
- 새 원인 분류 코드로 11월 2일 실응답을 읽기 전용 재검증했으며 광고 582건/광고세트 200건 정상화 통과. 추가 데이터 쓰기 없음.
- 다음 자동 실행의 실제 성공 여부는 아직 관찰 전이며, 복구 성공 및 코드 배포와 구별한다.
