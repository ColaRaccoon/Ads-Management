# Supabase 옛 key 인증 거절 확인 완료 — 2026-10-22

**Supabase 정확 노출 공유 key의 소비자 전환·삭제·옛 key 인증 거절·대체 정상 조건은 완료다. 전체 운영 판정은 Cafe24·06의 남은 검증 때문에 NO-GO이며, 11·12는 NOT_STARTED다.** 이전 실행 결과서·미확정 영수증은 당시 이력으로 보존하고 이번 기록으로 이 항목의 최신 판정을 갱신한다.

## 확인 결과

대상은 격리 프로젝트 `ehnfrrmbkvlsbpvqcvkr`의 정확 옛 secret key1개와 이미 발급·보호 저장한 대체 secret key1개다. 운영 Pro 프로젝트의 key나 다른 공유 자격을 변경하지 않았다. 기존 보호 baseline·대체 참조·이전 삭제 영수증의 key ID 해시를 메모리 대조했다.

| 확인 | 10/22 13:58~14:01 KST 결과 |
|---|---|
| 관리 목록 읽기 | 기존 PAT로 HTTP200. 정확 옛 key/ID 부재, 정확 대체 key/ID·secret 종류 존재 |
| 옛 key 인증 요청 | 서버용 User-Agent, `apikey` 헤더에 정확 옛 값 제공. `/auth/v1/settings` GET401. 응답의 API key 관련 부정 인증 문구를 비민감 enum `API_KEY_AUTHENTICATION_REFUSED`로 분류 |
| 대체 key 대조 | 같은 URL·method·User-Agent·헤더 구성에서 key만 대체 값으로 변경한 GET200 |
| 다른 거절 원인 구분 | 사용자 JWT를 보내지 않았고 오류에 browser·JWT·RLS/permission 언급 없음. 개인 로그인·테이블 접근·RLS 빈 결과를 자격 폐기로 해석하지 않음 |
| 캐시 | 옛/대체 요청 모두 `DYNAMIC`, no-cache/no-store 요청. Storage 객체·sentinel·signed URL·CDN은 읽지 않음 |

Supabase 공식 문서는 secret key가 브라우저 형태 `User-Agent`에서401로 거절될 수 있다고 설명한다. 이번 요청은 실제 서버 도구에서 **`MetaAdsPhase10ReadonlyVerifier/1.0`**을 명시해 유효한 대체 key까지 거절되는 변수를 제거했다. 이것은 새 key 발급·브라우저에서의 secret 사용·보호 기능 해제가 아니다. [Supabase API key 공식 문서](https://supabase.com/docs/guides/getting-started/api-keys)

이전 `/auth/v1/settings` 및 REST 검사의 old/new 모두401은 대체 정상 대조가 없어 판별 근거가 되지 못했다. 이번에는 대체200·옛401의 차이를 확보했다. 이전 검사의 실제 전송 User-Agent 바이트를 보존하지 않았으므로 과거 실패의 원인이 User-Agent였다고 단정하지 않는다. 이전 `AccessDenied`400을 뒤늦게 명시적인 인증 거절로 바꾸지도 않는다.

응답 메시지를 한정된 `Invalid API key` 문구와만 비교한 초기 새 영수증들은 분류 미완료로 남아 있다. 최신 `resolved-auth-result.json`은 HTTP401, API key 관련 부정 문구, 올바른 옛 헤더 제공, 동일 조건 대체200, 관리 목록 부재/존재를 함께 결속한 결과다. 원문 인증 응답·메시지·키·헤더는 공개 파일에 저장하지 않았고 enum/불리언/상태만 기록했다. 같은 검사를 더 반복하지 않는다.

## 기존 전환 근거와 완료 범위

기존 `shared-credential-execution-v1/`의 `supabase-result.json`은 정확 옛 key DELETE200과 cloud08의 해당 key 변수만 `skipDeploys=true`로 전환한 근거다. `supabase-local-consumers-result.json`은 알려진 로컬 보호 참조2곳의 전환과 나머지 값·이전 암호화 바이트 보존 근거다. 이번에는 이 전환을 반복하거나 Railway 현재 실행 상태를 읽지 않았다. 과거 cloud 전환→삭제→로컬2곳 전환이라는 순서 차이도 그대로 보존한다.

최신 검증은 알려진 소비자 전환과 정확 key의 관리 삭제·비캐시 인증 거절·대체 정상에 한정한다. 사용자 확인으로 외부 소비자는 없으며 이 질문을 다시 요구하지 않는다. 정확20바이트 sentinel의 CDN 잔여는 그대로 **EXCLUDED_LIMITATION**이다. 모든 과거 URL 캐시의 전역 제거를 주장하거나 이 예외를 다른 객체·자격으로 확대하지 않는다.

## 남은 작업

이 항목에서 사용자 본인 작업은 없다. 기존 Google·Meta 완료 증거와 이번 Supabase 완료를 유지한다. 남은 자격 묶음은 **Railway의 기존 이미지 재사용/Redeploy 복구 후06 같은 이미지 재개, 실제 새 Cafe24 secret 정상 인증과 정확 옛 secret 명시 인증 거절**이다. 틀린 코드에 대한 `invalid_grant`로 Cafe24 secret 유효·무효를 판정하지 않는다는13:03 KST 정정도 유지한다.

Railway 자동 확인은30분 간격으로 유지한다. 복구 전 로그인·재개·Cafe24 자격 검사를 반복하지 않고, 복구 뒤 필요한 본인 로그인/MFA/OAuth 동의만 요청한다. 운영 제품 배포·08 기동·11·12는 실행하지 않는다.

증거는 `C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/continuation-20261022/supabase-old-key-auth-v1/`의 `result.json`, `classification.json`, `final-auth-result.json`, **`resolved-auth-result.json`**, `closeout.json`에 보존한다. 앞의 중간 미분류 파일은 덮어쓰지 않았다. `closeout.json`은 최신 판정·기존 참조·문서와 helper/영수증 해시·비밀값 출력 방지 확인을 결속한다.

**이번 실행:** 실제 자격 발급·refresh·교체·폐기0, 운영/06 배포0, 변수·DB migration·IAM·예약·과금 변경0, 고객/DB 행·객체·CDN 읽기0, 새 수집0, 외부 메시지0, 기존 검사·빌드 반복0,11·12 미착수. Management GET1회와 인증 읽기 GET6회만 실행했다.
