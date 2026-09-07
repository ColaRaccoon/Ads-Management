# 2026-09-07 G-SUP-STG-03 확장 조회

## 승인·경계

- 사용자 승인 수신 확인: 2026-09-07 05:17:49 UTC.
- 시작 HEAD `97ceed010ede6f5142cd0d4ea795fca6c72a588a`, branch `codex/security-rbac`.
  시작 staged/unstaged/untracked 변경 없음. 사용자 변경 제거 없음.
- 승인 대상 org `synohgzwspodxmfemoks`, project `ehnfrrmbkvlsbpvqcvkr`만 조회한다.
  production과 보호된 공유 계정은 조사·변경하지 않는다.
- `진행상태.md`의 G-SUP-STG-03 확장 승인안이 범위다. provider mutation/secret reveal/
  Auth 사용자 목록/Storage object 목록/원문 로그 조회, SQL 별도 저장·공유는 하지 않는다.
- main은 UI·SQL·문서·commit 담당, B는 SQL/source/checksum 읽기 전용 조사,
  D는 exact SQL과 결과의 독립 평가 담당이다. `operationalReady=false` 유지.

## Dashboard metadata (이번 조회)

- 약 05:20–05:30 UTC: 지정 project 이름/Free/Healthy/Seoul `ap-northeast-2`,
  NANO/t4g.nano 일치. Overview는 Last migration `No migrations`, Last backup `No backups`.
  이것은 Prisma history 또는 restore 검증이 아니다.
- 직접 연결 표시: `db.ehnfrrmbkvlsbpvqcvkr.supabase.co:5432`, database `postgres`,
  표시 사용자 `postgres`, IPv6 기본. 이는 실제 접속 principal/연결 성공을 증명하지 않는다.
- IPv4 session pooler 표시: `aws-0-ap-northeast-2.pooler.supabase.com:5432`,
  database `postgres`, 표시 사용자 `postgres.ehnfrrmbkvlsbpvqcvkr`.
  URI에는 비밀번호 placeholder만 있었고 reveal/copy/reset하지 않았다.
- DB Settings: pool size 15, max client 200, SSL enforcement OFF, 모든 IP 허용 표시.
  값 변경/인증서 다운로드/접속 시도 없음. `verify-full`/connection limit 2/최소권한 NOT RUN.
- Scheduled backups: Free plan은 project backups 미포함 표시. 유료 전환/backup/restore 없음.
- General settings: provisioned Postgres version `17.6.1.155`, upgrade candidate
  `17.6.1.166` 표시. 업그레이드 없음. SQL server version은 아래 실제 실행 결과와 구분한다.
  화면에 부수 표시된 조직 사용자 정보는 증거 문서에 복제하지 않는다.
- Auth 설정은 이번 turn 아직 새로 확인하지 않았다. 과거 설정을 이번 fresh 결과로 쓰지 않는다.

## SQL 검토·실행

- SQL Editor는 빈 `/sql/new`에서 시작했다. 최신 안내는 snippets가 자동 저장되지 않으며
  Save를 눌러야 저장된다고 설명했다. Save/공유는 누르지 않는다.
- 첫 draft SHA256 `ddb047bf0b3bd10ce90254fc3f27f1f0cfbf04aece2b74145c7803498d29051b`
  는 D의 출력량 제한 P2 지적에 따라 **실행하지 않고** 보완했다.
- 보완 draft `증거/0907-staging-inventory-phase1.sql` SHA256
  `49cd8a1461c1f6c1e0cccdbdb1d5ce520ec85f52a0f24d7929674b3a8c47e8ed`:
  read-only transaction, timeout 5s/lock 1s, 순수 catalog, 관계256/컬럼2048/enum128
  상한과 전체 count/truncated, Auth/Storage 필요 column whitelist, 보호 owner 제외.
- D의 exact SQL 정적 재평가 PASS, 출력 상한 P2 CLOSED, 신규 P0–P3 0.
  main도 전체 본문을 검토했다. 보호 owner 필터 결과만으로 pristine/NOT PRESENT를 확정하지 않는다.
