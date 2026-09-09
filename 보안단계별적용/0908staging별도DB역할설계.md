# R2A staging 별도 DB·역할 설계

작성 기준: 2026-09-08 KST  
SSOT: `0901클라우드실배포잔여작업계획.md`  
현재 판정: **PROVIDER PHASE 1 MAIN_REPORTED PASS / PHASE 2 LOCAL PREPARED·PROVIDER NOT RUN /
credential activation·migration·후속 단계 NOT RUN / operationalReady=false**

## 1. 범위와 release 경계

- 대상은 Supabase staging 조직 `synohgzwspodxmfemoks`, project
  `ehnfrrmbkvlsbpvqcvkr` (`Meta Ads Performance Security Dev`, Free,
  `ap-northeast-2`)뿐이다.
- production ref `iygjmosbelbosfxidqxv`, `patima_app`, 네이버 마진 프로그램의 DB와
  데이터는 대상에서 제외한다.
- 새 application database는 `meta_ads_staging`, schema는 `public`이다.
- 역할은 `meta_ads_stg_runtime`, `meta_ads_stg_migration`, `meta_ads_stg_backup`이다.
- 외부 변경 전 준비 파일은 모두 `보안단계별적용/**`에 둔다. 이 경로는 release build
  context에서 제외된다. 현재 phase 2 준비 bundle은 source
  `53e87ba3ebf9c062463072ce5e4c8db77d8e9076`와 그 source에서 만든 exact 6-image에 재결속했다.
- 최초 설계·로컬 rehearsal 자체의 Supabase mutation은 0건이었다. 이후 별도 승인된 phase 1은
  provider에서 PASS했지만, 이 문서와 재결속 작업은 G-DB-00 phase 2/G-DB-02 승인이 아니다.

## 2. 확정 architecture와 정직한 격리 경계

기존 Supabase `postgres` DB의 schema·ACL·default ACL·managed role을 바꾸지 않고, 같은
staging cluster 안에 별도 DB를 만든다. 앱의 Prisma table은 새 DB에만 생성하고 Auth와
Storage는 Supabase HTTP API 및 기존 `postgres` DB의 managed schema에 남긴다. source에는
`auth.*` 또는 `storage.*`와 새 앱 table 사이의 cross-database FK가 없다.

세 역할의 공통 속성은 `NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION
NOBYPASSRLS CONNECTION LIMIT 2`다. 첫 bootstrap에서는 모두 `NOLOGIN`으로 생성한다.
서로 다른 client-side credential을 안전한 Git 외부 경로에 준비한 뒤 별도 G-DB-00으로
`LOGIN`과 SCRAM password를 활성화한다. password/URI는 Git, SQL 파일, 터미널 출력,
Dashboard query history, 증거 JSON에 넣지 않는다. client/container stdout·stderr에서 plaintext와
verifier가 나오지 않는 경로는 local rehearsal로 검증했지만, Supavisor Pooler Logs와 PostgreSQL
DDL/activity/server log가 verifier를 저장·표시·마스킹하는지는 공식 보장을 확인하지 못해
**UNKNOWN**이다. 따라서 connection/auth/DDL metadata log와 verifier log residual 가능성을 승인
gate에 명시한다.

`meta_ads_stg_migration`이 새 DB, `public` schema, migration 생성 객체의 owner다. runtime은
소스에서 확인한 table별 DML만 받고 DDL/TEMP/role 관리/ownership을 받지 않는다. backup은
정확한 54 table의 SELECT만 받고 DML/DDL/TEMP/function 실행/ownership을 받지 않는다.

다만 PostgreSQL role은 cluster 전역이다. 현재 base `postgres` DB가 PUBLIC에 CONNECT와 TEMP를
주므로 새 세 역할도 그 DB에서 이를 상속한다. PostgreSQL에는 PUBLIC grant를 per-role DENY로
덮는 기능이 없다. 따라서 이 architecture는 **새 app DB 내부 최소권한**을 제공하지만 project
전체 또는 cluster 전체 격리를 제공하지 않는다. base DB ACL을 바꾸지 않는다는 현재 안전 경계와
완전 격리를 동시에 달성할 수 없다. 실제 verify는 이 inherited CONNECT/TEMP를 residual로
기록하고 PASS로 오인하지 않는다.

