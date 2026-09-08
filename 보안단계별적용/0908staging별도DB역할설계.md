# R2A staging 별도 DB·역할 설계

작성 기준: 2026-09-08 KST  
SSOT: `0901클라우드실배포잔여작업계획.md`  
현재 판정: **PROVIDER PHASE 1 MAIN_REPORTED PASS / credential·migration·후속 단계 NOT RUN /
operationalReady=false**

## 1. 범위와 release 경계

- 대상은 Supabase staging 조직 `synohgzwspodxmfemoks`, project
  `ehnfrrmbkvlsbpvqcvkr` (`Meta Ads Performance Security Dev`, Free,
  `ap-northeast-2`)뿐이다.
- production ref `iygjmosbelbosfxidqxv`, `patima_app`, 네이버 마진 프로그램의 DB와
  데이터는 대상에서 제외한다.
- 새 application database는 `meta_ads_staging`, schema는 `public`이다.
- 역할은 `meta_ads_stg_runtime`, `meta_ads_stg_migration`, `meta_ads_stg_backup`이다.
- 외부 변경 전 준비 파일은 모두 `보안단계별적용/**`에 둔다. 이 경로는 release build
  context에서 제외되므로 source `f8a94fcf43aa4705befcaafbcb91045e154ae54b`와 승인된
  exact 6-image는 바뀌지 않는다.
- 이 설계·로컬 rehearsal은 G-DB-00/G-DB-02 승인이 아니며 Supabase mutation은 0건이다.

## 2. 확정 architecture와 정직한 격리 경계

기존 Supabase `postgres` DB의 schema·ACL·default ACL·managed role을 바꾸지 않고, 같은
staging cluster 안에 별도 DB를 만든다. 앱의 Prisma table은 새 DB에만 생성하고 Auth와
Storage는 Supabase HTTP API 및 기존 `postgres` DB의 managed schema에 남긴다. source에는
`auth.*` 또는 `storage.*`와 새 앱 table 사이의 cross-database FK가 없다.

세 역할의 공통 속성은 `NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION
NOBYPASSRLS CONNECTION LIMIT 2`다. 첫 bootstrap에서는 모두 `NOLOGIN`으로 생성한다.
서로 다른 client-side credential을 안전한 Git 외부 경로에 준비한 뒤 별도 G-DB-00으로
`LOGIN`과 SCRAM password를 활성화한다. password/verifier/URI는 Git, SQL 파일, 터미널 출력,
Dashboard query history, 증거 JSON에 넣지 않는다.

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
   - 세 개의 서로 다른 client-side 생성 credential을 psql variable 또는 보호된 local secret
     file로만 주입한다. SQL/인자/process listing/log에 secret을 쓰지 않는다.
   - `password_encryption=scram-sha-256` 세션에서 각 role의 password를 설정하고 LOGIN을 켠다.
   - 현재 host의 direct IPv6는 도달 불가이므로 exact session pooler에서 role별 suffixed login과
     `current_database/current_user/session_user`, TLS를 각각 확인한다. direct role login은 별도
     IPv6-capable runner 전까지 NOT RUN으로 남긴다. URL과 password는 출력하지 않는다. 이 phase의
     exact runner는 안전한 credential path가 확정된 뒤 별도 생성·재검토한다.
3. **G-DB-02 — staging migration**
   - exact migration image index
     `f8d53394a68c7257eb4fc5c6f4d226d6fb96cbd410664992f454cadc649c34fd`와 이 bundle의
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

credential activation, role별 연결, migration, grant, backup/restore, Auth/Storage/app lifecycle은
계속 NOT RUN이다. 완료 조건 전에는 `operationalReady=false`다. production, push, main merge,
tag는 별도 승인 전 실행하지 않는다.