- 실제 UI 입력은 두 차례 `Text area did not retain the requested value` 오류였다.
  첫 입력에는 Monaco 자동 들여쓰기가 관찰됐고, D가 검토한 공백만 단일행으로 바꾸는
  두 번째 입력도 보존 확인에 실패했다. 전체 선택 화면은 첫 입력과 후속 입력의 혼합을 보여
  exact SQL 일치를 확인할 수 없었다. **Run/Run selected/Save는 누르지 않았다.**
- 약 05:35 UTC 추가 입력·SQL 실행을 중단했다. 직접 만든 미저장 초안만 Close tab →
  Discard changes로 폐기했고 빈 `/sql/new`, `No private queries created yet`, disabled Save를
  확인했다. 검토된 로컬 SQL 파일은 남아 있어 복구 가능하다. 기존 사용자 query/기록 삭제 없음.
- DB transaction을 시작하지 않아 DB ROLLBACK 실행도 필요하지 않았다. provider의 부수 UI/audit
  기록은 조사·삭제하지 않았다. 이것은 DB permission/timeout 오류가 아니라 UI 입력 검증 실패다.
- **SQL catalog/server major/role/grant/Prisma history/Auth count/reference/Storage 집계 전부
  NOT RUN**이다. read-only 적용 성공 역시 주장하지 않는다. 확장 gate 전체는 PARTIAL/BLOCKED.

## Frozen migration 비교

- B가 frozen `eb4d4675201e2605f7d5b6b5c5dd5c37c7c1719d` Git raw blob과
  exact source ZIP `cbe89bfe01e0fad7cc8936e8e57ebbfaa04e2887c49ac7e74a2967f37b511135`
  의 migration.sql 37개를 읽기 전용 비교했다. 모두 LF이며 raw bytes/SHA256/크기 37/37 동일.
- release.ts는 줄바꿈 정규화 없이 raw Buffer SHA256을 사용하고 DB checksum과 정확 비교한다.
  다른 archive 파일들의 CRLF를 migration에 일반화하지 않는다. 이번 이미지 내부 bytes
  재조회는 하지 않았으며 실제 DB migration history/checksum 비교도 아직 NOT RUN.
- 기존 backup image의 pg_dump 15.19와 Dashboard PG17 표시의 호환성은 후속 blocker다.
  이 결과를 backup 성공 또는 운영 준비 완료로 기록하지 않는다.

## 다음 안전한 단계와 release 경계

- 승인 재요청 문제가 아니라 SQL Editor 입력·검증 경로의 한계다. 사용자가 검토된 SQL을
  exact staging의 새 빈 SQL Editor에 그대로 붙여 넣어 실행하고 `inventory_json` 결과만
  전달하면 후속 집계는 실제 확인된 table/column과 별도 D 검토를 바탕으로 준비할 수 있다.
  비밀번호·API key·Auth 사용자 목록·SQL 로그는 전달하지 않는다. 오류/readonly 미확인 시 중단한다.
- source 읽기 전용 조사 결과 backup Dockerfile은 무버전 `postgresql-client`와 실행 파일 존재만
  검사하며, provider에는 dump 전 client/server major 사전 검사가 없다. PG17 target에는 검증된
  PG17 client와 fail-closed 버전 검증/test 보완이 필요하다. 이번 source 수정/빌드/scan은 없다.
- 향후 source/image 수정은 frozen tuple 변경이다. 기존 6-image/13-CVE G-REL-01을 새 digest에
  이월하지 않는다. 새 빌드/검증/독립 평가, 승인된 metadata scan과 필요한 새 위험 수용을 거친다.
  현재 발견은 새 CVE를 주장하는 것이 아니며 기존 위험 수용의 원래 범위/만료를 바꾸지 않는다.
- actual backup/restore/직접 TLS/role/migration/Auth/Storage/app deployment는 NOT RUN,
  `operationalReady=false`. provider mutation/push/main merge/tag 없음.
- D의 최종 문서·handoff 독립 평가 PASS, 해당 범위 신규 P0/P1/P2/P3 0.
  이는 main의 UI 관찰 기록과 로컬 source/SQL 대조 평가이며 D의 별도 실제 DB 실행이 아니다.
  기존 actual-backup blocker와 SQL NOT RUN은 유지한다. main 전체 diff/`git diff --check` PASS.

## 사용자 수동 실행으로 해소된 Phase 1 (05:39–05:40 UTC)

