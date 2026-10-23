# 07 — Meta 성과·광고 상태 수집
상태: **DONE (2026-10-12 14:45 KST, 구매 필수·로컬/실계정 명시 하루/격리)**. 실제 MCP 구매309건·광고 구매금액USD10,673.06·계정/광고세트USD10,673.07을 조회·저장하고 CPA·별도 구매금액 계산 ROAS·화면 표시와 독립 READ ONLY를 검증했다. 영상은 수집 대상에서 제외한다. 12:12 기본지표 판정과 아래 시각별 미완료는 이력이며 최신 판정은 [실행 인계](records/07_결과.md)의14:45 절을 따른다. 06 DONE/08 NOT_STARTED·shop 제외·신규 CSV 금지·운영 변경 금지를 유지한다.
2026-10-08 추가: 조건부 `null+이유`/혼합 기여의 fetch·writer·조회·표시·xlsx, 현재 metadata·API 수집 상태·원천 guard 및 암호화 credential backend와 검증/활성화 경로를 구현했다. 독립 의미130/130·resolver33/33·backend40/40·metadata PG40/40·수집상태 PG33/33·lifecycle29/29·활성화 PG96/96·표시 SSR11/11을 확인했다. 실제 앱 검사 token 입력 및 backend 인증3GET이 통과했다(만료2026-12-07T01:13:58Z, SYSTEM_USER, ads_read+자동 public_profile). 실제 격리 인증 DB의 PENDING ref 결속도 인증3GET/독립 READ ONLY17/17로 통과했으며 임시 암호문/key는 정리됐다. 사용자는 구매/결과/영상 미확정 및 파생 계산을 확인 필요로 표시하며 API 수집을 계속하는 결정을 수용했다. 운영 보호 provisioning/실lifecycle·운영 자격·실응답 발행/변경 관련 화면 검증은 남아 있다. 49 migration은 새 합성 및 인증검증 DB에만 적용했고 운영/실성과 DB에는 미적용이다. 승인된 Tier 검수 초안 추가 및 로컬 개인정보 초안을 준비했다. 사용자의 심사 부담 질문에 따라 자체 앱이 전제가 아닌 공식 Ads MCP 대안을 확인 중이며 실제 MCP 연결/수집 대체는 미검증이다. 06 DONE/08 NOT_STARTED는 유지한다.
필수 읽기: 공통_작업규칙.md, records/02_확정계약.md, records/04_결과.md, records/01_환경과접근조건.md.
2026-10-12 09:50 추가: 기존 MCP token으로 실제 FieldContext tools/list1POST/GraphGET0이 통과해 필드 정의 도구 schema를 별도 보호 저장했다. 앞선10/8 17:20에는 SSE 보완 후 reporting schema와 만료2026-12-07T07:43:34Z가 실제 확인됐다. 아래17:03 실패는 과거 이력이다. 현재 canonical 필드 정의의 실제 tools/call을 준비 중이며 실성과·격리 발행은 아직0이다. [최신 인계](records/07_결과.md)를 따른다.
2026-10-12 10:04 추가: 설명의 자료형 값을 enum으로 좁히던 검증을 schema string 계약에 맞춰 수정하고 실제 필드 정의122개·unknown0을 보호 저장했다. 지출amount_spent/노출impressions/링크link_click·계층ID·현재상태/예산의 지원level을 확인했다. currency/date_start/date_stop은사전에없고기여설정은광고세트수준만지원한다. 명시10/7 하루의 wire형태·기본합계·paging을 다음으로검증하며실제성과/DB발행은아직0이다.
2026-10-08 17:03 추가: 승인된 새 MCP token의 사용자 직접 보호 입력이 SAVED/466bytes·사용자/SYSTEM ACL로 완료됐다. 실제 인증3GET의 app/type/허용scope/7일초과만료/me/계정 USD·서울 검사는 통과했으나 tools/list1POST에서 TOOLS_LIST 단계로 실패했다. 실제 scopeCount/만료UTC는 실패 요약에 없어 추정하지 않는다. schema·실성과·DB 발행은0이며 추가GET0/tools-list1POST 원인진단을 준비한다. 새 token은 기존 직접API 보호 ref와 별개이며 직접 API 티어 gate를 우회하지 않는다. 상세는 [최신 실행 결과](records/07_결과.md)를 따른다.

