# 07 — 공식 Ads MCP 접근 검토

**2026-10-12 14:45 KST 최신: DONE — 구매 필수 검증 완료.** 영상은 제외했다. 승인된 자사 공식 programmatic MCP의 실제 완전 조회에서 구매309건·광고 전환금액USD10,673.06·공급자 광고세트/계정USD10,673.07을 받았다. 새 격리 DB의 정상 인증·발행·불변 replay·독립 READ ONLY와 구매 CPA/별도 계산 ROAS·표시를 검증했다. 구매29개 paired null은 별도 건수 잔차0/빈 이벤트 금액0 근거로만 파생하고 원문/차이/기여 맥락을 보존한다. 단순 사전 지원만으로 실제값을 추정하지 않았다. [최신 실행 인계](07_결과.md)의14:45 절을 따른다.

이번 구매 재개 실제 MCP9POST·Graph 인증16GET(실패4+성공12), 당일 이력 tools/call 누계56POST·Graph28GET다. 성공 발행의 원문 replay3회·추가MCP0, 신규 readonly2회는 provider/token/DB쓰기0이다. 영상/신규CSV/광고수정/운영변경/심사최종제출은0이다. 자사 경로의 실제 검증을 공개 앱/타사 계정 심사 면제나 직접 Graph Full 승인으로 확대하지 않는다. productionReady=false·임시 자격 정리true·정확 테스트Docker exited/exit0 원복이며 운영 provisioning/예약은 후속 단계다. 06 DONE/08 NOT_STARTED 유지. 아래12:12 및 발급 전 기록은 당시 이력이다.

2026-10-12 12:12 KST 갱신. **07 DONE (자사 공식 MCP·실계정 수동 하루·격리 발행/조회)**다. 기존 직접 Graph Limited/Full gate는 유지하며 자사 Employee SYSTEM_USER의 별도 공식 programmatic 경로를 선택했다. 아래 발급 전 준비·schema/성과 미완료·JSON-only 실패는 당시 이력이며 최신 판정은 이 절과 [최종 실행 인계](07_결과.md)를 따른다.

실제 token 인증·reporting/필드 사전 schema·122개 정의·완전 paging 원문을 확인했다. 명시2026-10-07의 광고70/정확 참조광고세트14를 API 전용 격리 발행하고 Ads Manager와 **USD4,918.32/노출307,749/링크6,200**을 대조했다. 링크 원문 null5개는 비음수 가산 클릭 건수·같은 범위의 모든29부모 잔차0과 기본값 보존을 재검산한 **DERIVED_ZERO_RESIDUAL**이며 원문/전제/출처·동시 snapshot 미검증을 보존한다. 공급자 scalar0/필터 효과를 주장하지 않는다.

실제 binder→verifier→runner의 인증12GET·원문 replay3회·추가MCP0, 불변 버전/current/link 및 독립 READ ONLY의 기존 ad/adset/campaign/creative 조회·source-off 검증을 통과했다. 조건부 지표·기여 미확정·파생 CPA/ROAS/마진은 null+사유, shop은 제외다. 실제 tools/call47POST·인증된 tools/list 누계4POST(10/12는1POST)다. 신규 CSV 의존·광고 수정·추가 Meta 문의·심사 최종 제출·신규 유료 구성/모델 호출은 없다.

SYSTEM_USER token 만료는 **2026-12-07T07:43:34Z**다. 로컬 DPAPI는 시험 입력 보호이며 서버 runtime은 별도 AES-GCM credential backend와 MCP 명시 gate를 사용한다. 프로그램을 이 PC에만 제한하지 않는다. 격리 검증용 AES key/암호문은 정리해 `productionReady=false`이고 운영 provisioning/예약/실 정시 증거는 후속 단계다. MCP 자체 요금의 별도 공식 확정은 없으며 기존 Marketing API 무과금 답변과 구분한다. 자사 사용의 공식 근거를 타사 대행/공개 앱 심사 면제나 직접 Graph Full 승인으로 확대하지 않는다. 06 DONE/08 NOT_STARTED를 유지한다.

