# 08 전체 앱 격리 준비

`prepare-full-app.mjs`는 로컬 검토 자료만 생성한다. DB 접속, 배포, 예약 등록,
환경 변수 설정, 자격 증명 읽기·복사를 수행하지 않는다. `full-app-identity.example.json`의
값은 실행 허가나 원격 대상 검증 증거가 아니다.

## 대상 확인

전체 앱 후보는 보호 프로젝트 `ehnfrrmbkvlsbpvqcvkr` 안의 새
`phase08_meta_ads` schema와 `phase08_runtime`, `phase08_migration` 역할이다.
실행자는 원격 프로젝트·조직·DB host·database·schema·역할의 실제 identity와
기존 schema/역할 부재를 실행 직전에 확인해야 한다. SQL의 project ref 주석은
운영 DB 실행을 차단하는 기술적 경계가 아니다.

`grand-fascination-staging.up.railway.app`과 `patimagroup-work.com`은 같은
운영 Railway 서비스의 별칭으로 확인되었다. 둘 다 격리 앱 또는 scheduler
대상으로 사용할 수 없다. 기존 Cafe24 callback 서비스와 06의 22테이블 DB는
전체 앱 후보가 아니며 보존한다. 새 서비스의 독립 project/environment/service/domain
identity가 확인되기 전에는 configure/install/enable/resume을 실행하지 않는다.

## 검토 자료 생성

```text
node scripts/cloud/daily-data-sync/prepare-full-app.mjs scripts/cloud/daily-data-sync/full-app-identity.example.json <존재하지 않는 로컬 출력 디렉터리>
```

결과는 `full-app-schema.sql`과 `manifest.json`이다. 원본 migration을 수정하지 않고
기존 전체 migration의 schema-qualified 이름과 알려진 grant 역할만 변환한다.
manifest에 원본 및 변환 SQL의 SHA-256을 기록한다. 기존 schema/역할이 발견되면
SQL은 전체 transaction을 중단한다. 두 전용 역할은 NOLOGIN/NOBYPASSRLS로 만들고,
앱 테이블에 FORCE RLS와 역할 정책을 적용한다. 운영·05~07의 행과 credential은
복사하지 않는다.

원본 migration에 포함된 개별 BEGIN/COMMIT은 dollar-quoted 본문 밖에서만 제거한다.
이를 남기면 outer transaction과 SET LOCAL search_path가 종료되어 이후 DDL이 다른
schema로 이동할 수 있다. 알려지지 않은 transaction 제어와 search_path 변경은 거부한다.

합성 생성 테스트는 실제 PostgreSQL 문법·전체 migration 순차 적용 증거가 아니다.
원격 적용 전에 같은 SQL을 새 로컬 PostgreSQL DB에서 실행하고 table/constraint/index,
FORCE RLS, runtime `SET ROLE` 허용과 금지 경계를 확인해야 한다. 실행 SQL의
hash가 검토한 manifest와 같아야 한다.

## 앱 부팅 준비의 경계

`deploy/Dockerfile`과 `deploy/launch-bundle.mjs`는 Next/API를 시작하며 migration을
자동 실행하지 않는다. runtime URL은 전용 LOGIN과 새 schema를 사용하고,
Supabase Auth/Storage 및 DB identity는 같은 보호 project ref로 묶어야 한다.
현재 SQL 객체 소유자는 postgres다. Prisma migration ledger를 생성하지 않으므로
향후 maintenance migration을 실행하려면 소유권과 명시적 baseline을 별도로 검토한다.

Meta는 기존 PURCHASE_V1 계약에 맞는 protected ENCRYPTED_FILE vault, 독립 vault key,
connection/account binding, verified catalog/report schema가 필요하다. protected 파일은
이미지에 복사하거나 로그로 출력하지 않는다. Google은 로컬 ADC의 성공만으로 클라우드
portable credential을 검증했다고 기록하지 않는다. Cafe24도 독립 격리 앱에서 사용할
portable credential과 version evidence를 별도로 검증한다. 신규 CSV를 요구하지 않는다.

기존 Meta 보호 입력은 저장소 밖 `C:/Users/seong/AppData/Local/MetaAdsMetaIsolated/`의
CurrentUser DPAPI `mcp-access-token.dpapi` 및 `inspector-token.dpapi`다. Linux에서 직접
읽을 수 없으며 phase07 publish launcher는 임시 DB 생성·임시 vault 삭제를 수행하므로
phase08 provisioning에 재실행하지 않는다. 새 보호 wrapper가 기존 ACL/reparse 검사를
거쳐 메모리에서만 복호화하고, phase08 connection/account/MCP transport에 결속된
`sealMetaVaultRecord` 암호문을 독립 vault에 생성해야 한다. 복호문을 argv·평문 파일·
build context·로그에 넣지 않는다. catalog/report schema 경로는 각각
`DAILY_SYNC_META_MCP_CATALOG_PATH`, `DAILY_SYNC_META_MCP_REPORTING_SCHEMA_PATH`다.