Supabase의 non-superuser CREATEROLE creator는 PostgreSQL 17에서 새 role에 대한 관리용
membership를 자동 획득할 수 있다. 로컬 PG17에서는 creator에 `ADMIN=true, INHERIT=false,
SET=false` edge가 생성됨을 확인했다. 새 DB owner를 지정할 때 migration role의 SET edge를
creator 자신이 임시로 하나 더 만든 뒤 DB/schema bootstrap 직후 그 exact self-granted edge만
회수한다. 최종에는 `postgres` creator의 관리용 ADMIN edge만 허용하고 앱 역할 사이 membership는
0이어야 한다. 이 edge는 credential 회전·role 삭제를 가능하게 하기 위한 관리 경계이며 runtime
권한으로 계산하지 않는다.

## 3. 실행 단위와 승인 순서

1. **G-DB-00 phase 1 — NOLOGIN bootstrap**
   - `00-admin-preflight.sql`, `10-admin-bootstrap.sql`, `20-app-bootstrap.sql`의 실행 직전
     raw byte SHA-256을 다시 계산한다.
   - 승인된 direct 또는 session-pooler endpoint와 Dashboard의 staging ref를 같은 receipt에
     결속한다. SQL만으로 project ref를 증명할 수 없으므로 endpoint/login suffix 확인이 없으면
     실행하지 않는다. 현재 host는 direct IPv6 route가 없어 exact session-pooler tuple을 사용한다.
   - role/database collision, current DB/user, PG major, CREATEDB/CREATEROLE, base PUBLIC ACL이
     예상과 다르면 중단한다.
   - 세 NOLOGIN role과 disabled 상태의 새 DB를 생성하고, 새 DB의 PUBLIC 권한을 제거한 뒤
     explicit CONNECT만 부여하고 연결을 연다. 기존 base DB ACL은 바꾸지 않는다.
   - session pooler 실행 전 `postgres`와 아직 존재하지 않는 `meta_ads_staging` 두 database에 대한
     exact suffixed admin login pgpass entry를 준비한다. reconnect는 `-reuse-previous=on`으로 검증된
     host/login/port/TLS를 유지하고 database name만 바꾼다.
2. **G-DB-00 phase 2 — credential 활성화**
   - `phase2-prepare-credentials.ps1`이 .NET CSPRNG 32 byte로 서로 다른 Base64url credential 3개를
     만들고 `%APPDATA%\MetaAdsSecurity\staging-db-roles`에 DPAPI CurrentUser 암호문으로만 원자적
     저장한다. directory/file ACL은 현재 user SID와 SYSTEM만 허용하며 값과 hash는 출력하지 않는다.
     이미 같은 exact store가 있으면 회전 없이 검증만 하고, marker나 예상 밖 항목이 있으면 중단한다.
   - `phase2-provider-run.ps1 -Mode Execute`는 plaintext를 local memory와 user/SYSTEM-only 임시
     pgpass에만 복호화한다. 서로 다른 16-byte salt와 PBKDF2-HMAC-SHA256 4096으로 PostgreSQL 형식
     SCRAM verifier를 client-side 생성하고, `--interactive` redirected stdin의 세 고정 `\prompt`
     줄로만 psql에 공급한다. plaintext는 SQL/stdin/argv/environment/wire에 넣지 않는다.
   - `password_encryption=scram-sha-256`, `scram_iterations=4096`을 assert한 한 admin transaction에서
     exact OID 세 role의 verifier를 설정하고 LOGIN을 켠다. phase 1 상태, creator edge, DB ACL,
     base ACL fingerprint와 target session 0이 다르면 mutation 전에 중단한다.
   - 현재 host의 direct IPv6는 도달 불가이므로 exact session pooler에서 role별 suffixed login과
     `current_database/current_user/session_user`, role OID/속성/최소권한/default ACL/TLS와 named
     PREPARE→EXECUTE→DEALLOCATE를 각각 확인한다. `PGREQUIREAUTH=scram-sha-256`, 공식 CA,
     `sslmode=verify-full`, session port 5432만 사용한다. direct role login은 별도 IPv6-capable
     runner 전까지 NOT RUN으로 남긴다. URL과 password는 출력하지 않는다.
   - wrong-password/cross-secret probe, transaction pooler, automatic retry는 0이다. Supavisor의 새
     user+database+mode 전파 지연 상한은 UNKNOWN이므로 첫 실패를 credential 실패로 단정하거나
     재시도하지 않는다.