- 사용자가 검토 SQL을 실행한 결과 `C:\Users\seong\Desktop\rs.txt`를 전달했고,
  이어 **exact staging `ehnfrrmbkvlsbpvqcvkr`에서 실행했다**고 명시 확인했다. 함께 전달한
  화면은 `Meta Ads Performance Security Dev` org/project, Free, SQL 결과 1 row와 쿼리 하단의
  LIMIT/ROLLBACK을 보여준다. 화면만으로 ref를 읽을 수 없으므로 사용자 확인과 함께 결속한다.
- 외부 원본 증거: rs.txt 1,922 bytes, SHA256
  `a68ce0e26ab3267af637c28a29d6740210d64fe67a8f460a6c0ec67d73905ba0`;
  screenshot 118,079 bytes, SHA256
  `5b00aff2232fe528715acc8e1e7c4004f01b3773ec9f733d35eca327ad249b09`.
  비밀 없는 정규화 전사는 `증거/0907-staging-inventory-phase1-result.json`에 보존하며
  SHA256은 `699df19f62e506fefa4f5d58429e46e824f4d52bc7d4716deab2110820535df9`다.
  JSON key 순서를 무시한 원본과 전사의 의미 비교는 `SEMANTIC_MATCH`다.
- Phase 1 catalog 결과: `transaction_read_only=on`, statement/lock timeout `5s`/`1s`,
  PostgreSQL `17.6` (`170006`), current database/principal `postgres`/`postgres`,
  relation/column/enum count `3/13/0`, `truncated=false`.
- 허용 catalog에 보인 relation은 `auth.users`, `storage.buckets`, `storage.objects`뿐이며
  셋 모두 RLS ON/forced OFF다. public relation/enum은 0이다. 이는 보호 owner 제외 범위이며
  pristine/full schema/Prisma history 부재를 확정하지 않는다. RLS ON만으로 anonymous/
  authenticated 실제 deny 또는 exact bucket 보호를 PASS 처리하지 않는다.
- D가 원본 text·screenshot과 해시, 결과/SQL 경계를 독립 검토했다. Phase 1 제한 catalog
  조회만 PASS, 신규 P0/P1/P2/P3 0. Auth/Storage data aggregate, role/grant, policy 효과,
  migration history, backup/restore와 운영 준비는 계속 NOT RUN이다.
- PostgreSQL 17은 이제 Dashboard 표시뿐 아니라 SQL server major로도 확인됐다.
  pg_dump 15.19 호환성 blocker의 근거가 강화됐으며 해소된 것이 아니다.

## 후속 집계 계약

- main과 B가 Auth/Storage 데이터 참조에는 Phase 1에서 실제 확인된 relation/column만 사용하고,
  권한 쿼리는 PG17 catalog를 사전 정적 검토해 둘로 분리했다. D가 아래 exact bytes를
  독립 정적 검토했으며 신규 OPEN P0/P1/P2/P3 0이다.
- Phase 2a `증거/0907-staging-inventory-phase2a-auth-storage.sql`, SHA256
  `3093ced8e894cb79011e473c11dcc321157a091238af600ff07b843f8b5c8a4c`:
  Auth 상태·정규화 중복 숫자, exact bucket 설정/object 수, 다른 bucket 수, Storage table별
  policy command/direct-role 집계만 반환한다. 이메일/UUID/object key/다른 bucket 이름/
  policy 이름·식은 출력하지 않는다. Auth 10,000행, policy 64그룹, MIME 32개×128자
  상한 초과와 exact bucket 불일치/RLS-visible subset은 성공 대신 BLOCKED다.
- Phase 2b `증거/0907-staging-inventory-phase2b-roles-acl.sql`, SHA256
  `76012752936b39767a6a8973ddc2d78de10e9e4ca0eba6a4585aef5d30ff095f`:
  비밀 아닌 role 속성, PG17 direct membership 옵션, 현재 DB/세 schema/허용 relation ACL,
  future default ACL을 bounded JSON으로 반환한다. `pg_authid`/password/role config/정책식은
  조회하지 않으며 보호 principal이 owner/member/grantor/grantee인 관련 항목을 제외한다.