11:37 KST 최신: 명시10/7의 완전9POST 원문(광고70/광고세트306/캠페인14/계정1)을 보호 저장했다. 광고의 정확한 참조광고세트14개 및 부모조인은 일치하고 기본합계는 Ads Manager USD4,918.32/노출307,749/알려진링크6,200과 일치한다. 비참조292개는 현재metadata 관측으로 보존한다. 광고링크null5개는 두metric0필터의 양수대조군까지불변으로 반환돼 아직0으로 확정하지 않았다. 실제도구호출46POST/목록4POST·10/12 GraphGET0·성과DB0이며 명시ID 직접조회·정의와전체범위에 따른 잔차 증명을 검토 중이다. 이전 절의 실성과 미조회0은 당시 이력이다.

2026-10-08 17:20 reporting schema 보호 저장은 auth3GET/tools-list1POST·exit0, 만료2026-12-07T07:43:34Z를 확인했다. JSON/SSE 응답을 상한 내에서 처리하도록 보완했으며 ad_entities는 JSON 배열 문자열, time_range는 since/until JSON 문자열, time_increment는 문자열1이다. live/include_additional_contextfalse와 반환 cursor·모든 나머지 인자의 동일 재전송 계약을 확인했다. 기여/보고 시각과 일별 실제 반환 형태는 아직 검증이 필요하다.

2026-10-12 09:50 필드 정의 도구 schema 확보는 기존 token·GraphGET0/tools-list1POST·exit0이다. `field_names` 생략으로 전체 canonical/level/type/metric/filter/operator 정의를 조회할 수 있다. 실제 tools/call helper를 준비하며 대화 전체 전송 문구와 후속 추천 작업은 외부 데이터로만 취급한다. advertiser_request를 생략하고 PII 없는20자 임의 기술 ID만 사용한다. 실성과·DB·운영 변경0, 신규 CSV 요구0을 유지한다.

2026-10-12 10:04 실제 필드 정의122개를63715bytes 보호artifact에 저장했다. 최초read는FIELD_METADATA_VALIDATE로거절됐고구조진단에서모든자료형이helper enum밖임을확인했다. 실제schema는string만정의하므로문자열상한/제어문자검사와원문보존으로고쳐read exit0을확인했다. 현재canonical amount_spent/impressions/link_click과계층ID·status/effective_status·예산/시각지원level을읽었다. currency/date_start/date_stop은미등록이며지정하지않는다. attribution_setting은광고세트수준이고3_second_video_plays는광고수준지원이없다. 명시10/7 하루의실제값·날짜형태·완전paging·link_click의기존기본지표대조는후속검증한다. 이사전성공을실성과·격리발행·07 DONE으로대체하지않는다.

## 확인한 공식 경로

주 담당자가 앱 내 브라우저에서 다음 원문을 직접 읽었다. 독립 평가자의 web 열람은 실패했으므로 독립 원문 열람 완료라고 기록하지 않는다.