3. **G-DB-02 — staging migration**
   - exact migration image index
     `bb886aecaadaa75d9995ce9fdadd33552528a34d58b9885e3cc34cdf4e12a2a4`와 이 bundle의
     `migration-release.json`을 사용한다.
   - image 내부 37 `migration.sql` raw bytes를 실행 직전에 재해시하고 release의 37 entry와
     일치해야 한다. current runner가 SQL raw bytes를 자체 재해시하지 않는 gap을 이 preflight로
     보완한다.
   - INSPECT → approved plan → PLAN_CHILD → EXECUTE → INSPECT 순서를 지키고 journal의
     `INTENT_RECORDED → APPLIED_PENDING_VERIFY → VERIFIED`를 확인한다.
4. **G-DB-00 phase 3 — post-migration exact grants**
   - 37 history 이름/checksum, 54 table, 20 enum, function 1, trigger 2, owner를 먼저 exact
     비교한다. 불일치 시 grant를 0건 적용하고 중단한다.
   - `30-post-migration-exact-grants.sql`로 runtime table별 matrix와 backup SELECT를 부여한다.
   - `40-verify.sql`, 실제 role별 부정/긍정 연결 test, exact backup image의 read-only pg_dump를
     통과해야 한다.

각 단계는 별도 승인과 별도 receipt를 사용한다. G-DB-00 phase 1 승인으로 credential, migration,
post-grant를 실행하지 않는다. G-DB-02 승인으로 grant 변경을 실행하지 않는다.

## 4. 예상 catalog와 runtime 권한

37 migration 뒤 `public`에는 Prisma model table 52개,
`coupang_cost_rules_backup_20260723`, `_prisma_migrations`를 합친 base table 54개가 있어야 한다.
enum은 20, function은 `security_audit_events_append_only()` 1개, user trigger는 2개이고
sequence/view/materialized view는 0이어야 한다.

runtime의 direct DML matrix는 다음과 같다. `S=SELECT`, `I=INSERT`, `U=UPDATE`, `D=DELETE`다.

| 권한 | table |
|---|---|
| 없음 | `adset_name_aliases`, `local_credentials`, `local_account_setup_tokens`, `local_edge_request_nonces`, `_prisma_migrations`, `coupang_cost_rules_backup_20260723` |
| SI | `adset_product_histories`, `adset_stage_histories`, `change_logs`, `decision_logs`, `decision_runs`, `product_change_logs`, `security_audit_events` |
| SID | `cafe24_upload_row_errors`, `coupang_daily_report_category_products`, `coupang_manual_purchases`, `coupang_upload_row_errors`, `creative_change_logs`, `upload_row_errors` |
| SIU | `app_auth_sessions`, `app_settings`, `app_users`, `coupang_daily_report_categories`, `coupang_product_groups`, `coupang_promotion_prices`, `coupang_sales_fee_rules`, `exchange_rates`, `meta_ads`, `meta_adsets`, `meta_campaigns`, `report_exports`, `storage_tombstones` |
| SIUD | `cafe24_coupon_rules`, `cafe24_order_lines`, `cafe24_product_rules`, `cafe24_upload_batches`, `coupang_ad_metrics`, `coupang_cost_rules`, `coupang_product_rules`, `coupang_products`, `coupang_sale_lines`, `coupang_upload_batches`, `creative_aliases`, `creative_placements`, `creatives`, `meta_ad_daily_metrics`, `meta_adset_daily_metrics`, `product_cost_rules`, `product_cpa_rules`, `product_match_rules`, `products`, `security_rate_limit_buckets`, `upload_batches`, `upload_rows` |