Google runtime은 `google-auth-library`의 `GoogleAuth` 기본 ADC를 사용한다. 05의 실제
증거는 사용자 Cloud SDK 저장소에 있는 keyless service-account impersonation ADC다.
Railway에는 그 로컬 저장소나 GCP workload identity가 자동으로 전달되지 않는다.
클라우드용 source credential 및 impersonation 결속을 명시적으로 준비하고, 보호 파일을
사용할 때 `GOOGLE_APPLICATION_CREDENTIALS`로 지정해야 한다. 서비스 계정 키 신규 발급,
사용자 refresh token 복사, 새로운 IAM 권한 추가는 이 로컬 준비에 포함하지 않는다.

runtime credential, Auth/Storage, checkpoint key 및 machine key provisioning은 이 준비
도구의 범위 밖이다. 기존 dirty checkout 전체의 build content manifest를 기록하며 HEAD
하나만 배포 소스 증거로 사용하지 않는다. 실제 격리 정시 수집·재개·멱등·누락 경고·유휴
검증이 완료되기 전에는 08 완료를 선언하지 않는다.

## 08 전용 bundle

`deploy/cloud/phase08.Dockerfile`은 기존 운영 `deploy/Dockerfile`을 수정하지 않은
격리 전용 변형이다. 동일 Next/Nest bundle, pinned base digest, full release SHA,
`PHASE08_SOURCE_CONTENT_SHA256` build argument를 사용하고 `USER node`로 실행한다.
`HEALTHCHECK NONE`으로 주기적인 ping을 만들지 않는다. 최초 부팅의 readiness 검사는
기존 launch bundle의 짧은 시작 관문이며 상시 호출과 구분한다.

`deploy/cloud/phase08-launch.mjs`는 보호 ref, 새 schema/runtime user, verify-full DB URL,
직접 `db.<ref>.supabase.co` host 또는 정확한 서울 session pooler
`aws-0-ap-northeast-2.pooler.supabase.com:5432`와 `phase08_runtime.<ref>` user,
동일 Supabase URL 및 `phase08-*.up.railway.app` 정확
origin을 확인한다. 첫 부팅에는 feature/schedule flag를 모두 false로 요구한다.
root가 독립 서비스 identity를 확인한 뒤 명시하는 `PHASE08_ACTIVATED=true`는 후속
검증용 활성화를 허용할 뿐 기존 앱·machine guard와 scheduler target 검증을 대체하지 않는다.

보호 입력 이름은 `PHASE08_GOOGLE_ADC_JSON_B64`, `PHASE08_META_RECORD_B64`,
`PHASE08_META_CATALOG_JSON_B64`, `PHASE08_META_REPORT_SCHEMA_JSON_B64`다.
전체 Meta catalog/report metadata는 각각 `PHASE08_META_CATALOG_GZIP_B64`,
`PHASE08_META_REPORT_SCHEMA_GZIP_B64`로도 전달할 수 있다. 각 metadata마다 JSON과
gzip 중 정확히 하나만 설정한다. 원본 전체 metadata를 gzip으로 전달하며 필드를
삭제하거나 축약하지 않는다. canonical base64/입력 2M문자 상한과 gunzip 출력 1MiB
상한, JSON object 검증을 적용하고 동일한 0600 파일로 저장한다. ADC와 vault record는
압축 입력을 받지 않는다. 새 gzip 입력도 성공·실패 finally에서 환경에서 삭제한다.
Meta record 파일 이름은 `PHASE08_META_REF_UUID`이며 Google impersonation URL은
`PHASE08_GOOGLE_TARGET_PRINCIPAL`과 정확히 같아야 한다. `PHASE08_VERIFIED_ORIGIN`은
읽기 전용 실제 서비스 inventory 확인 후 root가 정한다. 값을 이 문서에 저장하지 않는다.

Linux launcher는 실제 tmpfs인지 확인한 `/dev/shm` 안의 runtime 사용자 소유 새
디렉터리 0700, 파일 0600에 입력을 쓰고
보호 B64 입력을 parent 및 API child env에서 삭제한다. 기존 launch bundle은 Web child에
서버 비밀을 전달하지 않는다. 정상 종료와 parent exit 시 파일을 정리한다. 강제 SIGKILL은
종료 handler가 실행되지 않으므로 이 파일은 컨테이너의 메모리 tmpfs에만 둔다.
build가 생성하는 root 소유 read-only `phase08-source-content-sha256` 파일과 runtime
SHA가 정확히 같아야 한다. Linux private-file 합성 테스트는 nonroot 및 root가 준비한
`PHASE08_TEST_IMAGE_HASH_PATH` fixture를 요구하며 미제공 시 해당 검사를 건너뛴다.
Windows 합성 통과를 Linux 권한·tmpfs 실제 검증으로 확대하지 않는다.