- 두 쿼리 모두 `BEGIN READ ONLY`, 5s/1s timeout, PostgreSQL `170006`, DB/principal
  `postgres`, Phase 1 catalog 상태를 guard하고 마지막에 `ROLLBACK`한다. Phase 2a는 성공
  status `INVENTORY_ONLY`, Phase 2b는 `SCOPED_CATALOG_INVENTORY_ONLY`여야 한다.
- 실행 순서는 2a 먼저다. SQL 오류 또는 `BLOCKED_*`이면 즉시 중단하고 2b를 실행하지 않는다.
  2a 성공 후에만 2b를 실행한다. 새 빈 exact staging SQL Editor를 사용하고 Save/공유하지 않으며
  각 `inventory_json` 결과만 전달한다. production ref 화면에서는 실행하지 않는다.
- role/ACL 결과는 protected-filtered direct catalog inventory다. empty/null ACL, 빠진 object,
  transitive membership, schema/column/sequence 권한과 실제 effective 권한은 UNKNOWN/NOT RUN이며
  이를 최소권한 PASS로 격상하지 않는다. Storage policy 집계도 exact bucket deny 증거가 아니다.

## 사용자 수동 실행으로 완료된 Phase 2a (07:26 UTC)

- 사용자가 위 exact Phase 2a SQL의 `inventory_json`을 대화에 전달했다. 함께 전달한 화면은
  `Meta Ads Performance Security Dev` org/project, Free, 결과 1 row, SQL 하단의 LIMIT/ROLLBACK을
  보여준다. 이전 exact staging 확인과 연속된 실행 증거로 결속한다.
- screenshot 115,977 bytes, SHA256
  `cce54d27e39d89917073ec7edc6060866c695dbb2a7f649f0f205d285c818709`.
  비밀 없는 결과 전사는 `증거/0907-staging-inventory-phase2a-result.json`, SHA256
  `bf6ae285e346e404147161a829196d49917b6a55621b9a795b59988aeb94072d`다.
- guard/result는 `INVENTORY_ONLY`, read-only ON, 5s/1s timeout, server `170006`,
  RLS-visible subset filtering false다. Phase 2a의 성공 조건을 충족했다.
- Auth: 총 1명, email confirmed 1명. unconfirmed/deleted/currently banned/anonymous/
  missing email/invalid nonempty email/normalized duplicate group·extra user는 모두 0이다.
  기존 “약 10명” 정보는 fresh aggregate와 불일치하므로 현재 근거로 사용하지 않는다.
  삭제·유실·project 변경 등 원인을 추정하지 않으며 이번 작업의 Auth mutation은 0이다.
  이 duplicate 결과는 API의 320자 ASCII normalizer 기준일 뿐 maintenance/provider의 별도
  254자 규칙, Auth 로그인 또는 provider identity 연결 PASS가 아니다. staging test identity
  구성은 후속 Auth gate에서 다룬다.
- exact bucket `meta-ads-security-step7-dev`: private, 50 MiB (`52428800` bytes),
  object 0, MIME allow-list NULL/0개. 다른 bucket 0개다.
- `storage.buckets`/`storage.objects`는 RLS ON/forced OFF이고 보호 대상 제외 table-level
  policy와 command/direct-role group 집계는 0이다. 실제 anon/authenticated deny/allow,
  exact bucket scoped access, lifecycle과 앱 요구 policy의 존재·적합성은 계속 미확인/NOT RUN이다.
- 허용 public AppUser relation이 없어 Auth-AppUser reference/collision은 NOT RUN이다.
  migration/schema가 준비됐다는 뜻이 아니다.
- Phase 2a 제한 집계만 PASS다. Phase 2b role/ACL은 이제 실행 가능하지만 아직 NOT RUN이다.
  그 결과도 effective 최소권한 PASS가 아니며, 오류/`BLOCKED_*`이면 즉시 중단한다.
- D가 screenshot/hash와 부모가 전달한 사용자 JSON semantic decode를 보존 전사와 독립
  canonical 비교해 전체 일치를 확인했다. 최종 문서·증거 평가 PASS, 신규 OPEN P0/P1/P2/P3 0.
  이는 D가 채팅의 raw escape 변환 자체를 별도로 관찰했다는 의미는 아니다.
