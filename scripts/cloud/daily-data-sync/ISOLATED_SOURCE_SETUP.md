# 08 격리 연결 준비

이 도구는 `ehnfrrmbkvlsbpvqcvkr` / `phase08_meta_ads` / `phase08_runtime`과 신규 `phase08-daily-data-sync-production.up.railway.app` 서비스에만 사용한다. 운영 별칭과 05~07 DB에는 적용하지 않는다. 앱과 v3 이미지 소스는 변경하지 않는다.

`operator-session.ps1`, `source-connection-helpers.ps1`은 함수 정의만 제공한다. import만으로 DPAPI나 네트워크에 접근하지 않는다. 실행 wrapper는 기존 DPAPI 평가 계정과 보호 context를 메모리에 읽고, 정상 로그인 응답의 계정·권한·4개 Secure Host cookie·no-store·비밀값 제외를 검사한다. CSRF와 cookie jar를 파일이나 인수로 전달하지 않는다.

루트 작업자가 실제 신규 서비스의 `DAILY_SYNC_FEATURE_ENABLED=true`, `DAILY_SYNC_SCHEDULE_ENABLED=false`, `PHASE08_ACTIVATED=true`, 정확한 3개 계정 allowlist를 읽기 재확인한 뒤에만 `-ActivationVerified`를 전달한다. 기존 보호 context의 초기 `feature=false` 기록은 보존한다. 실제 앱의 feature와 allowlist 검증도 계속 적용된다.

1. `manage-isolated-sources.ps1 -Mode Login`으로 보호 계정만 정상 로그인한다.
2. `-Mode List -ActivationVerified`로 상태를 확인한다. 각 provider는 Google `1391592099/default`, Meta `2138525300002203/default`, Cafe24 `didadi0729/shop1`만 허용한다.
3. `-Mode CreateGoogle` / `-Mode CreateCafe24`는 기존 동일 provider가 없을 때 정상 DTO로 생성하며 결과는 `PENDING`, `enabled=false`여야 한다. 새 CSV를 요구하지 않는다.
4. Meta ciphertext AAD에 결속된 보호 context의 `ids.metaConnectionId`를 유지하려면 `prepare-meta-pending.ps1 -OutputPath <MetaAdsPhase08Evaluation 아래 새 .sql>`로 SQL artifact만 만든다. 루트 작업자가 고정 Management API의 실제 프로젝트 fingerprint를 재확인하고 SQL을 검토·적용한다. SQL은 fresh 평가 Auth/AppUser와 Meta 미존재를 검사하고, 예약 UUID의 `NULL` credential ref / `PENDING` / 비활성 연결과 해당 평가 사용자의 `USER` 생성 감사만 같은 transaction에 쓴다. 자격정보·READY·정책을 직접 쓰지 않는다.
5. `-Mode BindGoogle` / `-Mode BindMeta -ConnectionId <검토한 UUID> -ActivationVerified`는 정상 HTTP bind를 이용한다. Google은 보호 참조를 결속하고, Meta는 기존 resolver의 계정·SYSTEM_USER·scope·7일 유효기간 검증 3 GET을 수행한다. 연결은 계속 `PENDING`, 비활성이다.
6. `-Mode PrepareVerifyGoogle -ConnectionId ... -VerificationDay yyyy-MM-dd -FromDate yyyy-MM-dd -ObservedAccountCostKrw <직접 관측한 정수 문자열> -ActivationVerified` 또는 `PrepareVerifyMeta`와 `-ObservedAccountSpendUsd`, `-ConditionalReviewDecision`을 사용한다. 결과는 **검토 가능한 DTO만**이며 HTTP verify를 실행하지 않는다. 신규 통계·MCP insights를 자동 조회하지 않는다.
7. 실제 검증이 별도로 승인되고 독립 관측값을 확인했을 때만 같은 명시적 인수에 `-Mode ExecuteVerifyGoogle` 또는 `ExecuteVerifyMeta`, `-IndependentObservationVerified`, `-ActivationVerified`를 전달한다. 정상 HTTP verifier가 provider 하루 통계를 읽고 관측값을 대조한다. 성공은 정확한 검증일의 `READY`, `enabled=true`여야 하며 실제 request timeout은 90초다. 기존 인계의 독립 실제 관측은 Google 05의 `2026-09-29` / KRW `'0'`, Meta 07의 `2026-10-07` / 광고 지출 USD `'4918.32'` / `ALLOW_UNAVAILABLE_WITH_REASONS`다. Meta 구매 건수 `309`와 구매금액 USD `10673.07`은 별도 필수 지표이며 지출 관측 인수에 넣지 않는다. 코드에 날짜·관측값 기본값을 넣지 않는다. 공급자가 과거 데이터를 수정하면 서버의 `RECONCILIATION_FAILED` 결과를 유지하고 결과를 확인한다.

Google verify DTO는 `verificationDay`, `fromDate`, `observedAccountCostKrw`다. 시작일은 검증일 이전 또는 같고 30일 차이 미만이어야 한다. Meta는 `verificationDay`, `fromDate`, `observedAccountSpendUsd`, `conditionalReviewDecision`이며 결정은 `REQUIRE_VERIFIED_CONDITIONALS` 또는 `ALLOW_UNAVAILABLE_WITH_REASONS`다. 자유 서술 reason 필드는 DTO에 없다. Meta 구매 건수·구매금액 필수와 영상 제외는 기존 서버 verifier가 유지한다. 실제 verify HTTP는 provider 일일 통계 조회 및 성공 시 활성화·정책 생성을 수행하므로 단순 DTO 준비와 구분해 기록한다. wrapper의 provider 요청 수는 실측하지 않으며 예상 metadata 요청 수를 실제 기록과 혼동하지 않는다.

Cafe24 OAuth pair의 06/08 동시 refresh 소유권은 이 도구로 해결하지 않는다. 기존 06 pair를 복제해 수집을 시작하면 안 된다. 별도 소유권 인계와 기존 내부 규칙 보존 검토 후에만 후속 활성화 경로를 진행한다. 실패 결과는 고정 enum만 출력하며 원문 응답·오류·cookie·자격정보는 출력하지 않는다. 재실행 전 결과를 확인한다.