모든 runtime table에서 TRUNCATE/REFERENCES/TRIGGER/MAINTAIN은 false여야 한다. enum 20개에는
USAGE가 필요하지만 app function 직접 EXECUTE는 0개다. FK cascade의 간접 삭제 효과는 direct
grant와 별도이며, 이 matrix가 행의 절대 보존을 뜻하지 않는다.

새 DB의 PUBLIC DB/schema/table/function/type ACL은 0이어야 한다. PostgreSQL의 function EXECUTE와
type USAGE는 global PUBLIC default이므로 migration owner의 database-global default ACL에 해당
REVOKE가 명시적으로 존재하고 owner 외 grantee가 0이어야 한다. 예상 54 table 외 sequence/view/
materialized view/foreign table이 하나라도 있으면 `GRANT ... ON ALL TABLES IN SCHEMA` 전에 중단한다.
최종 verify는 table·enum·function·trigger exact 집합, owner, 37 migration name/checksum까지 다시
검사하며 post-grant drift를 단순 count PASS로 처리하지 않는다.

기존 `deploy/windows/Test-SupabaseDatabaseBoundary.ps1`은 local-native 과거 계약으로
`_prisma_migrations` 외 모든 table에 runtime 공통 CRUD를 요구한다. historical backup table의
최소권한과 충돌하므로 cloud 판정에 재사용하지 않는다. 이 문서의 exact allowlist와 actual
PG17 결과가 cloud 계약이다.

## 5. 연결 경로와 아직 증명하지 않은 것

- 현재 실행 host의 direct endpoint는 A record 없이 IPv6만 있고 local IPv6 default route가 없어
  auth 이전에 도달 불가다. staging base `postgres`의 session pooler/TLS `verify-full` read-only
  preflight와 승인된 phase 1 `CREATE DATABASE`, suffixed admin login의 custom DB routing은 PASS했다.
- migration과 backup은 IPv6 가능한 runner의 direct endpoint 또는 별도 승인·검증된 session pooler,
  TLS `verify-full` 후보를 유지한다. 함수 이름이나 과거 direct 전제를 실제 route 증거로 간주하지 않는다.
- runtime은 session pooler 후보지만 role credential과 runtime username suffix/routing은 여전히
  **UNKNOWN/NOT RUN**이다. admin routing PASS를 runtime 결과로 확대하지 않는다. role별
  `current_database()`가 exact DB를 반환하고 connection limit·prepared statement 계약이 확인될
  때만 선택한다.
- phase 2 exact saved activation/role/final SQL은 provider-shaped local PG17과 self-signed synthetic
  CA의 TLS `verify-full`에서 PASS했다. 이 결과는 Supabase TLS/pooler routing을 증명하지 않아
  provider 항목은 계속 NOT RUN이다.
- 별도 DB가 Supabase managed backup, Dashboard, extension/upgrade lifecycle에 동일하게 포함되는지
  아직 증명하지 않았다.
- Auth/Storage HTTP와 별도 app DB의 invite/login/link/private-object lifecycle은 NOT RUN이다.
- local migration/pg_dump 성공은 actual maintenance runner, R2 upload, provider backup/restore,
  full production CMD의 PASS가 아니다.

## 6. 성공, containment, destructive rollback

G-DB-00 phase 1 성공은 exact target receipt, 세 NOLOGIN restricted role, 새 DB owner/schema owner,
새 DB PUBLIC 권한 0, runtime/backup의 새 DB TEMP/CREATE false, 기존 base DB ACL 불변, 예상된 creator
관리 edge 외 membership 0이다. collision·권한 오류·부분 적용·endpoint 불일치가 있으면 다음
단계를 실행하지 않는다.

