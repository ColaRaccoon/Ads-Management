# Cafe24·Meta API 비용 및 이용 자격 조사

조사일: 2026-09-21. 범위는 현재 프로그램의 Cafe24 주문 CSV와 Meta 광고 성과 CSV를 대체할 읽기 API다. 공개 공식 문서를 조사했으며 실제 계정 로그인, 앱 등록·심사 신청, 고객센터 문의 발송은 하지 않았다.

## 비용 판단

두 서비스의 해당 API 안내에서 가입비·월정액·호출당 과금표 또는 유료 구독 의무를 확인하지 못했다. 따라서 현재 설계에서 별도의 유료 API 상품 구매를 선행조건으로 둘 근거는 없다. 다만 **요금표가 없다는 사실만으로 무료를 확정할 수는 없다.** 이번 조사에서는 해당 읽기 API가 무료임을 명시한 최신 공식 문구까지 확보하지 못했다. 계약·예산 확정에는 아래 문의안으로 무과금 여부를 서면 확인하는 것이 남아 있다.

| 항목 | Cafe24 Admin API | Meta Marketing API / Insights |
|---|---|---|
| 기본 읽기 API 요금 | 공개 호출당·월정액 요금표 미확인 | 공개 호출당·월정액 요금표 미확인 |
| 유료 API 플랜 구매 의무 | 조사 문서에 없음 | 조사 문서에 없음 |
| 호출 한도 | 요청 수와 사용량 제한, 초과 시 일시 제한 | 권한과 별도 API 티어에 따른 제한 |
| 한도 초과 자동 과금 | 근거 미확인. 429 처리와 재시도 필요 | 근거 미확인. 사용 제한과 접근 등급 관리 필요 |
| 다른 비용 | 서버·DB·개발·유지보수, 외부 연동 솔루션 구매 시 해당 비용 | 서버·DB·개발·유지보수, 외부 연동 솔루션 구매 시 해당 비용 |
| 혼동하기 쉬운 비용 | 앱스토어에서 앱을 판매할 때 수수료 | 실제 광고 집행 비용 |

