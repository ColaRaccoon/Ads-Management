# Cafe24 06 앱 API 버전 경계

Cafe24 공식 [버전 가이드](https://apidocs.cafe24.com/en/docs/guide/versioning)는 `X-Cafe24-Api-Version`을 생략한 호출이 개발자센터 앱의 **개발정보 → 인증정보 → 버전관리** 설정을 따른다고 설명한다. 2026-10-01 KST에 해당 테스트 앱의 화면은 `2026-09-01 Current Ver.`로 확인됐다. 같은 날 주문 count와 최소 목록은 `2026-03-01`, `2026-06-01` 헤더를 보낼 때 HTTP 400, 헤더만 생략할 때 HTTP 200이었다. 이는 요청 성공 여부의 실측이며 주문 필드·금액 의미의 검증은 아니다.

06 주문 GET은 버전 헤더를 보내지 않는다. 앱 설정값은 API 응답으로 자동 검증할 수 없으므로, canonical snapshot과 Cafe24 API 발행 전에 운영자가 화면의 현재 버전을 다시 확인하고 다음 **비밀이 아닌** 환경 변수에 기록해야 한다.

- `DAILY_SYNC_CAFE24_APP_API_VERSION=2026-09-01`
- `DAILY_SYNC_CAFE24_APP_API_VERSION_VERIFIED_AT=YYYY-MM-DD` (확인한 한국 날짜)

코드는 버전이 `2026-09-01`과 정확히 일치하고 확인일이 미래가 아니며 최근 30일 이내일 때만 canonical snapshot·발행을 허용한다. OAuth, 비발행 진단·probe·상태 건수·일별 summary는 이 관문 없이 조사할 수 있다. 앱 설정이 바뀌거나 30일이 지나면 버전 계약과 필드 의미를 재검토하고 코드·확인일을 갱신해야 한다. 환경 변수는 수동 확인의 기록일 뿐, 앱 설정의 이후 변경을 자동 감지하지 못한다.

API 원본 응답·주문 식별자·개인정보·토큰을 이 문서나 로그에 기록하지 않는다.

## 06 일회성 CSV 키 대조

이 절부터 옵션 이름/판매가 후보 절까지는 당시 **비발행 조사 이력**이다. 현재 적용 계약은 [06 계획](../../docs/daily-data-automation/06_카페24수집.md)의 v1.6과 아래 실제 하루 검증 절이다. 당시 진단의 `snapshotComplete=false`나 날짜별 CSV 비교는 그 진단의 범위이며 매일 새 CSV를 요구하는 발행 관문이 아니다. 공급자 수정시각이 없어도 완료된 주문일 하루의 두 번 전량 조회·품목 안정성·명시된 상태와 매핑·원천 충돌·원자 저장을 검증하여 관찰 snapshot으로 버전 저장한다. 관찰시각을 공급자 수정시각으로 바꾸지 않는다.

격리 수신기의 `/action`은 운영자 인증 후 `mode=hmac`, `day=YYYY-MM-DD`, `hmacKey`(로컬에서 매 비교 새로 생성한 32바이트 키의 패딩 없는 base64url)를 받는다. `hmac`·`date-hmac`은 먼저 HTTP 202와 무작위 `jobId`만 돌려준다. 같은 운영자 확인값·Origin·Host로 `POST /action-status`에 `jobId`를 보내면 실행 중에는 202 `RUNNING`, 완료 시 한 번만 200 결과, 검증된 실패 시 409 고정 오류 코드를 받는다. 작업은 서비스 메모리에 하나만 존재하고 결과는 12분 후 만료된다. 만료·재시작·연결 실패 후에는 새 키로 처음부터 비교해야 한다. 로컬 비교 스크립트는 10초 간격으로 최대 11분 폴링하며 비밀값·작업 ID·HMAC 배열을 출력하지 않는다.

`hmac`의 완료 결과는 `orderHmacs`, `orderItemHmacs`, `orderPaidHmacs`의 정렬된 SHA-256 HMAC 배열만 포함한다. 기존 비발행 summary와 같은 주문 건수·두 번의 목록 안정성·전품목 읽기 검사를 통과해야 응답한다. 품목 응답이 100건에 닿으면 완전성을 판단할 수 없어 실패한다. 응답은 `no-store`이고 128 KiB를 넘지 않는다. 품목 조회는 한 번에 최대 4건을 처리하고 시작 간격을 최소 500ms로 제한한다. 429는 제한된 후퇴만 수행하며 실패 시 부분 결과를 발행하지 않는다. Cafe24의 실제 호출·처리시간 한도는 별도로 준수한다.

로컬 CSV 측은 주문·품목 키를 trim하고 주문 결제액을 정확한 10진수 소수 2자리로 정규화한 뒤 같은 키로 계산한다. 각 HMAC 입력은 UTF-8 도메인 `cafe24-06-hmac-v1/order\0`, `cafe24-06-hmac-v1/item\0`, `cafe24-06-hmac-v1/paid\0` 중 하나에 이어, 각 문자열 부분의 UTF-8 바이트 길이를 4바이트 big-endian unsigned 정수로 적고 해당 바이트를 붙인다. `order`는 주문 ID 하나, `item`은 주문 ID와 품목코드, `paid`는 주문 ID와 정규화 결제액 두 부분이다. HMAC 결과만 메모리에서 집합 대조하고 일치·불일치 건수만 출력한다. 키·HMAC 배열·주문 ID·금액 원문을 파일·로그·문서에 저장하지 않는다. 이 검증은 일회성 동일성 대조이며 아래 실제 하루 snapshot 발행 검증을 대신하지 않는다.

## 06 결제 차이 6건 비발행 조사

로컬 메모리에서 **비교 실행마다 새 32바이트 키**로 `mode=hmac`, `day=2026-09-30`을 실행해 CSV/API 주문별 결제액이 다른 6개 주문을 식별한다. 완료 결과의 `orderHmacs` 중 해당 6개만 별도 `mode=paid-diagnose`, `day=2026-09-30`, `hmacKey`(같은 실행의 키), `orderHmacs`(6개 소문자 hex digest를 쉼표로 연결)에 보낸다. `/action`의 기존 운영자 확인값, 정확한 Origin·Host, 분당 호출 제한이 그대로 적용된다. 키·digest·주문 ID·금액은 로컬 메모리에서만 다루고 URL, 파일, 로그, 채팅, 문서에 쓰지 않는다.

이 과정을 로컬 PowerShell 7에서 `pwsh -NoProfile -File deploy/cafe24-test/compare-paid-differences.ps1 -CsvPath <로컬 CSV 절대 경로>`로 실행한다. 스크립트는 작업 폴더 밖 DPAPI 운영자 확인값을 같은 Windows 사용자로 복호화하고, 비교 실행마다 새 키를 생성해 HMAC 대조와 6건 진단을 한 프로세스에서 수행한다. 먼저 주문·품목 HMAC 집합의 전건 일치, CSV 주문별 결제액 일관성, 양방향 결제 차이 정확히 6건을 확인한다. 하나라도 실패하면 상세 API를 호출하지 않는다. 실행 전 로컬 파서만 확인하려면 `-CsvPreflight`, 합성 함수 검증은 `-SelfTest`를 사용한다. 표준 출력은 주문·품목·차이 건수와 진단 집계 또는 고정 실패 범주만 포함한다. 스크립트는 별도 Railway 이미지의 allowlist 빌드 컨텍스트에 포함되지 않는다.

새로 추출한 같은 날짜 CSV에서 차이의 변동 여부만 보려면 같은 명령에 `-CompareOnly`를 붙인다. 이 모드는 주문·품목 HMAC 집합이 모두 일치해야 성공하며 주문별 결제액의 일치·차이 **건수**만 출력한다. 차이가 0건이거나 기존 6건과 달라도 비교 결과를 반환하고, Order detail과 paymenttimeline은 호출하지 않는다. 기본 모드의 정확히 6건 관문과 상세 진단 동작은 유지된다. 새 CSV의 추출 시각과 API 캐시 신선도는 별도로 확인해야 하며 건수만으로 차이 원인을 확정하지 않는다.

서비스는 전체 날짜의 주문 건수·2회 목록·전품목 안정성 확인 뒤 선택한 6건만 Order detail과 paymenttimeline을 읽는다. 응답은 필드 존재·형식, 결제 단계 코드 O/R/P/기타의 **합계 건수**만 담고 주문별 행·금액·시각·식별자를 담지 않는다. 선택 6건이 모두 없거나, 상세 금액이 같은 실행의 목록과 다르거나, timeline이 100행 경계에 닿으면 실패한다. 전체 진단은 10분, 각 응답 본문은 2 MiB, 결과는 128 KiB 이내로 제한한다. 응답의 `shapeReadComplete`는 구조적 조회 범위만 뜻한다. `semanticVerified`와 `snapshotComplete`는 항상 false다.

같은 응답은 timeline의 **기록 생성 시각** `created_datetime`만 2026-10-01 KST 08:00 전, 08:00 이상 10:00 미만, 10:00 이상, 판독 불가로 나눈 건수를 추가한다. O/R/P 등 단계 유형별 건수와 10:00 이상 기록이 있는 주문 **수**도 합계로만 제공한다. 명시적 UTC/offset과 시간대 없는 값을 구분해 센다. 시간대 없는 값은 해당 몰의 `Asia/Seoul` 설정을 적용한 가정으로 표시하며, 금액·주문별 시각·주문별 유형 조합은 제공하지 않는다. 이 필드는 결제 발생 시각이 아닌 기록 생성 시각이므로 그 자체로 결제 차이의 원인을 증명하지 않는다.

공식 Detail·Paymenttimeline API에 캐시가 켜져 있고 실제 응답 필드 의미는 아직 실증 전이다. CSV 파일의 생성/수정 시간도 내보내기 시각의 증거가 아니다. 따라서 진단은 시간상 선후나 차이 원인을 판정하지 않고 `localFileMtimeComparison=NOT_ASSESSED_CACHE_UNVERIFIED_AND_MTIME_NOT_EXPORT_TIME`으로 답한다. 이 결과로 canonical 데이터를 발행하지 않는다.

## 06 주문일·발주일 비발행 대조

`compare-paid-differences.ps1 -CsvPath <로컬 CSV 절대 경로> -Day 2026-09-30 -CompareDates`는 주문·품목 키 전건 대조를 먼저 확인한 뒤 새 임시키로 `date-hmac`을 호출한다. `-Day 2026-09-21`도 지원한다. CSV의 `발주일`이 있는 주문에 대해 API `order_date`와 `place_date`의 한국 날짜 및 시각 일치 **건수**만 출력한다. 날짜가 빈 CSV 주문 수, API 발주일 존재 수, 시간대가 없는 API 문자열을 쇼핑몰의 `Asia/Seoul`로 가정한 수를 별도로 표시한다. 주문 ID·원문 날짜·HMAC 배열·키는 출력·저장하지 않는다. Cafe24 문서상 `date_type=order_date`와 `place_date`는 별개이므로 일치 건수 없이 두 필드를 동일시하지 않는다. 이 검사도 캐시 신선도나 canonical 발행 가능성을 증명하지 않는다.

## 06 변경 주문 관찰 경계

격리 서비스의 `observe`는 하루의 주문·품목을 두 번의 목록/건수 검사와 전품목 확인 뒤 읽는다. 연결의 보호 키에서 HKDF로 분리한 HMAC으로 주문 키와 허용된 업무 필드의 내용 지문을 만들며, 원문 주문번호·상품명·옵션·금액·구매자 정보는 관찰 테이블에 저장하지 않는다. 주문별 revision과 날짜 checkpoint를 한 트랜잭션에서 갱신하고, 실패·누락·키 버전 불일치 시 이전 성공 관찰을 보존한다. 해당 하루를 다시 읽었을 때 내용 차이를 관찰했다는 증거이며 공급자 수정시각이나 최신성 보증이 아니다. `snapshotComplete=false`를 유지하고 canonical current/version/source·매출·coverage에는 쓰지 않는다. 격리 DB의 추가 테이블은 `observe-additive.sql`에 정의되어 있으며 대상 프로젝트·환경·DB 확인 전에는 적용하지 않는다.

로컬 PowerShell 7에서 `pwsh -NoProfile -File deploy/cafe24-test/compare-paid-differences.ps1 -ObserveOnly -Day 2026-09-30`으로 실행한다. `-Day 2026-09-21`도 허용한다. 이 모드는 CSV 경로를 받거나 CSV를 읽지 않으며 HMAC 비교 키를 만들지 않는다. 작업 폴더 밖의 기존 DPAPI 운영자 확인값을 사용한다. 인증된 `/action`은 먼저 202와 작업 ID를 반환하고, 스크립트는 같은 인증·Origin·Host로 `POST /action-status`를 폴링해 완료 결과를 한 번만 받는다. 표준 출력은 `observedOrders`, `newOrders`, `changedOrders`, `unchangedOrders`, `snapshotComplete=false`의 검증된 합계 또는 고정 실패 범주뿐이며 작업 ID·주문 식별자·지문·원문 금액을 내보내지 않는다.

폴링 응답이 유실·만료되거나 서비스가 재시작되면 **DB 반영 여부를 실패로 단정하지 않는다.** 격리 DB에서 해당 날짜 checkpoint 존재 및 `order_count`/`item_count`의 합계만 확인하거나, 같은 날짜를 `-ObserveOnly`로 다시 실행한다. 동일한 관찰 내용의 재실행은 새 current revision을 만들지 않지만 관찰 시각과 checkpoint는 갱신한다. 새 조회에서 변경 건수가 나오면 실제 변경 또는 앞선 결과 유실을 별도로 조사하고, 두 실행의 시점·캐시 신선도를 검증하기 전 원인을 단정하지 않는다. 작업 중에는 다른 heavy action을 시작하지 않으며, 12분 결과 TTL이 지나도 선행 작업이 끝날 때까지 단일 실행 잠금이 유지된다.

## 06 주문 상세 필드 형태 조사

공식 [주문 상세 조회](https://apidocs.cafe24.com/docs/admin/get-orders-by-order-id)는 `GET /orders/{order_id}`, `READ_ORDER`, 캐시 적용을 명시한다. 목록 실응답에서 빠진 `updated_date`와 `order_status`가 상세 응답에는 있는지 확인하려면 로컬 PowerShell 7에서 `pwsh -NoProfile -File deploy/cafe24-test/compare-paid-differences.ps1 -ProbeDetailFields -Day 2026-09-30`을 실행한다. 9/21도 허용하며 CSV 경로·원본 데이터 파일·HMAC 키는 사용하지 않는다. 기존 DPAPI 운영자 확인값과 정확한 Origin·Host 검사를 거친 `/action`의 `detail-fields` 모드만 호출한다.

요청은 해당 날짜 목록의 최대 1건에서 `order_id,shop_no`를 읽고, 동일 주문 상세에 `order_id,shop_no,updated_date,order_status`만 요청한다. 결합 상세 요청이 400/422일 때에만 두 필드를 각각 한 번 더 요청한다. 전체 최대 4 GET/30초이며 인증·권한·rate limit·서버 오류, ID/숍 결속 실패, 잘못된 JSON에서는 추가 상세 호출을 멈춘다. 표준 출력은 단계별 HTTP 상태·고정 응답 범주·필드의 `absent/null/string/...` 형태와 `semanticVerified=false`, `snapshotComplete=false`뿐이다. 주문 ID·필드 값·원본 응답·provider 메시지·URL은 출력·저장하지 않는다. 캐시가 적용된 한 주문의 형태 확인은 전체 주문의 수정 감지나 최신성, canonical publish 근거가 아니다.

## 06 비발행 금액 구조 집계

먼저 기존 CSV의 기록된 SHA-256을 확인하고, `pwsh -NoProfile -File deploy/cafe24-test/compare-business-csv.ps1 -CsvPath <로컬 CSV 절대 경로> -Day <명시한 완료 주문일> -ExpectedSha256 <기록된 SHA-256>`로 주문별 금액을 한 번만 합산한다. 이 도구는 허용 열만 계산에 사용하고 주문/품목 식별자·결제수단 문자열·원본 행을 출력하지 않는다. 1~9주문 날짜의 금액 출력은 억제한다.

격리 서비스에서 `pwsh -NoProfile -File deploy/cafe24-test/compare-paid-differences.ps1 -BusinessAggregate -Day 2026-09-30`을 실행하면 인증된 202 작업이 목록·품목을 두 번 읽어 내용 지문을 검증한 뒤 주문·품목 건수, 주문별 결제액, 상품가×수량, `order_price_amount` 존재 건수, 결제수단 배열 길이와 품목 상태 접두 건수만 반환한다. 1~9주문 날짜는 집계를 반환하지 않는다. `order_price_amount`가 전건 부재면 표시된 합계 0은 실제 0원이 아니다. 상태 접두를 취소/반품 확정 의미로 해석하지 않으며 할인·쿠폰·배송비·환불 의미, 공급자 캐시 최신성, canonical 발행 가능성은 모두 미검증이다. 한 번에 **하루만 명시**해 실행하고 실패·부분 응답을 정상 0으로 기록하지 않는다.

## 06 옵션·판매가 비발행 업무 키 대조

`compare-paid-differences.ps1 -CsvPath <9/30 로컬 CSV 절대 경로> -Day 2026-09-30 -CompareOptions`는 CSV의 주문번호·품목번호로 결속한 상품번호·수량·판매가·`주문상품명(옵션포함)`을 비교 실행의 임시키 HMAC으로 만든다. `option-compare`는 이 지문만 받고 동일한 202→인증된 폴링 경계에서 API Items 전건을 읽는다. 주문/품목 전체 identity가 양방향 일치하고 두 번의 읽기 검사까지 성공해야 합계 건수만 반환한다. 원문 상품명·옵션·개별 주문/품목·금액·HMAC 배열은 응답·로그·문서·fixture에 남기지 않는다. 로컬 구조만 확인할 때는 `-CompareOptions -CsvPreflight`를 사용한다.

결과는 상품번호·수량, API `product_price`와 CSV 판매가, 값이 있는 부호 포함 `option_price`를 더한 후보의 일치 건수를 분리한다. 옵션 이름은 API `option_value`, `product_name`, 그리고 정해 둔 세 가지 단순 연결 문자열과 CSV 옵션 포함 상품명의 **후보별 일치 건수**로만 본다. 후보가 모두 불일치해도 임의 변환이나 원가 매핑을 만들지 않는다. 옵션 가격의 ABSENT/NULL을 0으로 바꾸지 않고 VALUE와 구분하고, VALUE는 음수/0/양수 건수만 반환한다. 미지원 가격 형식은 고정 범주 409로 전체 비교를 중단한다. Cafe24 문서는 `product_name`·`option_value` 및 `product_price`·`option_price`를 별도 필드로 정의하고 [음수 옵션 추가금액도 허용](https://support.cafe24.com/hc/ko/articles/18837026072089-%EB%8F%85%EB%A6%BD%EC%84%A0%ED%83%9D%ED%98%95-%EC%98%B5%EC%85%98-%EA%B4%80%EB%A0%A8-%EC%9E%90%EC%A3%BC-%EB%AC%BB%EB%8A%94-%EC%A7%88%EB%AC%B8)하지만 CSV 출력의 보편적 결합·가격 공식은 확인되지 않았다. 9/21·9/30 실제 표본 696품목에서는 CSV 판매가=`product_price`, CSV 옵션 포함 상품명=`product_name(option_value)`가 전건 일치했다. 이 진단은 `canonicalMappingVerified=false`, `snapshotComplete=false`이고 자동 발행·매출 보정 권한을 주지 않는다.

## 2026-10-06 비발행 조사 이력

위 9/30 초기 6건 진단은 당시 CSV에 대한 과거 기록이다. 새 9/30 CSV의 API 결제액 차이 **3/348건만** 그 표본의 사용자 수용 예외이며 원인은 미확정이다. 사용자가 제공한 완료된 10/1 하루 CSV와 API에서는 주문·품목 키 422/422·477/477, 옵션/판매가 후보 477/477, 결제액 419/422가 일치했다. 10/1의 결제액 차이는 9/30 예외에 포함되지 않는다. 해당 날짜만 명시해 PowerShell **7**의 `pwsh`로 `-CompareAmounts`를 실행할 수 있다. 이 모드는 CSV 총액/결제액·정확 쿠폰 토큰과 API 중첩 현재/최초 금액 및 공개 문서 기반 배송비 후보의 주문별 임시키 HMAC 일치 건수만 반환한다. 작은 쿠폰 하위 집계와 차집합은 억제하며 `semanticVerified=false`, `snapshotComplete=false`다. 결과의 [06 대조](../../docs/daily-data-automation/records/06_대조결과.md)와 합성 PostgreSQL 발행·복구 [절차](../../docs/daily-data-automation/06_합성_Postgres_검증.md)를 따른다. 당시 비발행 조사는 실제 canonical 발행이나 API primary 전환을 입증하지 않았다. 현재 v1.6의 공급자 금액 원천 선택·전량 품목 projection·발행·복구 검증은 아래 실행 경로를 따른다. 쿠폰 정답이나 CSV/API 금액 완전 일치를 발행 관문으로 삼지 않는다.

## 06 실제 하루 발행·복구 검증 경로

위 비발행 조사는 당시 결과다. 최신 실행 경로는 `run-live-canonical.ps1`이며, 코드 준비와 합성 검증만으로 실제 발행이 입증되지는 않는다. 이 경로는 확인된 격리 callback·DB의 기존 단일 OAuth 저장소를 그대로 사용한다. 부모는 feature OFF이고 명시 실행의 자식 프로세스만 feature ON이다. 자동 예약·기간 확대·다른 날짜 조회는 없다. 대상 날짜는 `2026-10-01`로 고정되어 있다.

배포 전 `prepare-live-schema.mjs --sql`, 경계 테스트, `assemble.mjs`를 확인한다. `Precheck`는 Setup 이전 초기 6테이블의 컬럼·enum·unique index·FK·감사 CHECK·단일 credential owner를 읽는다. Setup 성공 뒤 22테이블 상태에서는 이 초기 inventory 검사를 다시 실행하지 않으며 `Inspect`로 상태를 확인한다. `Setup -AcknowledgeSetup`은 확인된 6테이블 위에 16테이블을 원자적으로 추가하고 기존 감사 CHECK를 SYSTEM/null 또는 USER/nonNULL로 명시 확장하며 사용자 FK를 RESTRICT로 추가한다. 기존 6테이블 전체 행은 DB 안에서 해시하여 전후 보존을 확인하고 최종 22테이블·RLS·필수 CHECK/index/FK/정책 중첩 방지 trigger를 확인한 후 commit한다. 실패하면 transaction rollback한다. 전체 앱 migration이나 credential dump·복제는 실행하지 않는다.

`Seed -CsvPath <승인된 CSV 절대 경로>`는 파일 hash와 477행을 검사한 뒤 주문·품목·상품·옵션·수량·판매가·총 주문금액·총 결제금액·결제수단·발주일 11열만 메모리로 전송한다. 원본의 다른 열은 전송하지 않는다. 원가·상품·쿠폰 규칙은 고정 운영 대상의 읽기 전용 export를 stdin/stdout 메모리로 전달하고 원문 날짜 문자열을 유지한 hash를 검증한다. 규칙은 관찰 시점의 설정이며 10/1 당시 불변 설정이라고 주장하지 않는다. 동일 hash 설정은 재사용하므로 CSV 실패 뒤 reset 없이 다시 진행할 수 있다. 발주일이 빈 CSV 행은 날짜를 채우지 않고 보존한다.

`Publish`는 실제 adapter·runner·foundation·canonical writer로 하루를 전량 저장한다. `Inspect`의 비식별 차이 건수와 `activationSnapshotDigest`를 검토한 후, `Activate -AcknowledgeSourceChoice -ExpectedSnapshotDigest <메모리의 digest> -ExpectedInputDifferencesJson <검토한 건수 JSON>`로 API 입력을 선택한다. 서비스는 같은 성공 snapshot을 잠금 아래 다시 확인한다. 금액 완전 일치나 쿠폰 정답은 관문이 아니다. 공식 쿠폰 표시와 선택한 공급자 금액 입력에 내부 쿠폰 규칙을 대조하며 포인트·할인 잔차를 쿠폰이라고 확정하지 않는다.

CSV primary의 `Seed/Inspect`와 API primary의 `Activate/Inspect`는 동일 매출·원가·쿠폰 계산 서비스의 `calculationEvidence`를 반환한다. 유효 날짜와 매핑으로 집계된 source 행수를 명시하고 빈 CSV 날짜 행은 기존 집계에서 제외되어 API 행수와 다를 수 있다. 광고비와 광고비 차감 후 전체 마진은 수집하지 않았으므로 null이다. 쿠폰 UNKNOWN 또는 원가 부족도 필요한 파생 금액을 null로 유지하고 1~9건 쿠폰 상태는 억제한다.

같은 하루 `Publish` 재실행은 새 성공 관찰과 내용 버전을 구분한다. `Failure`는 실제 품목 읽기를 부분 실패시켜 이전 current·버전·link·lastSuccess를 보존하는지 확인한다. `Rotate -AcknowledgeTokenRotation`은 만료 임박 refresh를 거절하고 기존 token pair를 실제 회전한다. `Revoke -AcknowledgeTokenRevocation -RegisteredRedirectVerifiedAt <사용자 확인 시각>`는 등록된 격리 redirect 및 재연결 준비를 확인한 뒤에만 실행한다. 실제 철회 뒤 일반 runner의 인증 실패와 기존 성공 보존을 확인하고, 사용자 OAuth 동의 재연결 뒤 같은 하루를 명시 수동 발행하여 복구를 확인한다. 이전 token pair를 복원하지 않는다.

정상 종료는 자식을 중단한 후 enabled=false 복원을 기다린다. abrupt kill 뒤 enabled=true가 남으면 신규 발행은 중단된다. 현재 배포의 단일 인스턴스를 다시 확인한 운영자만 `Recover -AcknowledgeEnableRecovery -SingleInstanceVerifiedAt <확인 시각>`로 연결 잠금·12분 idle·credential owner idle·active lease 없음 조건에서 enabled만 false로 복구한다. auth 상태·token·실행·기존 성공은 변경하지 않는다. 이미 false이면 읽기만 하는 no-op이다. 자동 시작 복구는 없다.

wrapper는 DateKind String을 지원하는 PowerShell을 사용하며 고정 HTTPS·Origin·operator 인증·bounded async job을 이용한다. 비밀·주문 원문·원문 예외를 출력하지 않고 허용된 집계만 반환한다. 격리 자원과 기존 작업 폴더 밖 DPAPI 파일은 보존하며 삭제 계획은 12단계에 남긴다. 실제 실행과 평가 증거가 없으면 06을 DONE으로 바꾸지 않는다.

`Precheck`의 `checkedInSchemaDigest`와 로컬 `live-additive.sql` SHA256를 검토하여 `Setup -AcknowledgeSetup -ExpectedSchemaDigest <검토한 digest>`에 명시 전달한다. 서버도 같은 정적 SQL digest를 비교한다. `StatusEvidence`는 기존 async 비발행 집계에서 전체 422주문·477품목 읽기를 확인한 뒤 정렬된 공개 A–Z 접두사와 숫자 두 자리 상태 코드 집합만 반환하고 금액·상태 하위 건수는 출력하지 않는다. 형식 밖 코드·누락은 거절한다. 관찰은 E/U 등의 코드도 허용하며 발행 승인과 분리한다. 현재 발행 승인에는 N/C/R 접두사와 명시 검토한 E00 하나만 허용한다. E10/E99/U 등의 다른 코드는 승인되지 않는다. 운영자가 공식 상태 의미와 전량 v1 포함 정책을 검토한 후 `Publish/Failure`에 `-ApprovedStatusCodesJson <검토한 코드 배열 JSON> -ProjectionVerifiedAt <확인 시각> -AcknowledgeV1Projection`을 명시 전달한다. 자식에만 신규 `RAW_ALL_ITEMS_V1_VERIFIED` 계약과 상태 집합이 전달된다. 코드 집합 관찰 자체를 승인으로 바꾸지 않고, 구 CSV parity flag를 재사용하지 않는다.

### 06 격리 설정 날짜 정정

읽기 전용 설정 exporter는 PostgreSQL DATE를 `YYYY-MM-DD`로, Prisma timestamp without time zone을 UTC로 보존한다. 기존 KST 해석으로 앞당겨 저장된 격리 설정만 `RepairConfigurationDates -ExpectedConfigurationDigest <fresh Inspect의 configurationStateDigest> -AcknowledgeConfigurationDateRepair`로 명시 정정한다. 원본 exporter 소스 `.v1.cjs`와 기존 DPAPI는 작업 폴더 밖에 보존한다.

정정은 동일 transaction에서 연결·4개 설정 테이블의 행·477개 CSV 행을 잠근다. source fingerprint, 그룹별 고유 ID와 정확한 ID 집합, 모든 비날짜 값, 기존 날짜의 확인된 편차, DATE 65개·createdAt 37개를 확인한다. 공급자의 정상 날짜로 해석한 공통 규칙과 공통 matcher를 써서 CSV 477행의 product/rule/source/status/validationErrors가 모두 동등한 경우에만 설정 날짜를 쓴다. 차이가 있으면 쓰기 없이 거절하며, 보호 digest와 양쪽 소규모 집계를 억제한 변경 건수만 반환한다. 자동 rematch는 없다. 실제 차이가 있으면 운영자가 그 범위를 검토한 뒤 별도 계획으로 처리한다.

정정 후 같은 transaction에서 모든 설정 값과 기존 CSV·batch·credential 내용 보존을 다시 검사하고 USER 감사 기록을 남긴다. 원본 CSV 날짜·키·수량·금액·source·버전을 고치지 않는다. 로컬 합성 PostgreSQL 데이터와 실행 스크립트는 12단계 삭제 계획까지 보존한다.

### 비식별 실패·인증 진단

`Inspect`는 실행 건수와 상태 집합, 유일하게 식별 가능한 마지막 startedAt 실행의 상태·허용된 safeCode, 품목 단위 상태, lease 존재/활성 여부를 반환한다. 실행 원문 목록은 최대 두 후보만 읽고 startedAt 동률이나 시작 시각 부재로 마지막 실행을 결정할 수 없으면 `AMBIGUOUS_RUN_ORDER`로 표시한다. 원문 실행 ID·reason·checkpoint·주문 키·공급자 요청 ID는 출력하지 않는다. 연결의 `connectionAccessState`, `connectionEnabled`, access/refresh 순서의 revision 두 값도 반환한다. 토큰이나 expiry는 반환하지 않는다.

공급자 필드 실패는 coverage 경고에 저장된 고정 `CAFE24_FAILURE_DIAGNOSTIC_CODES` 한 개만 `providerFailureDiagnosticCode`로 반환한다. 임의 공급자 값은 진단 코드에 넣지 않는다. 부모 입력 승인·연결 활성화·복원과 자식 timeout·종료 signal·빈 출력·JSON 및 결과 스키마 거절은 별도 고정 범주로 구분한다. 오류 원문과 stderr는 폐기한다. 확인 시각은 서버보다 미래이면 승인되지 않으므로 관찰 후 명시 검토한 과거 시각을 그대로 전달한다. 첫 실패에 진단이 없었다는 사실만으로 시간 차이나 프로세스 종료 원인을 확정하지 않는다.


### API 버전 옵션 조합 저장 용량 정정

06 입력 검증은 개별 상품명·옵션 값을 각각 256자로 제한한다. 이 입력 계약에서 원형 조합 `product_name(option_value)`의 구현 상한은 괄호를 포함하여 514자다. 공급자의 공식 최대 길이라고 주장하지 않는다. 현재 주문 행의 TEXT는 유지하고 API 버전의 `option_name`만 VARCHAR(256)에서 VARCHAR(514)로 확장한다. 원문을 자르지 않는다. 신규 격리 Setup은 514 스키마를 만들고 일반 `Inspect/Publish`는 514를 요구한다.

기존 22테이블의 256 상태는 `OptionCapacityPrecheck`로 별도 검사한다. 반환된 `optionCapacitySchemaDigest`를 검토한 뒤 `ExpandOptionCapacity -ExpectedSchemaDigest <그 digest> -SingleInstanceVerifiedAt <fresh 단일 인스턴스 확인 시각> -AcknowledgeOptionCapacity`로 명시 실행한다. 승인 문구는 `EXPAND_ISOLATED_06_DERIVED_OPTION_NAME_256_TO_514_ONLY`다. 부모 feature OFF, 연결 disabled, 기존 단일 idle credential owner, API 버전/행/link 0, CSV 477행, 실행 pending 0, active lease 0을 확인한다.

같은 serializable transaction에서 짧은 lock timeout과 정확한 22테이블 잠금을 사용하여 fresh catalog fingerprint를 다시 검증한다. 고정 ALTER 한 개를 실행하고 컬럼 변경 외 catalog 동일성과 22테이블 전체 행의 DB 내부 digest 보존을 확인한 뒤 commit한다. 실패하면 rollback하며 토큰·CSV·설정·실행 행을 수정하지 않는다. 초기 6테이블 Setup이나 전체 migration은 다시 적용하지 않는다. 이 모드는 격리 대상에만 존재하며 운영 DB는 변경하지 않는다.


활성화 거절은 기존 `SOURCE_SELECTION_REQUIRED`를 유지한다. 격리 자식의 `CHILD_ACTIVATE`에서 내부 `Cafe24ActivationRejected` 클래스가 가진 정확한 `CAFE24_ACTIVATION_GUARDS` 코드만 `diagnostic.guard`로 반환한다. snapshot·policy·coverage·run·mapping·원본 입력·link/version·차이 검토 검사 위치를 구분하며 임의 오류 속성·message·주문 원문은 출력하지 않는다. 이 진단을 추가해도 승인 검사와 WARNING 처리 규칙은 바꾸지 않는다.

성공한 현재 API 477행·현재 버전 477개가 있으면 `allProviderOrderStatusesAbsent`는 저장된 현재 버전의 주문 수준 orderStatus가 전부 NULL인지 boolean으로만 표시한다. 완전한 성공 snapshot이 없으면 null이다. 개별 주문 상태나 소규모 상태 건수는 반환하지 않는다. 기존 `nullProviderUpdatedLines`와 함께 공급자 필드 부재를 확인하며 관찰시각을 공급자 수정시각으로 바꾸지 않는다.


상품명 표시 차이를 선택하는 경우 `inputDifferences`와 명시 승인 입력은 `totalOrderOrders`, `paidOrders`, `paymentMethodOrders`, `couponSignalOrders`, `productNameOrders`의 다섯 필드다. 상품명 차이는 주문별 한 번만 집계하며 name/coupon 1~9건은 NULL로 억제한다. NULL 승인 입력은 그 고정된 snapshot 안에서 실제 내부 건수가 1~9인 경우에만 일치로 확인한다. 나머지 세 건수는 0~422 정수이며 NULL로 승인할 수 없다.

운영자가 새 `Inspect`의 다섯 건수와 보호 HMAC을 검토하고 기존 명시 source-choice ACK를 전달하면 서비스가 잠금 아래 다시 비교한다. 상품명 차이는 `DISPLAY_FIELD_DIFFERENCE_REVIEWED`로 감사하며 이름 완전 일치나 원인 확인이라고 표시하지 않는다. 주문/품목/상품/옵션 키·수량·판매가·product/rule mapping·link/version 검사는 유지한다. 검토 없는 이름 차이와 CSV 없는 API_ONLY에서 이름 차이 승인 입력은 허용하지 않는다.