2026-09-08 14:42 KST exact staging session pooler에서 승인된 phase 1을 한 번 실행했고 exit 0이었다.
preflight와 `10/20`, 별도 read-only postcondition, 종료 후 session state 집계가 PASS했다. DB OID는
`25404`, runtime/migration/backup role OID는 각각 `25397/25399/25401`이다. base ACL fingerprint는
전후 `94af03f1e723fcb05d1fd0a1590bbf99`로 같고, final target session count는 0이었다. exact receipt는
`증거/0908-staging-db-roles/provider-phase1-receipt.json`, SHA-256
`d596ccd6bc43d479705d43cdd720221cdc71dec3c242f52ace1d70cdaba04059`다. raw stdout 파일은
보존하지 않았으므로 provider 실행값은 MAIN_REPORTED structured receipt이며, 독립 평가는 파일·hash와
assertion의 내부 일관성까지만 증명한다. 이 PASS는 NOLOGIN bootstrap과 admin custom DB
routing까지만 증명한다.

비파괴 containment는 exact database/role OID를 입력한 `90-rollback-containment.sql`로 새 DB를
`ALLOW_CONNECTIONS=false`로 닫고 세 role을 NOLOGIN으로 바꾸는 것이다. 기존 세션을 자동 종료하거나
DB를 삭제하지 않는다. 실제 삭제는 backup receipt, exact OID, dependency, active session, 승인 token을
재확인하고 별도 승인한 경우에만
`99-rollback-destructive.sql`을 실행한다. `DROP OWNED`, `REASSIGN OWNED`, `CASCADE`, FORCE는
사용하지 않는다. DB가 먼저 삭제된 뒤 role 삭제가 dependency로 실패할 수 있는 부분 완료도
명시적으로 허용하며, 이 경우 NOLOGIN containment를 유지하고 재평가한다.

Phase 2 runner는 승인된 exact target/OID/phase-1 receipt/CA/PG17 image/SQL·entrypoint hash를
재검증하고 실행 전에 Git 외부 execution-state intent를 user/SYSTEM-only ACL, WriteThrough,
`Flush(true)`, same-directory atomic move로 기록한다. Docker control/run/cleanup은 같은 sanitized
environment와 literal `npipe:////./pipe/dockerDesktopLinuxEngine`에 고정한다. 각 container는
execution별 owner label, `--cidfile`, full container ID에 결속하며 이름 충돌 container는 삭제하지
않는다. cleanup과 임시 secret directory 삭제가 모두 확인된 뒤에만 atomic `active_verified`
marker를 publish한다.

activation의 `COMMIT` 결과가 불명확하거나 commit 뒤 positive verify가 실패하면 activation을 다시
실행하지 않는다. known no-provider-attempt 또는 pre-COMMIT rollback 상태도 VerifyOnly 대상이 아니다.
exact admin read-only catalog와 Pooler Logs로 먼저 분류하고 remote credential이 이미 active일
개연성이 확인된 경우에만 **새 별도 승인**으로 `-Mode VerifyOnly`을 단 한 번 실행한다. VerifyOnly은
activation SQL과 verifier 생성을 완전히 건너뛰고 세 role positive login과 final admin read-only
verify만 수행한다. hard-stop의 승인된 Execute transient state만 exact 불변식과 attempt count 0일 때
허용하며, mismatch·두 번째 attempt·stale temp·cleanup failure는 fail closed하고 별도 containment 또는
local recovery를 재설계한다.

