# 06 합성 PostgreSQL canonical 검증 절차

이 검증은 실 Cafe24 주문·토큰·기존 callback DB를 쓰지 않는다. 합성 `READY` 연결은 OAuth 검증 결과가 아니다. 코드가 한 주문일의 bound CSV 업로드, API shadow commit, 명시적 원천 전환, 같은 날 멱등 재실행, 값 변경 버전 2, 중간 실패 rollback과 이전 성공 조회를 실제 PostgreSQL에서 확인한다. 실행 후 합성 클러스터 데이터는 재검토용으로 보존한다.

## 실행 대상

- 별도 로컬 PostgreSQL 17 클러스터. 기존 운영·격리 callback DB와 독립된 `%LOCALAPPDATA%\MetaAdsCafe24Phase06Harness` 아래 persistent data 디렉터리를 사용한다.
- `initdb -A trust -U phase06_harness`는 합성 전용 클러스터에만 사용한다. `postgres`/`pg_ctl`은 `127.0.0.1:55436`으로만 바인딩한다. 방화벽·서비스의 외부 수신을 열지 않는다. 이 클러스터에는 실 계정·토큰·CSV를 넣지 않는다.
- 빈 `phase06_synthetic` DB와 `phase06_harness` schema를 `phase06_harness` role 소유로 만든다. schema를 만든 뒤 앱 테이블이 0개인지 preflight가 확인한다. DB/role/schema 이름, loopback 주소·포트가 다르면 마이그레이션 전에 중단한다.
- 로컬 `node_modules`에는 전체 앱 Prisma Client와 `prisma`/`vitest`가 있어야 한다. 테스트 파일은 exact URL·ACK가 없으면 skip하며, 시작 시 `current_database()`·`current_schema()`·`current_user`, 전체 migration ledger, 06을 포함한 업무 테이블이 비어 있음을 다시 검사한다. 전체 앱 migration은 `app_settings`와 `coupang_sales_fee_rules`에 기본값을 1행씩 만든다. 이 두 기본값은 키/요율과 행 수까지 확인한다.

## 실행

클러스터 초기화·시작과 DB/schema 생성은 작업 폴더 밖 별도 경로에서 한다. 패스워드를 명령 인자·문서·로그에 쓰지 않는다. 합성 전용 `trust` 클러스터의 URL에는 암호가 없다. 아래 환경 변수는 **현재 PowerShell 프로세스에만** 설정하며 Git 파일이나 `.env`에 저장하지 않는다.

```powershell
$env:DAILY_SYNC_PHASE06_HARNESS_DATABASE_URL = 'postgresql://phase06_harness@127.0.0.1:55436/phase06_synthetic?schema=phase06_harness'
$env:DAILY_SYNC_PHASE06_HARNESS_ACK = 'EMPTY_FULL_SCHEMA_SYNTHETIC_ONLY'
node apps/api/scripts/cafe24-phase06-db-preflight.mjs
```

`PHASE06_EMPTY_DB_IDENTITY_VERIFIED`를 확인한 뒤 **같은 PowerShell 프로세스**에서 전체 앱 migration만 적용한다. preflight는 지정 schema의 base table이 0개인지 검사한다. preflight 실패 시 `migrate deploy`를 실행하지 않는다.

```powershell
$previousDatabaseUrl = [Environment]::GetEnvironmentVariable('DATABASE_URL', 'Process')
try {
  $env:DATABASE_URL = $env:DAILY_SYNC_PHASE06_HARNESS_DATABASE_URL
  .\node_modules\.bin\prisma.cmd migrate deploy --schema apps/api/prisma/schema.prisma
  if ($LASTEXITCODE -ne 0) { throw '06 synthetic migration failed' }
  Push-Location apps/api
  try { npm test -- --run src/daily-sync/cafe24-canonical.postgres.integration.spec.ts }
  finally { Pop-Location }
} finally {
  if ($null -eq $previousDatabaseUrl) { Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue }
  else { $env:DATABASE_URL = $previousDatabaseUrl }
}
```

실패 시 DB를 reset/clean하지 않는다. 로그에는 합성 행만 있어야 한다. 실행 후 `pg_ctl stop`으로 서버만 중지하고 클러스터와 작업 폴더 밖의 기존 DPAPI 파일은 보존한다. 같은 스키마에서 테스트를 재실행하면 빈 테이블 검사로 중단된다. 재실행은 **새 별도** 합성 DB/schema를 마련하고 대상 identity를 다시 확인한 뒤에만 한다.

## 이 검증의 한계

