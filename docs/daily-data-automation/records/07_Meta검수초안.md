# 07 — Marketing API Access Tier 검수 준비 초안

2026-10-08 KST 작성. **최종 제출/승인 증거가 아니다.** 사용자가 기능을 검수 신청 초안에 추가하고 제출 요건을 확인하도록 승인하여, 실제 제출 초안 `4485022548439781`에 Marketing API Access Tier 하나를 추가했다. 앱은 계속 Limited이며 초안 상태는 제출되지 않음이다. 외부 추가 지원 문의는 하지 않는다.

## 대상과 요청 동작

- 앱: Daily Data Automation, `4474691502806219`.
- 자사 광고계정: `2138525300002203`, 연결 BM `1307644100927401`.
- 화면 동작: Marketing API Access Tier의 Upgrade로 해당 기능을 App Review 신청 초안에 추가. 화면은 심사 승인 및 유지에 필요한 연례 검토를 설명한다. 이 버튼 자체의 설명을 즉시 Full 승인이라고 해석하지 않는다.
- 범위: 운영 티어 기능 신청만 준비하며 ads_management/business_management 등 권한을 추가하지 않는다. 실제 수집 token은 SYSTEM_USER, ads_read와 자동 기본 public_profile 두 권한이다. 사용자 프로필 정보는 id 이외 요청하지 않는다.
- 최종 검수 제출·약관 동의·사업자 자료·심사자 계정 제공이 나타나면 실제 요구 내용을 확인하고 각각의 승인 범위를 적용한다. 이 초안은 그러한 자료가 이미 준비됐다고 주장하지 않는다.

## 사용 사례 설명 초안

Daily Data Automation은 당사가 소유한 단일 광고계정의 광고 성과를 내부 보고 화면에 제공한다. SYSTEM_USER의 ads_read 권한으로 완료된 날짜의 광고/광고세트/계정 Insights 및 현재 캠페인/광고세트/광고 정보를 읽는다. 광고를 만들거나 수정하지 않으며 다른 사업자의 계정은 이 검증 범위에 포함하지 않는다.

정기 수집은 7일마다 직전 완료된 7일을 날짜별 한 번씩 읽도록 설계했다. 관리자가 완료된 하루를 명시한 수동 복구만 지원한다. 과거 기간 순환이나 호출 수를 늘리기 위한 조회는 하지 않는다. 서버의 암호화 credential 참조, 계정 allowlist, 동시 실행 lease와 페이지 완결 검증을 사용한다. 운영 스케줄은 아직 등록하지 않았다.

내부 화면은 지출·노출·링크 클릭을 표시하고, 광고/광고세트 비용을 중복 합산하지 않는다. 현재 상태·예산·일정을 과거 성과 시점 값과 구분한다. Meta가 제공하지 않거나 기여 설정 때문에 미확정인 구매/결과/영상과 파생 CPA·ROAS·마진은 확인 필요 사유로 표시한다. 실패·미수집·정상 0과 마지막 성공을 구분하며 신규 CSV 업로드에 의존하지 않는다.

## 확인한 증거와 미완료 자료

실제 보호 backend 인증 세 GET에서 앱/유형/권한/만료, debug user와 me 결속 및 광고계정 읽기를 확인했다. 10월1~7일 기본 지표 비교와 10월7일 하루의 비발행 API/metadata 완결 검증은 `07_대조결과.md`에 있다. 실제 canonical 발행 및 운영 활성화는 아직 하지 않았다.

공식 Limited 설명은 개발용 제한을 명시한다. 사용 방법 상세 양식은 500회 이상·오류율15% 미만 조건을 설명하고 **Marketing API Access Tier 테스트 상태를 녹색 완료됨으로 표시**했다. 따라서 이 화면의 테스트 요건은 완료 상태로 기록한다. 기능 호출 수24·ads_read40이나 이번 실행 수로 실제 15일 총 호출 수/오류율을 역산하지 않는다. 이 완료 표시는 Full 심사 승인과 별개이고, 자격을 맞추는 인위적 호출은 하지 않았다.

실제 인증 항목은 **인증된 비즈니스 포트폴리오 연결**을 요구하며 연결된 Patima group은 인증되지 않음이다. 전체 관리자가 사업자 인증을 진행해야 한다. 사업자번호/증빙/실제 법인명을 추정하거나 채팅으로 받지 않으며, 사용자가 공식 화면에 직접 입력할 수 있는지 확인 중이다.

실제 앱 설정 양식은 512~1024픽셀 정사각 아이콘(JPG/GIF/PNG,5MB 이하), 공개적으로 접근 가능한 개인정보처리방침 URL 및 앱 카테고리를 요구했다. 정책 URL/카테고리는 비어 있으며 다음 버튼에서 필수 오류가 확인됐다. 기본 설정에서 서비스약관/데이터 삭제 안내 URL도 비어 있었고 전체 앱 심사 안내는 데이터 삭제 URL을 포함한 설정 검토를 설명했다. 해당 두 URL이 이 티어의 개별 필수인지 아직 확인하지 않았다. 연락처는 기존 값이 표시됐고 기록/변경하지 않았다.