2026-09-09 15:19 KST 승인된 phase 2 Execute를 정확히 한 번 실행했다. activation SQL은 commit marker를
반환했고 local execution-state는 `commitAckObserved=true`를 기록했으나, 첫 role positive login에서
psql exit 2가 발생해 상태는 `COMMITTED_VERIFY_FAILED`, verified role 0/3, final admin verify=false다.
runner는 raw 출력을 억제했고 retry·wrong-password·cross-secret test는 0이다. 임시 디렉터리와 소유
container는 모두 제거됐으며 actual DPAPI credential 3개와 execution-state는 분류를 위해 보호된 store에
유지한다. `active_verified` marker는 없다. 원인과 pooler 전파 상태는 UNKNOWN이다. activation은
재실행하지 않는다. 별도 승인된 admin read-only catalog 및 Pooler Logs 분류 전에는 VerifyOnly이나
containment를 실행하지 않는다. 비밀 없는 실패 receipt는
`증거/0909-g-db-00-phase2-execute-failure.json`이다.

2026-09-08 local synthetic rehearsal은 exact saved activation/role/final SQL, non-TTY verifier feeder,
세 SCRAM-required positive login, TLS `verify-full`, forced-failure transaction rollback을 PASS했다.
DPAPI prepare의 atomic create/idempotent no-rotation 및 activation marker atomic publish/read도 별도
local test를 PASS했다. 이들은 actual staging credential을 만들거나 provider에 접속하지 않았으며
provider mutation은 0이다.

Phase 2 승인 후보의 exact artifact는 다음과 같다. 실행 직전 main은 bytes와 SHA-256을 모두 다시
확인하며 하나라도 다르면 승인 token을 사용하지 않는다.

2026-09-09 재결속에서는 source `53e87ba3ebf9c062463072ce5e4c8db77d8e9076`, migration image
index `bb886aecaadaa75d9995ce9fdadd33552528a34d58b9885e3cc34cdf4e12a2a4`, backup image index
`64ee17e94ff83587995161ae59beb8878e995ec988f49a98c8eddf163d2ba863`를 사용했다. network none,
read-only, user `1000:1000`, cap-drop ALL, no-new-privileges, pids 64, memory/swap 512MiB,
`--pull never`의 로컬 컨테이너에서 migration image 내부의 Node/Prisma/schema와 37개
`migration.sql` raw bytes를 읽었다. 기존 release와 runtime 및 37개 migration entry가 같고 chain
SHA-256 `3620f082569de51cebbd5218c8fa1bf38005e60c1dee7b45d5d8eac20d930f6b`가 불변임을 확인했다.
새 canonical release ID는 `9bfd01c2097d18836d76b56d3def91410d928572aab530f3a5b75b188ed3014f`다.
두 검증 컨테이너는 종료 후 제거됐으며 provider 접속, 실제 migration, credential 준비는 NOT RUN이다.
비밀 없는 receipt는 `증거/0909-r2a-53e87ba-rebinding.json`에 둔다. 과거 f8a94fc local rehearsal을
새 source에서 재실행한 것으로 보지 않으며, phase 1 receipt의 역사적 provider 사실도 수정하지 않는다.

| artifact | bytes | SHA-256 |
|---|---:|---|
| `phase2-prepare-credentials.ps1` | 3,701 | `9f739f75dcbe379391aaacb57d30a1dbedb073409c77bb6f7d389f4484a887dd` |
| `phase2-provider-run.ps1` | 38,142 | `15eb19263d06ba3babd4786692abf7a7b8ed907d89934237336becc650f51002` |
| `phase2-secret-lib.ps1` | 9,672 | `48ddce9d009f8c2e4aa46f18060608ed818807ceba546ea401666a20950fec2c` |
| `phase2-provider-activation.sql` | 8,884 | `8b8527e25caff9fa9edab37420bd4808fbdf953fd75182a17e8e8c0c080671a7` |
| `phase2-role-verify.sql` | 7,142 | `846762928ddc6012202fe989336536fd07c34dd37cd126591e81fe3da8043efe` |
| `phase2-final-admin-verify.sql` | 4,837 | `3c13be90502d9947cc13f7bf42eea1e796001a12cdb7ef1755b6b600ef26f184` |
| `phase2-container-entrypoint.sh` | 462 | `3116be65ed91b60e9e3db6f191440eedab020a671d1c438c965b32fe4d9e2c41` |
| `phase2-local-forced-failure.sql` | 612 | `2302e83e9ace0aceec35596f1f8b059d02f89795db62029b8c0439f066a3ce09` |
| `phase2-local-rehearsal.ps1` | 15,618 | `0a14b68d6c7466487e4bdf3b2380b85dcf7ad8a383e79edbad38f6e464c0851f` |
| `phase2-local-rehearsal-summary.json` | 1,503 | `9e956deb85e71b6f14bdfae94005e51b806b6d26ac80d766cdae254b53ff3320` |

