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