허용 용도 양식은 기능 사용 방식·앱 사용자 가치·필요한 이유의 자세한 설명과 허용되는 사용 동의를 요구한다. 설명란을 입력/저장하거나 동의 checkbox를 선택하지 않았다. 최종 제출 버튼은 비활성이다. 공개 정책 게시·심사자 계정 생성·기존 앱 설정 변경·최종 제출은 이 초안 추가 승인으로 실행하지 않는다.

## 15:50 KST 추가 확인

사용자가 직접 인증할 위치는 [Patima group 보안 센터](https://business.facebook.com/latest/settings/security_center?business_id=1307644100927401) → 비즈니스 인증 → ‘앱에 Meta for Developers 액세스 권한 필요’ 사용사례다. 화면에는 ‘인증 가능’과 비활성 ‘인증 시작’이 함께 있다. 원인은 확인되지 않았다. [공식 인증 절차](https://www.facebook.com/business/help/2058515294227817)는 포트폴리오 전체 관리 권한·법적 이름/주소/전화/웹사이트·필요한 증빙과 연결 확인을 설명한다. 현재 관리 권한이 원인이라고 단정하지 않는다. ‘권한 부여 및 인증’ 메뉴는 광고주 지역/업종 인증 목록이고 이 앱의 사업자 인증을 대신하지 않는다. 사업자 정보나 증빙은 입력·전송하지 않았다.

실제 데이터 처리 양식에는 (1) 플랫폼 데이터에 접근하는 처리자/서비스 제공업체, (2) 책임 사람/단체, (3) 국가, (4) 지난12개월 국가안보 관련 공공기관 요청에 응한 제공 이력, (5) 요청 적법성 검토·이의제기·최소화·문서화 절차가 있다. 코드만 보고 회사 관행을 추정해 답하지 않았고 모든 선택/입력은 비어 있다.

실제 검수자 지침은 ‘플랫폼을 먼저 추가’하라고 표시한다. 앱 기본설정의 플랫폼 추가 전에는 접근 양식이 없다. 플랫폼·심사자 계정·외부접근을 추가하지 않았다. 개인정보 URL 없음이라는 사용자 답변에 따라 [로컬 개인정보 초안](07_개인정보처리방침_초안.md)을 작성·독립 검토했으며 공개 게시/앱 URL등록은0이다.

사용자는 개인 내부용의 심사 부담과 심사 전 상태 유지 운영을 질문했다. 심사를 불허 또는 승인 확실로 예측하지 않는다. 자사 광고보고는 공식 사용 사례지만 Limited의 개발용 제한과 ads_read Standard permission은 별개다. 기술적으로 읽힌다는 사실을 정기 운영 허용으로 확대하지 않는다. 추가 심사 설정/제출을 보류하고 다른 공식 경로를 검토한다.

[Ads MCP 시작하기](https://developers.facebook.com/documentation/ads-commerce/ads-ai-connectors/ads-mcp-server/ads-mcp-server-get-started)(Updated2026-09-04)는 Meta 앱 소유가 전제 조건이 아니라고 안내한다. [공식 연결 도움말](https://www.facebook.com/business/help/1456422242197840)과 [보고 도구](https://developers.facebook.com/documentation/ads-commerce/ads-ai-connectors/ads-mcp-server/ads-mcp-server-tools-comprehensive-reporting)를 직접 읽었다. 대상 광고계정은 현재 BM의 MCP 관리 UI에 있고 기존 action 허용7/7이 표시된다. 실제 OAuth/MCP 호출·무인 서버 수집·전체 일별 필드·완결성은 미검증이다. 이는 심사를 우회해 기존 token을 운영해도 된다는 증거가 아니다. 신규 권한/연결은 아직 실행하지 않았다.

## 근거

- [Meta 권한 부여](https://developers.facebook.com/documentation/ads-commerce/marketing-api/get-started/authorization), Updated 2026-05-05: permission과 tier 구분 및 Limited의 개발용 범위.
- [Marketing API Access Tier](https://developers.facebook.com/documentation/development/features-reference#marketing-api-access-tier), Updated 2026-05-04.
- [2026-05-04 티어 변경 안내](https://developers.meta.com/blog/updates-to-ads-management-standard-access-feature/): Full 자격의 호출/오류율 조건.
- [자동 public_profile](https://developers.facebook.com/documentation/development/permissions#public_profile), Updated 2025-12-05.
- 로컬 확인 화면: `C:/Users/seong/AppData/Local/MetaAdsMetaIsolated/tier-review-confirmation-20261008.png`.
- 추가된 초안 요건: `C:/Users/seong/AppData/Local/MetaAdsMetaIsolated/tier-review-draft-added-20261008.png`.
- 실제 테스트 요건 완료 표시: `C:/Users/seong/AppData/Local/MetaAdsMetaIsolated/tier-review-requirements-20261008.png`.