- [MCP 시작하기](https://developers.facebook.com/documentation/ads-commerce/ads-ai-connectors/ads-mcp-server/ads-mcp-server-get-started), Updated 2026-09-04: Meta 앱 소유는 전제가 아니다. 앱 없이 이용하는 지원 AI 클라이언트 연결과, 자체 앱에 MCP 이용 사례를 추가하는 개발자 연결을 구분한다. 자체 앱은 OAuth·사용자 토큰·직원 역할 시스템 사용자 토큰을 지원한다. 관리자 역할 시스템 사용자 토큰은 지원하지 않는다. 최소 권한은 `ads_mcp_management`와 `ads_read` 또는 `ads_management`다.
- [공식 연결 도움말](https://www.facebook.com/business/help/1456422242197840): 기본 연결 안내는 ChatGPT·Claude·Claude Code·Perplexity이며, 자체 클라이언트는 개발자 문서로 안내한다. 기본 연결을 현재 서버에 그대로 재사용할 수 있다는 주장은 하지 않는다.
- [개발자 MCP 출시 안내](https://developers.facebook.com/blog/post/2026/07/16/meta-ads-mcp-server/): 기존 Meta 앱에 MCP 이용 사례를 추가하는 절차와, 다른 회사의 데이터를 대신 관리할 때 `ads_mcp_management` Advanced Access 검수를 요청하는 선택 단계를 설명한다. 화면 날짜는 2026-07-17이다. 자사 MCP까지 무조건 해당 검수가 필수라고 말할 근거는 없지만, 이 문구를 기존 직접 Marketing API의 Full 면제로 확대하지 않는다.
- [보고 도구](https://developers.facebook.com/documentation/ads-commerce/ads-ai-connectors/ads-mcp-server/ads-mcp-server-tools-comprehensive-reporting), Updated 2026-07-14: `ads_get_ad_entities`는 광고·광고세트·캠페인, 날짜 범위, 성과·필터·breakdown·정렬을 제공한다. 이 안내에는 상세 input/output schema·페이지 완결·기여 설정 계약이 없다.
- [Ads CLI 개요](https://developers.facebook.com/documentation/ads-commerce/ads-ai-connectors/ads-cli/ads-cli-overview), Updated 2026-04-29: system-user 토큰으로 Marketing API를 대신 호출하는 JSON/no-input 자동화 도구다. 별도 운영 티어 예외 근거로 사용하지 않는다. 설치하지 않았다.

## 실제 앱 상태와 승인 범위

사용자가 기존 앱 `Daily Data Automation`/`4474691502806219`에 MCP 이용 사례를 저장하고 조건을 확인하도록 승인했다. 선택창에서 **MCP 이용 사례 하나만 저장**했고 저장 후 목록 및 맞춤 설정 화면에서 추가를 확인했다. 기존 Marketing API 이용 사례도 남아 있다.

MCP 권한 표의 `ads_mcp_management`는 API 호출 0·테스트 준비 완료다. 전체 설명은 MCP를 통한 성과 보고와 광고·자산 관리 접근을 모두 설명하므로 이 권한 자체를 읽기 전용이라고 부르지 않는다. `ads_read`와 다른 여러 권한도 이용 사례 표에 표시되지만, 표에 표시되는 것과 실제 token scope 부여는 다르다. 새 token·권한 부여·Advanced 신청·검수 제출은 실행하지 않았다.

요구 사항 도움말은 비즈니스 인증·앱 검수·성공 테스트 1회·데이터 처리 질문을 열거하고, 옵션에는 ‘앱 검수에 추가’가 있다. 이 일반 안내를 자사 Standard MCP의 개별 필수 조건으로 단정하지 않는다. 실제 최소 scope 검증 뒤 적용 접근 조건을 판정한다.

대상 계정 `2138525300002203`의 MCP 관리 UI에는 기존 7/7 action 허용이 있다. 상세 이름은 예산 수정/설정, 캠페인 만들기, 광고세트 만들기, 광고 만들기, 타겟 수정, 크리에이티브 수정, 상태 수정이다. 상위 작업 스위치도 켜져 있다. 기존 규칙은 변경하지 않았다. 읽기 검증은 `ads_read + ads_mcp_management`만 요청하고 보고 도구만 허용해야 하며, 광고 수정 권한이나 광고 변경 호출을 추가하지 않는다.

증거는 Git 밖에 보존한다.

- `C:/Users/seong/AppData/Local/MetaAdsMetaIsolated/mcp-usecase-before-save-20261008.png`
- `C:/Users/seong/AppData/Local/MetaAdsMetaIsolated/mcp-usecase-saved-20261008.png`
- `C:/Users/seong/AppData/Local/MetaAdsMetaIsolated/mcp-permissions-test-ready-20261008.png`

## 인증 전 공개 프로토콜 확인

자격증명·광고계정 ID·사용자 정보를 전송하지 않은 공개 요청 **GET 3회 + POST 1회**만 실행했다. 모든 curl 프로세스 exit 0이며 HTTP 결과는 아래와 다르다. 추가 Graph/Insights 인증·성과 호출과 DB 쓰기는 0이다.

| 요청 | 실제 결과 | 증명 범위 |
|---|---|---|
| GET `https://mcp.facebook.com/ads` | HTTP 405, JSON-RPC는 POST 필요 | 공개 endpoint 응답만 |
| 인증 없는 POST `tools/list` | HTTP 401, Bearer challenge | 도구 목록을 얻지 못함 |
| challenge의 `/.well-known/oauth-protected-resource/ads` GET | resource·issuer·header bearer·scope JSON 반환, HTTP 상태는 별도 출력하지 않음 | 공개 인증 discovery만 |
| issuer의 `https://www.facebook.com/.well-known/oauth-authorization-server/ads` GET | code/refresh grant·S256 PKCE·public client 및 registration endpoint JSON 반환, HTTP 상태는 별도 출력하지 않음 | 실제 등록·권한·refresh 성공 아님 |

공개 metadata의 scope 목록을 최소 요청 목록으로 사용하지 않는다. dynamic registration endpoint가 광고돼 있다는 것만으로 자체 앱 없이 임의 custom 서버를 운영할 수 있다고 결론 내리지 않는다. 클라이언트 등록·OAuth 동의·token 교환은 아직 0이다.

## 발급 전 준비와 비용 확인 한계

기존 `Conversions API System User`/`61578703552288`의 실제 BM 역할은 **Employee**다. 기존 광고계정 ‘성과 보기’와 앱 ‘앱 테스트’ 할당을 읽었고 변경하지 않았다. 실제 토큰 설정 wizard에서 현재 앱 선택·60일(추천)·`ads_read`와 `ads_mcp_management` 두 항목만 임시 선택했다. 마지막 ‘토큰 생성’은 누르지 않았으므로 새 토큰·앱 설치 동의·권한 부여는 아직 0이다. 이 화면은 `mcp-token-scopes-before-issue-20261008.png`에 보존한다. 실제 token에는 자동 `public_profile`이 추가될 수 있으므로 발급 뒤 `/debug_token`으로 정확 scope·app/type/만료를 확인해야 한다.

새 MCP용 token은 기존 수집/검사 암호문을 덮어쓰지 않고 별도 `mcp-access-token.dpapi`로 보호하는 검증용 수신기를 준비한다. 수신기를 준비하는 것과 실제 수신/저장을 구분한다. 새 권한 발급/저장은 별도 구체 승인이 필요하며, 보호 입력은 사용자 직접 입력으로 진행한다. DPAPI는 이 PC의 로컬 검증 보관이고 향후 서버를 Windows에 종속하는 설계가 아니다.

보호 수신 mode는 개발자 합성 검증과 독립 helper46/46·실제 PS binder16/16을 통과했다. PS 기본 대소문자 무시로 생겼던 파일명 계약 불일치를 수정했고 Parser오류0·합성 DPAPI roundtrip·실ACL·nooverwrite·기존 access/inspector 분리를 확인했다. 실제 고정 MCP 파일·수신 서버·토큰 읽기·Meta/DB 실행은0이며, 인증/discovery helper의 독립 검토는 별개다.

인증/discovery 검사는 실제 발급 승인 전에는 실행하지 않는다. 고정 앱·SYSTEM_USER·최소 scope·만료·계정 USD/서울 결속을 확인하는 최대3GET 뒤 고정 MCP endpoint에 tools/list 최대1POST만 보낸다. Accept는 JSON과 SSE를 광고하지만 현재 응답 parser는 bounded JSON만 수용한다. SSE·initialize/session·목록 nextCursor가 필요하면 추가 요청 없이 실패한다. 이 경우 단회 검사가 프로토콜을 처리하지 못했다는 증거이며 token/계정의 MCP 접근 불허 증거로 확대하지 않는다. schema만 선택해 저장소 밖 보호 파일에 nooverwrite로 보존하며 tools/call·실광고 성과·DB/운영 활성화는 수행하지 않는다. 상세 outputSchema 미제공은 null로 남기며 그 자체가 일별 값 동등성을 증명하지 않는다.

이 helper는 개발자·독립 합성217/217, 독립 실제 PS CHILD_RESULT 분기 원문을 합성 summary/fake exitcode로37경우 검증했다. 전체 launcher·실 DPAPI·실 child entry 실행은 아니므로 그 범위를 확대하지 않는다. node 구문·PS Parser 오류0, 미해결 안전 P1/P2없다. 실제 token 읽기/발급/수신 서버/Meta 요청/고정 schema 저장/DB는0이다.

사용자는 MCP가 AI 관리 도구라 데이터만 받을 수 있는지, 요금이 없는지 질문했다. 공식 문서의 programmatic/system-user 서버 경로와 JSON-RPC 보고 도구는 모델 호출을 매번 요구하지 않는 직접 수집 구조의 근거다. 실제 상세 데이터 동등성과 endpoint 성능은 미검증이다. 기존 Meta 담당자의 Marketing API 자체 추가 비용 없음 답변을 MCP 별도 요금 확정으로 확대하지 않는다. 공식 도메인에 MCP free/cost/pricing을 확인하는 검색은 결과가 없었고 직접 읽은 안내에도 가격 설명을 확인하지 못했다. 별도 과금이 있다는 근거도 확보하지 못했다. 그러므로 **MCP 자체 무료 확정은 미확인**으로 기록한다. 직접 클라이언트 설계에는 AI 모델 호출이 필수가 아니지만 호스팅·구독·상용 connector 비용까지 없다고 주장하지 않는다. 신규 유료 서비스·모델 호출·connector 설치는 0이다.

## 17:03 KST 실제 토큰·단회 probe 후속

새 MCP token은 사용자 직접 입력으로 CurrentUser DPAPI·사용자/SYSTEM ACL에 별도 보호 저장됐다. 수신기 exit0/SAVED와466bytes 파일·완료 화면을 확인했다. 실제 discovery는 인증3GET 뒤 tools/list1POST에서 TOOLS_LIST 단계로 실패했다. 앞선 type/app/허용 scopes/7일 초과 만료/me/대상 계정 USD·서울 조건을 통과한 범위까지만 인정한다. 실패 출력에 실제 scopeCount/만료UTC가 없으므로 이전 token 값·UI60일을 실제 값으로 대체하지 않는다. MCP schema/실성과/DB 발행은0이다.

HTTP 상태와 JSON/SSE/오류코드만 확인하는 추가1POST 진단을 준비한다. 직접 tools/list는 Meta programmatic 예시를 확인하기 위한 단회 probe였으며 완전한 표준 client가 아니다. [MCP2025-06-18 lifecycle](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle)은 initialize 첫 교환·버전/능력 협상·initialized 통지를, [transport](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)는 JSON/SSE 응답 및 반환된 session id의 후속 전달을 규정한다. 초기화/session/stream 문제인지 실제 접근 조건인지 현재는 미확정이다. protocol 실패를 Meta 심사 필수/자격 불허로 단정하지 않는다. raw token/error/응답은 출력·저장하지 않는다.

## 기존 snapshot 계약과 남은 검증 대응표

17:13 KST 제한 진단1POST는 실제 HTTP200/SSE·TOOLS_LIST_PRESENT·정확 JSONRPC id1·tools 배열과 nextCursor 없음, 오류/initialize/session 필요 신호 없음으로 반환됐다. 같은 보호 token의 endpoint 접근이 확인됐고 기존 JSON-only parser는 이 응답을 수용할 수 없다. 최초 실패 당시 HTTP/형식이 미기록이므로 당시 원인까지 확정하지 않는다. 원문/schema 저장·tools/call·실성과·DB는0이다. 기존 discovery에 bounded SSE 지원을 준비하고 이 성공을 전체일별필드/운영/lifecycle/07DONE으로확대하지않는다.

| 07 계약 | MCP 공개 안내의 현재 근거 | 실제 연결 뒤 필요한 증거 |
|---|---|---|
| 자사 계정 allowlist·USD·서울 시간대 | 광고 객체·계정 연결 지원 | 계정 identity/currency/timezone 원문과 결속 |
| 직전 완료 7일을 날짜별 한 번, 명시한 하루 수동 복구 | 날짜 범위 지원 | 정확한 since/until·날짜별 값·호출 상한과 범위 거절 |
| 광고/광고세트/캠페인 ID 결합과 전체 페이지 | 해당 객체 조회 지원 | raw ID·pagination/limit·끝 페이지·중복/누락 검증 |
| 지출·노출·링크 클릭 필수 scalar | 지출·노출·CTR/CPC/CPM 등 설명 | 링크 클릭의 정확 필드와 명시 0/빈 응답 구분 |
| 구매·결과·장바구니·영상·기여 설정 | 전환/성과 설명만 | 배열/alias·action reporting time·기여 설정·null+이유 대응 |
| shop 제외 | 별도 근거 불필요 | 조회/저장 요청에 포함하지 않음 |
| 현재 metadata·관찰 시각 | 광고 객체 조회 | 상태/예산/일정 raw 값과 현재값 의미 |
| 서버 무인 인증·보호 ref·갱신/철회 | programmatic system-user 지원, 공개 refresh grant 광고 | 직원 역할·정확 app/type/scope/만료·보호 backend·실lifecycle |
| current/version·멱등·실패 성공 보존·화면 | MCP 서버는 이 앱의 저장을 검증하지 않음 | 기존 foundation/writer를 통한 실제 격리 발행·독립 조회 |

성과 요약 문장을 canonical 숫자로 바꾸거나, 상세 schema를 추정해 adapter를 구현하지 않는다. MCP 계정 읽기 성공만으로 페이지 완결·필드 동등성·07 DONE을 주장하지 않는다. 기존 직접 Graph gate는 그대로 두고 새로운 경로의 공식 자격과 실증을 별도 확인한다. 새로운 CSV 업로드는 요구하지 않는다.