합성 `card`→`card` 결제수단 매핑과 합성 금액은 실제 10/1 주문별 의미 대조가 아니다. 실제 주문 응답의 총 주문금액·결제수단·쿠폰 입력, 실제 OAuth 회전·철회·재연결, 격리 환경의 실 canonical 발행·복구는 별도 미완료다. 이 결과만으로 06을 DONE 또는 API primary로 전환하지 않는다.

## 2026-10-07 추가 실증과 보존 대상

46 migration을 새 빈 full-schema 합성 DB에 적용한 최신 writer lifecycle은 1/1 PASS다. 빈 CSV 날짜의 원금액/current link 보존, 실제 row/version/link/HMAC binding, 다음 CSV 없는 하루 API_ONLY 성공, 같은 키 CSV NEW_VERSION 뒤 새 날짜 승격 거절이 추가됐다. jsonb 객체 키 순서 비교 실패를 기록한 클러스터는 보존하고 필드별 비교 수정 뒤 별도 빈 클러스터에서 검증했다.

별도 외부 `pg17-live-ddl-20261007`은 loopback `127.0.0.1:55437`, DB `phase06_live_ddl`, role `phase06_harness`, schema `public`에서 초기 합성 축소6테이블로 시작해22테이블로 확장했다. fake nondecryptable credential bytes만 넣고 같은 static SQL/setup 경로를 호출했다. `SETUP_POSTCHECK/ISOLATED_ADDED_FOREIGN_KEY_MISMATCH`와 전체 rollback을 재현했다. PostgreSQL FK deparse 동작 순서 의존을 제거하고 컬럼/참조/validated/delete/update action으로 검사하도록 수정한 뒤 정확22테이블·신규16 RLS·기존6 content digest·credential revision8/8·disabled 보존을 확인했다. 독립 READ ONLY/ROLLBACK 후상태와 관련34/34·API lint·PS 진단 canary 검증도 통과했다. 이 경로는 전체 앱 migration을 격리 callback DB에 적용하는 방법이 아니다.

외부 harness 아래 `pg17-data`, `pg17-data-20261006`, `pg17-data-20261006-final`, `pg17-data-20261007-jsonb`, `pg17-data-20261007-unmatched`, `pg17-live-ddl-20261007` 및 바이너리/합성 로그/실행기는 삭제하지 않는다. 실행 후 서버만 중지하고 재사용 자원 보존을 확인한다. 삭제·비용 중단 확인은 12단계 계획에서 한다. 실제 Cafe24 토큰·주문/고객·CSV 원문은 어느 합성 DB/fixture에도 넣지 않는다.

추가 검증에서 VALID/RULE 및 UNMATCHED/UNMATCHED/null metadata가 함께 있는 API_ONLY 하루의 current/version/link/coverage 전량 보존과 mapped-only 경고를 새 full-schema PG lifecycle 1/1로 확인했다. 독립 READ ONLY 후상태도 통과했다. 55437의 합성 규칙18/24/35/2·합성 CSV477행에서는 DATE 기본 parser의 전일 저장·createdAt 9시간 이동·동일 구성 재사용 실패를 재현한 뒤, ID집합/비날짜/65DATE·37TIMESTAMP/전건 매핑 metadata 검증과 같은 transaction 후검사를 통과한 정정·실패 rollback·재사용을 확인했다. 최신 독립 집중110/110·lint·PS 자체 검사와 READ ONLY 사후 확인에 미해결 P1/P2가 없다. 서버만 중지했고 포트55436/55437은 폐쇄했다. 실제격리 규칙 정정·실주문 계산 증거는 [06 결과](records/06_결과.md)에서 별도로 관리한다.

날짜 정정의 초기 합성 commit/후속 재사용과 최신 전건 매핑 사전 관문은 구분한다. 최신 사전 관문은 동일 transaction을 rollback하는 wrapper로65DATE·37TIMESTAMP 정정/사후 보존 및 매핑 불일치 시 쓰기0을 실증했다. 최신 전체 경로의 실제 날짜 정정 및 후속 Seed 재사용 성공은 격리 Railway 증거에 따로 기록했다.

옵션 저장 용량 정정은 같은55437/22-table 합성 DB에서 정확 identity·fake credential·CSV477/API0·idle 검사를 통과한 뒤 실제 전환 함수를 실행했다. 한 transaction에서256→514와 전체22테이블 행/다른 catalog 보존을 확인하고 바깥 rollback 후256을 확인했다. stale catalog 지문은 거절됐다. 평가자의 READ ONLY 확인에서도256·CSV477/API0·credential2·connection1이 보존됐다. 서버만 중지하고 포트 폐쇄·데이터/실행기 보존을 확인했다. 전체 앱의 새514 migration은 로컬 파일로 추가했으며 이 합성22-table DB나 실제 격리 DB에 전체 migration을 적용한 것은 아니다.