최종 고정 runner는 A/B/C 독립 정적·모의 검토에서 신규 P0/P1/P2/P3 0건/GO였다. actual provider
성공을 평가한 결과가 아니며, 승인 전 상태는 계속 provider NOT RUN이다. stale temp가 있으면 자동
삭제하지 않고 owner-label/CID와 secret 잔류를 수동 분류·정리한 뒤 untouched attempt-0 state에만
새 승인 VerifyOnly 1회를 허용한다.

actual credential prepare/activation, role별 provider 연결, migration, grant, backup/restore,
Auth/Storage/app lifecycle은 계속 NOT RUN이다. Phase 2는 새 exact 승인 대기 상태다. 완료 조건 전에는
`operationalReady=false`다. production, push, main merge, tag는 별도 승인 전 실행하지 않는다.

## 7. 2026-09-09 phase 2 read-only 분류 결과

별도 exact 승인을 받은 뒤 기존 admin session pooler에서 SHA-256
`3c13be90502d9947cc13f7bf42eea1e796001a12cdb7ef1755b6b600ef26f184`의
`phase2-final-admin-verify.sql`을 2026-09-09 15:46:18–15:46:19 KST에 정확히 한 번 실행했다.
`BEGIN READ ONLY`/`ROLLBACK` 범위에서 database OID, 세 role OID·LOGIN·속성, DB/base ACL,
membership가 모두 일치했고 target session count는 0이었다. 이 PASS는 Execute 당시의
`finalAdminVerify=false`를 소급 변경하지 않으며 별도 분류용 catalog 결과다.

Supabase Dashboard Pooler Logs를 승인된 2026-09-09 15:18:30–15:21:00 KST 범위로 제한해
6건을 확인했다. 그중 첫 runtime positive verification과 같은 15:19:33 KST에 password
authentication failure 1건과 one-off auth query 경로가 관찰됐다. 로그 원문, username suffix,
password, verifier, URI, token은 저장하지 않았다. catalog는 exact PASS지만 명확한 인증 불일치
징후가 있으므로 최종 분류는 `CREDENTIAL_OR_VERIFIER_MISMATCH`다. credential과 verifier 중 어느
쪽이 원인인지는 secret 비교 없이 구분하지 않았고 pooler propagation/routing transient도 주장하지 않는다.

따라서 `Mode VerifyOnly`, activation 재실행, 자동 재시도와 wrong-password/cross-secret test는 금지한다.
기존 actual DPAPI credential3개와 `COMMITTED_VERIFY_FAILED` state는 변경 없이 보호 보존한다.
다음 허용 경로는 새 artifact와 별도 exact 승인에 결속된 credential recovery 또는 기존 exact OID의
비파괴 containment뿐이다. destructive rollback, migration, grant, backup/restore, Auth/Storage는
계속 NOT RUN이며 `operationalReady=false`다. 비밀 없는 분류 receipt는
`증거/0909-g-db-00-phase2-readonly-classification.json`이다.

## 8. credential recovery 로컬 번들