2026-10-08 16:16 추가: 사용자 승인으로 기존 앱에 공식 Ads MCP 이용 사례를 저장했다. 자사 MCP의 공식 연결/심사 구분 및 실제 권한 표·Employee 사용자/성과 보기 접근을 확인했고 60일 최소 scope 두 개의 발급 전 조건을 준비했다. 새 token/권한 부여·MCP 인증/성과 도구·실발행은 당시0이며 기존 직접 API 티어 gate는 유지한다. [MCP 접근 검토](records/07_MetaMCP접근검토.md)의 상세 schema·날짜/페이지·보호/lifecycle·운영 적합성·요금 한계를 따른다.
목표: Meta CSV 필수 데이터를 대체하고 기존 성과 집계·버전을 유지한다. 운영 적재 없음.

사용자 결정: **shop 클릭은 CSV/API 모두 불필요, 신규 CSV 업로드에 의존하지 않는 API 수집**을 수행한다. 결과/장바구니 등 선택 지표의 미제공·기여 미확정은 null+확인 필요 사유로 API 수집을 계속한다. 구매는 아래 필수 계약을 적용하고 영상은 제외한다. 새 CSV 제출을 완료·복구 조건으로 요구하지 않으며 기존 CSV 이력은 보존한다. 전체 기존 테스트·전체 브라우저 E2E는10의 범위다. 07은 변경 관련 저장·집계·표시 회귀와 실제 인증/격리 발행을 검증했다. 운영 자격은 실제 Full 또는 해당 사용 사례의 공식 허용 근거가 필요하며 business verification은 실제 적용 요건이 있을 때 확인한다.

최신 사용자 결정(13:56): **구매는 필수값이며 실제 조회를 생략하거나 일괄 null로 처리해 완료할 수 없다. 영상은 불필요하다.** 구매 필수 profile·실제4수준 원문·별도 잔차 증거·격리 저장/조회·CPA/ROAS·SSR 표시 검증을 완료했다. 원천41개/파생29개와 광고/상위 금액 차이를 보존하고 기본 기여 맥락 미확정을 표시한다.

