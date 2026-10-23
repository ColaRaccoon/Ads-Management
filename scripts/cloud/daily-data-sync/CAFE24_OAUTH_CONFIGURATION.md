# 08 Cafe24 OAuth 준비

`prepare-cafe24-oauth.ps1 -Mode Prepare`는 기존 06 callback 서비스 `deaaeaf9-ee5c-42fa-b32f-600c7a90befc`의 Railway 변수를 읽어 등록 앱 `tVV6DZtPOFRlpPk1ex7ISA`의 client ID와 secret을 메모리에서 확인한다. 기존 서비스·DB·pair를 쓰거나 token pair를 복제하지 않는다. 신규 08 서비스만 정확한 v4 소스·Supabase ref/schema/runtime·활성 feature·비활성 예약·3개 계정 allowlist·기본 launcher·sleep 설정을 확인한 뒤 아래 네 변수를 `skipDeploys=true`, `replace=false`로 준비하고 읽기 재확인한다.

| 변수 | 신규 08 값 |
|---|---|
| `DAILY_SYNC_CAFE24_CLIENT_ID` | 기존 승인 앱의 확인된 ID |
| `DAILY_SYNC_CAFE24_CLIENT_SECRET` | 기존 보호 변수에서 메모리로만 전달 |
| `DAILY_SYNC_CAFE24_ISOLATED_ORIGIN` | `https://phase08-daily-data-sync-production.up.railway.app` |
| `DAILY_SYNC_CAFE24_REDIRECT_URI` | 위 origin + `/backend-api/integrations/cafe24/oauth/callback` |

기존 06 origin/redirect, feature=false, mall/shop을 읽기 확인한다. 기존 신규 08 OAuth 설정이 이미 있으면 Prepare는 덮어쓰지 않는다. `-Mode Status`는 동일 값과 경계만 읽기 확인한다. 두 모드 모두 자동 redeploy, OAuth authorize, 주문 읽기를 수행하지 않는다. 보호 context·Railway token·client secret은 메모리에만 두고 결과에는 고정 enum과 건수만 출력한다.

실제 환경 적용은 루트 작업자의 별도 검토한 CLI up 후 확인한다. Partners의 callback 등록도 신규 08 URI로 별도 확인해야 한다. `DAILY_SYNC_CAFE24_TEST_ENABLED`는 feature=true인 이 경로에서 필요하지 않다. 앱은 `mall.read_order`만 요청한다. 운영 별칭의 callback을 활성화하는 `DAILY_SYNC_CAFE24_RAILWAY_CALLBACK_ENABLED`는 설정하지 않는다.

정상 authorize 시작은 보호 평가 계정의 `settings.manage`, 정상 cookie jar와 CSRF를 이용한 `POST /backend-api/cafe24/connections/<새 PENDING UUID>/authorize`다. 응답의 `authorizeUrl`에는 5분 일회 state가 있으므로 공개 로그·저장소·일반 파일에 출력하지 않고 승인된 브라우저 이동에만 사용한다. callback은 state digest의 미사용·만료·연결·계정 조건을 확인하고 먼저 원자 소비한 뒤 일회 code를 교환한다. 새 UUID와 새 암호화 키에 결속된 refresh/access 두 행을 하나의 transaction으로 저장한다. 자격정보 상태는 READY가 되지만 수집 활성화와 source policy는 별도 검증 대상이다.

refresh 소유권은 `source_credentials`의 같은 schema·connection에 대한 UUID owner / 90초 lease / revision CAS로 보호된다. `accessToken`과 credential read는 enabled=false만으로 refresh를 막지 않는다. 06과 08 사이의 같은 pair에 대한 공통 fence는 없다. 따라서 기존 pair를 복제하지 않고 새 OAuth pair를 08에만 저장한다. 새 승인 시 기존 앱·mall의 이전 token에 미치는 provider 측 영향은 이 로컬 코드로 보장할 수 없다. 기존 06 결과와 DB를 보존하고, 새 승인 이후 구 06 pair를 사용한 추가 API 읽기·refresh를 실행하지 않는 경계를 루트 작업자가 유지해야 한다.

이 helper의 실제 provider 요청 수는 0이다. callback 등록·실제 승인·fresh credential 저장·주문 대조·일일 정시 실행 증거는 각각 별도로 기록한다. 신규 CSV는 요구하지 않는다.