`CREDENTIAL_OR_VERIFIER_MISMATCH` 뒤 기존 activation 또는 VerifyOnly를 재사용하지 않도록 recovery를
별도 namespace와 상태기계로 설계했다. 원래 `%APPDATA%\MetaAdsSecurity\staging-db-roles`의 DPAPI
credential3개와 `COMMITTED_VERIFY_FAILED` state는 입력 불변식이며 수정·삭제·덮어쓰지 않는다.
새 후보는 승인 후에만 별도 `staging-db-roles-recovery` root에 DPAPI CurrentUser와 user/SYSTEM-only
ACL로 atomic 생성한다. prepare와 runner는 원본 root 밖의 같은 source lock을 사용하고 원본 root와
네 파일의 owner·ACL 보호 상태·exact SDDL·raw bytes/hash를 전후 비교한다. 후보3개는 서로 다르고 기존3개 모두와 다름을 메모리에서 확인하지만 값이나
그 파생 hash를 출력·Git·evidence에 기록하지 않는다. 두 번째 prepare는 no-rotation으로 끝난다.

`phase2-provider-credential-recovery.sql`은 PG17, SCRAM 4096, exact DB/role OID, 현재 LOGIN=true,
role 속성, base/database ACL, membership, active session0을 transaction 안에서 먼저 검사한다. stdin으로
받은 세 새 SCRAM verifier로 exact 세 role의 `PASSWORD`만 교체한다. LOGIN, grant/revoke, owner, ACL,
schema/data/migration은 변경하지 않는다. postcondition 뒤에만 COMMIT marker를 반환한다.

전용 runner는 `RecoveryExecute`와 전용 approval token만 허용한다. exact session pooler, official CA,
pinned PG17의 로컬 digest·linux/amd64 사전 검사, `--pull never`, TLS `verify-full`, SCRAM-required,
official CA의 reparse/ACL/hash 검사와 보호된 실행별 복사본, read-only/cap-drop/NNP/resource limit,
execution별 recovery owner label/CID에 고정한다. recovery intent를 먼저 durable state로 기록하고 provider
attempt를 최대1회로 제한한다. COMMIT marker 뒤 candidate credential로 runtime/migration/backup positive
login을 각각1회 수행한 다음 final admin catalog를 검사한다. wrong-password/cross-secret, transaction
pooler, direct IPv6 fallback, 자동 재시도는 없다.

명시적 psql exit3은 `RECOVERY_PRECOMMIT_SCRIPT_FAILED_ROLLBACK_EXPECTED`, 그 밖의 COMMIT 전 불명확한
종료는 `RECOVERY_COMMIT_OUTCOME_UNKNOWN`, COMMIT ack 뒤 role/final 검증 실패는
`RECOVERY_COMMITTED_VERIFY_FAILED`, provider 검증 뒤 cleanup 실패와 marker finalize 실패는 별도 상태로
보존한다. 어떤 실패에서도 recovery SQL을 재실행하지 않는다. 모든 소유 container와 임시 secret이
정리되고 원본 exact ACL/bytes 불변 검사가 끝난 뒤에만 recovery root에 별도 `active_verified` marker를 atomic publish한다. 원래 activation
marker는 계속 absent다. 후속 consumer 전환은 이 phase의 성공 receipt 뒤 별도 단계로 남는다.

로컬 리허설은 cached pinned PG17을 `--pull never`로 재사용하고 internal Docker network만 사용했다.
exact recovery SQL의 정상 PASSWORD-only 회전, 새 credential positive3, final admin, forced pre-COMMIT
rollback과 prior credential positive3 보존, role/ACL/owner/membership 불변이 PASS했다. wrong/cross test0,
provider/external network0, actual APPDATA 접근0, secret/verifier/secret-derived hash 출력0이며 container,
network, temp는 모두 제거됐다. 별도 redirected APPDATA prepare는 최초 생성과 두 번째 no-rotation을
PASS했고, 실제 runner에서 state validator 함수를 추출해 상태 12개와 second-attempt 거부를 재현 검증했다.

이 번들은 `LOCAL PREPARED`일 뿐이다. actual recovery candidate 생성, provider verifier 회전,
role positive login은 새 commit·manifest·prepare·runner·SQL에 결속된 exact 승인 전 **NOT RUN**이다.
성공 후에도 migration/grant/backup/Auth/Storage와 `operationalReady=true` 전환은 별도 gate다.