## 구현
- [x] 자사 Employee SYSTEM_USER·계정 성과 보기·앱 MCP 이용 사례와 최소 `ads_read + ads_mcp_management`를 확인했다. 공식 자사 programmatic MCP 경로를 선택했다. 직접 Marketing API의 Limited/Full gate는 유지하며 타사 대행의 Advanced 심사 면제를 주장하지 않는다.
- [x] MCP protocol `2025-06-18`/인증 Graph `v26.0`, 계정 allowlist·USD/Asia/Seoul·토큰 만료를 확인했다. portable AES-GCM backend와 만료/철회/재발급 경로를 구현·합성/격리 검증했다. 실제 MCP 토큰 철회는 실행하지 않았다. `ads_management`는 요청하지 않았다.
- [x] 광고 일별 성과와 조회된 캠페인/광고세트/광고 metadata를 결합했다. 일별 대상은 정확 참조 광고세트 집합이며 모든 현재 캠페인의 결합 완료를 주장하지 않는다. 상태·예산·기여 설정은 현재 관찰값으로 표시한다.
- [x] 실제 사전과 구매4필드를 완전 조회했다. 표준 구매 쌍은 omni이며 website alias를 합산하지 않는다. 구매309·광고 금액USD10,673.06·상위USD10,673.07, 원천41/paired null29의 별도 건수 잔차0·빈 구매 이벤트 금액0 증거를 검증했다. 일반 null→0을 허용하지 않는다. shop/영상은 제외하고 다른 선택 지표는 null+이유를 유지한다. 필수 링크 null도 엄격한 잔차/원문/전제/표시 계약을 따른다.
- [x] 서울시간 하루·완전 paging·같은 범위 기본합계를 대조했다. MCP의 보고 시각/기여 window는 `MCP_PROVIDER_DEFAULT_UNVERIFIED`로 명시하며 기존 CSV 기여와 같다고 추정하지 않는다. 수집 시각과 미확정 지표를 보존한다. 자동 범위는 **7일마다 직전 완료7일의 날짜별 단회 조회**, 명시 수동 하루 복구로 제한한다. 예약 구현은08이다.
- [x] 실제9POST 완전 원문으로 bounded synchronous reporting을 선택했다. 요청/전체 deadline·페이지/행/byte 상한·반복 cursor/중복 ID/부분 결과 거절을 구현했다. 비동기 provider job은 선택하지 않았고 성공은 공통 DB runner의 원자 발행 이후에만 기록한다.
- [x] 조회를 모든 광고 범위로 실행하며 기간 지출을 현재 활성 상태로 걸러내지 않는다. 계정/Meta ID를 결속하고 이름 변경·중복·scope 경계를 관련 테스트로 확인했다. 화면의 기존 기본 활성 필터는 그대로다.
- [x] 공통 canonical writer의 version/current/link·광고세트 집계·API 전용 정책을 사용했다. 불변 원문 재실행과 실제 조회를 확인했다. 광고/광고세트 비용을 더하지 않으며 다중 광고의 reach/frequency는 합산하지 않는다.
- [x] 구매3컬럼 additive migration을 새 격리 DB에만 적용하고 MCP 활성화/발행의 필수 구매 관문을 검증했다. 네 조회 서비스의 구매값·CPA·별도 계산 ROAS와 화면/내보내기 표시를 연결하고 실제 SSR17/17을 확인했다. 기존 판매가 기반 재무계산은 보존한다.
- [x] 실제 계정 USD를 인증·money wrapper와 대조했다. 다른 통화는 명시 지원 제한으로 거절하며 KRW를 spendUsd로 저장하지 않는다. 환율/구매 근거가 없으면 원화 계산과 마진은 null이다.
- [x] 실패·부분 페이지·빈 중간 페이지·필수값 누락·지연 전환·기존 성공 보존을 관련 테스트와 coverage 경로로 검증했다. 실패/미수집/정상0을 구분하며 알려지지 않은 필수값을 일반적으로0으로 채우지 않는다.

## 검증 및 DONE
- [x] 실제2026-10-07 모든 광고/서울시간의 Ads Manager와 기본3지표를 대조하고 모든 계층의 ID/합계를 검증했다. 구매는 실제 MCP 원문·필드 정의·격리 저장·독립 읽기 검증이 근거이며 Ads Manager 구매 화면 직접 대조를 주장하지 않는다. 구매 필수값/계산을 제공하고 기여 맥락 미확정을 표시했다. 신규 CSV는 사용하지 않았다.
- [x] 이름/상태·metadata 누락·중복/부분 페이지·늦은 전환·환율 누락·CSV 충돌·토큰 철회/재연결을 관련 합성/격리 테스트로 검사했다. 실제 광고 변경/토큰 철회나 전체 브라우저 E2E를 수행했다는 주장은 하지 않는다. 늦은 전환의 자동 과거 보정은 없다.
- [x] 실제 발행 후 동일 원문 replay에서 current/version/link 전체 지문 불변을 확인했다. 별도 실시간 snapshot 재조회와 구분한다.
- [x] 신규 구매 DB의 실제 READ ONLY 검사로 원천41/파생29·309건·금액 수준별 차이·CPA/구매금액 계산 ROAS·source OFF/hash불변을 확인했다. 테스트 Docker는 원래 exited/exit0으로 원복했고 임시 자격을 정리했다. 운영 자격/예약은 후속 단계다.
- [x] 실제 공식 자사 MCP 인증·완전 성과 원문·필수값/명시 파생값 지원·격리 발행·기존 조회 서비스/표시를 확인했다. 독립 평가 미해결 P1/P2는0이며07 실연동 범위 DONE이다. 접근 승인 대기나 합성 테스트만으로 완료 처리하지 않았다. 운영 GO는10의 전체 검증과11의 provisioning/배포를 거친다.
산출물: adapter/tests, records/07_대조결과.md, records/07_결과.md.
다음: 08_일일예약과복구.md.
근거: [Meta 권한 가이드](https://developers.facebook.com/documentation/ads-commerce/marketing-api/get-started/authorization).