Cafe24가 안내하는 20% 수수료는 앱 판매대금의 수익 배분이다. 주문 API로 자사 매출을 읽는다는 이유로 쇼핑몰 매출의 20%를 내는 구조가 아니다. Meta 광고비 역시 광고 성과를 조회하는 호출 요금과 구분해야 한다. [Cafe24 공식 FAQ](https://developers.cafe24.com/ko/cs/front/faq), [Meta 시작 가이드](https://developers.facebook.com/documentation/ads-commerce/marketing-api/get-started)

운영비 산정 제안: 기존 서버에서 수집기를 함께 실행하면 추가 인프라 비용은 작을 수 있다. 별도 서버, DB 용량, 백업, 모니터링을 구매하면 비용이 생긴다. 데이터량과 배포 환경이 정해지지 않았으므로 월 금액은 산정하지 않았다.

## Cafe24 자격·승인

- 개발자 가입은 개인도 가능하다. 사업자등록번호가 없는 개인의 가입·판매 경로를 공식 FAQ가 안내한다. 개발자 계정과 쇼핑몰 운영 권한은 별도로 확보해야 한다.
- 재확인 보완: 고객센터 FAQ는 개인개발자에게 개인정보 취급권한을 부여하지 않는다고 명시한다. 따라서 개인 가입 가능 여부와 개인정보 API 사용 자격을 반드시 구분해야 한다. 서약서 제출만으로 개인개발자의 개인정보 권한 취득이 가능하다고 해석해서는 안 된다. [개인개발자 개인정보 권한 FAQ](https://developers.cafe24.com/ko/cs/front/faq)
- 앱을 등록하고 Client ID/Secret, 앱 URL, Redirect URI, 필요한 권한을 설정한다. 쇼핑몰 운영자가 OAuth 설치·접근에 동의해야 한다.
- **자사몰 5개 이하만 이용한다면 파트너센터의 테스트설치 기능으로 별도 앱 심사 없이 이용할 수 있다.** FAQ가 이 사용 방식을 명시한다. 단순 추정이나 테스트 기능의 편법 사용 제안이 아니다.
- **6개 이상 설치하려면 정식 출시(판매중 상태)가 필요하다.** 비공식 출시 또는 테스트 한도 상향 경로는 없다고 안내한다. 특정 회사만 사용하게 할 때는 설치 자체를 제한하는 대신 서비스 안에서 별도 인증하도록 설명한다.
- 앱 심사는 평균 영업일 3~5일이라고 안내하지만 복잡도와 보완에 따라 달라진다.
- 회원 개인정보 Customersprivacy API는 자사몰이라도 별도 허용이 필요하다. 개인정보취급 서약서와 대표자 또는 개인정보 보호책임자 서명이 요구된다. 모든 주문 조회에 이 추가 절차가 일괄 적용된다는 뜻은 아니다.
- 특정 클라이언트 전용 API는 Client ID, 대상 API, 사용 사유를 기재하여 별도로 신청한다.

근거: [개발자 가입·판매 FAQ](https://developers.cafe24.com/ko/cs/front/faq), [앱 서비스 FAQ — 앱 제작/심사/운영 및 API/SDK 탭](https://developers.cafe24.com/ko/app/front/common/concepts/appservicefaq).

현재 프로그램은 `mall.read_order`로 주문·품목·환불 데이터를 우선 검토한다. 상품 매핑이 필요한 경우에만 `mall.read_product`를 추가한다. 고객 이름·전화번호·주소를 분석에 쓰지 않는다면 수집하지 않는 설계가 적합하다. 토큰 갱신, 응답 한도 준수, 버전 업데이트가 지속 운영 조건이다. [Admin API](https://developers.cafe24.com/docs/api/admin/), [개발자 약관](https://developers.cafe24.com/terms)

무단 앱 삭제 공지는 등록 정보·인증 절차·운영정책 준수 필요성을 보여준다. 이를 자사몰 5개 이하 이용에 무조건 별도 계약이 필요하다는 근거로 해석하지 않는다. 공식 FAQ의 자사몰 설치 경로와 함께 읽어야 한다. [2025-04-02 공지](https://developers.cafe24.com/cs/front/notice/337)

## Meta 자격·승인

기본 준비물은 Meta 개발자 계정, 앱, 접근할 광고계정 ID와 계정 접근 권한, 적절한 권한을 가진 액세스 토큰이다. 앱 관리자·개발자 등의 역할과 광고계정에 대한 권한은 서로 다르다. 앱을 만들었다고 타인의 광고 데이터를 읽을 수 있는 것은 아니다. [시작 가이드](https://developers.facebook.com/documentation/ads-commerce/marketing-api/get-started)

### 두 종류의 등급을 구분해야 한다

| 구분 | 자사 계정 읽기 | 타사 계정 서비스 |
|---|---|---|
| API 권한 | 보고서 읽기는 `ads_read` | `ads_read` 및 계정 소유자 동의 |
| 권한 액세스 수준 | 자사 계정은 Standard Access로 충분하다고 명시 | Advanced Access와 앱 검수 필요 |
| 비즈니스 인증 | 앱 역할 사용자만 이용하는 경우 면제 경로 명시 | Advanced Access·외부 비즈니스 이용 시 인증된 비즈니스 연결 필요 |
| Marketing API Access Tier | 개발 단계 Limited Access, 운영 요건 별도 확인 | 운영용 Full Access 준비 |

**자사 계정의 권한 Standard Access가 충분하다는 말과 기본 API 티어로 무심사 영구 운영해도 된다는 말은 다르다.** 최신 권한 가이드는 Limited Access를 개발용으로, 실제 광고주 대상 프로덕션 앱용이 아니라고 설명한다. 다만 이번 구성은 자사 단일 광고계정의 내부 읽기 전용 앱이고 현재 앱의 `필요한 작업`에는 항목이 없다. 따라서 Full 신청을 현재 필수 조건으로 단정하지 않고, 계획된 호출량·내부 운영 허용 범위를 앱 대시보드와 공식 지원에서 먼저 확인한다. 실제로 Full이 요구될 때만 App Review·연례 검토를 계획한다. [공식 권한 가이드](https://developers.facebook.com/documentation/ads-commerce/marketing-api/get-started/authorization)

2026년 5월 공지에서 Ads Management Standard Access 기능명이 Marketing API Access Tier로 바뀌었다. 이 기능의 하위/상위 티어는 Limited/Full Access다. Full 신청 기준은 최근 15일 Marketing API 호출 500회 이상 및 최근 500회 오류율 15% 미만이다. 상위 티어 신청을 위한 화면 녹화 제출은 폐지되었다. 이것이 다른 권한의 App Review 제출자료까지 모두 면제한다는 뜻은 아니다. 호출 수는 요금이나 최소 광고비가 아니라 사용 실적 조건이다. [2026-05-04 공식 변경 공지](https://developers.meta.com/blog/updates-to-ads-management-standard-access-feature/)

### 비즈니스 인증 및 실제 준비

인증이 필요한 경우 앱을 비즈니스에 연결하고 비즈니스 관리자가 인증을 진행한다. 앱 역할 사용자만 쓰는 경우 비즈니스 인증이 불필요하다는 예외도 공식 문서에 있다. 따라서 개인 개발자에게 일괄적으로 사업자등록이 필수라고 말할 수 없지만, 다른 회사 계정까지 제공할 서비스는 비즈니스 인증을 계획해야 한다. [비즈니스 인증 개발 문서](https://developers.facebook.com/documentation/development/release/business-verification)

인증을 위해 사업체의 등록 정보, 공식 주소·전화번호, 대표 권한, 회사 이메일 또는 전화 인증 혹은 도메인 확인을 준비한다. 실제 인정 서류는 국가·계정 및 검증 단계에서 지정되는 목록을 따른다. 유료 배지 서비스인 Meta Verified와 이 비즈니스 인증은 별개다. [비즈니스 인증 정보](https://www.facebook.com/business/help/1095661473946872)

우리 앱에는 광고 생성·수정 권한인 `ads_management`를 우선 요청할 이유가 없다. `ads_read`로 필요한 지표와 상태를 조회할 수 있는지 먼저 검증한다. 무인 운영에는 사용자 또는 시스템 사용자 토큰의 수명·갱신/재발급 경로, 광고자산 할당, 권한 철회 감지를 설계해야 한다. ‘만료 없음’ 토큰도 철회·계정 변경에 영향을 받을 수 있으므로 영구 접속 보장은 아니다. [Meta 공식 API 컬렉션](https://www.postman.com/meta/facebook-marketing-api/documentation/0zr4mes/facebook-marketing-api-mapi)

## 현재 앱의 실행 순서 제안

1. 연결할 Cafe24 몰 수와 Meta 광고계정의 소유자를 확인한다. 대행사가 관리 중이라는 사실만으로 자사 소유 계정이라고 판단하지 않는다.
2. Cafe24 앱 등록·자사몰 설치 동의, Meta 앱·광고계정 권한을 준비한다.
3. 두 API의 읽기 데이터로 짧은 기간을 수집해 기존 CSV와 금액·주문/품목 ID·통화·시간대·전환 기여기간을 비교한다.
4. Cafe24 토큰 갱신, Meta 운영 등급과 인증, 호출 제한을 해결한 뒤 예약 수집을 붙인다.
5. 최초 동의·심사·예외 발생 시 재인증은 사람이 하고, 일상적인 다운로드와 업로드는 자동화한다.

## 공식 확인이 남은 사항과 문의 초안

아래는 준비한 문의 문구이며 발송하지 않았다. 비용 자체의 공식 명시를 확보하지 못한 점을 숨기지 않기 위한 확인 항목이다.

**Cafe24 개발자센터 문의:**

> 자사몰 N개의 주문/주문품목/취소·환불 데이터를 사내 분석 프로그램으로 정기 조회하려 합니다. Admin API의 mall.read_order 권한으로 테스트설치 경로를 사용할 예정입니다. 이 범위에 개발자 가입비, 앱 등록비, 월 이용료, API 호출·데이터량 과금 또는 별도 계약이 있는지 확인 부탁드립니다. 개인정보 Customersprivacy API는 사용하지 않을 예정입니다. 필요한 추가 권한·심사가 있다면 안내 부탁드립니다.

**Meta 개발자 지원 문의:**

> We are building an internal reporting app for ad accounts owned by our own business. We need ads_read and Insights reporting only. Please confirm whether there are any registration, subscription, API-call, data-volume, or access-tier fees. Please also confirm the required Marketing API Access Tier for unattended production reporting of our own accounts, and whether business verification or any additional review is required for this app configuration.

Meta의 개발자 지원 창구는 2026년 5월 공식 공지에서 광고비 규모와 관계없이 전체 개발자에게 확대되었다. [지원 안내](https://developers.meta.com/blog/whats-new-in-marketing-api-support/)

## 검증 범위

공식 웹 검색과 실제 브라우저의 공개 본문을 확인했다. Cafe24 FAQ의 동적 탭, Meta의 이전 URL에서 이동한 새 개발 문서와 Business Help 본문은 브라우저로 확인했다. 실제 사용자 계정의 승인 상태·특약·결제 조건은 확인하지 않았다. API 무료를 명시한 문구를 확보하지 못했으므로 ‘공식적으로 무조건 0원 확정’으로 보고하지 않는다.

## 2026-09-29 계정별 후속 확인

위 2026-09-21 조사 시점의 Cafe24 요금 미확정 판정은 아래 공식 파트너 답변으로 문의 범위에 한해 갱신한다. 2026-09-22 16:04 KST에 접수한 `자사몰 테스트 앱의 Admin API 이용 요금 문의`가 `답변완료(2026-09-22)`였으며, 로그인된 [Cafe24 Partners 문의/답변](https://partners.cafe24.com/admin/support/customer/front/index/app)에서 카페24 기술지원팀의 답변 원문을 2026-09-29 확인했다. 자사몰 **1개**에 테스트 앱을 설치하고 `mall.read_order`로 내부 일일 리포트를 자동화하는 경우 Admin API 자체의 별도 호출당 과금·월정액·유료 계약·최소 결제 조건은 없다. 앱 판매·스토어 출시 없이 이용할 수 있고 정해진 호출 제한은 준수해야 한다. 이는 추가 인프라 비용, 다른 권한·용도, 1개를 넘는 몰에 대한 포괄적 무과금 보증이 아니다. 이 시점에는 Meta API 비용이 미확정이었으며 아래 후속 판정으로 갱신한다.

같은 날 [Meta 비즈니스 지원 홈](https://business.facebook.com/business-support-home/)에서 AI 어시스턴트에 자사 광고계정 1개·`ads_read`·Limited tier 내부 일일 리포트의 API 자체 호출당/월정액/유료 계약 여부를 물었다. AI는 이용료가 없다고 안내했으나, 이는 사람 담당자의 계약·계정별 서면 확인이나 검증된 공식 요금 조항이 아니다. 사용자가 이메일을 직접 제출한 후 실시간 지원 채팅이 열렸고, 10:46 KST에 같은 질문의 전송을 시도했다. 자동 분류명이 `Set up or implement Conversions API`로 실제 문의와 달라 메시지 첫머리에 `Marketing API/Insights` 요금 문의임을 명시했다. Codex 앱 내 채팅에는 계속 `전송 중`이 표시되어 그 시점에는 실제 전달·담당자 답변을 확인하지 못했다. AI가 제시한 링크나 별도 계정 진단은 독립 검증 전 근거로 사용하지 않는다.

**후속 판정(2026-09-29):** 사용자가 제공한 Meta support 담당자 채팅 스크린샷에서 실제 답변을 확인했다. 담당자는 내부 Marketing API 개발 문서를 확인한 결과 API 사용 자체의 별도 비용이나 요금제 관련 내용이 없고, 별도 발생하는 비용은 광고 집행비라고 설명했다. 앞선 AI 답변이 아닌 **사람 담당자의 공식 지원 답변**을 근거로 자사 단일 광고계정·`ads_read` 내부 리포트 문의 범위의 API 자체 이용료를 **별도 없음**으로 갱신한다. 이 답변이 다른 계정·권한·판매형 앱의 비용까지 보증하지 않으며, 별도 유료 계약·최소 결제 조건을 직접 언급하지도 않았다. 담당자가 안내한 [Marketing API 개요](https://developers.facebook.com/documentation/ads-commerce/marketing-api/overview)는 접근 제한으로 요금 문구를 별도로 검증하지 못했으므로 지원 답변의 보조 링크로만 둔다. 스크린샷·연락처·대화 원문은 저장소에 복사하지 않았다.
