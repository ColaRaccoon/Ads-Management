# Google OAuth 원 설정 경위와 현재 grant 결속

2026-10-21 KST의 추가 조사로, 현재 노출 Google 자격은 **2026-09-30의 「05단계 Google 수집 구현」 세션에서 gcloud 기본 ADC client로 만든 사용자 OAuth source credential**임을 확인했다. 사용자가 전용 OAuth 앱을 직접 설정한 경위를 다시 찾아올 필요는 없다. 이전의 출처 미확정은 이 기록으로 좁힌다. 실제 철회와 현재 grant 전체 범위·원 사용자 subject의 확정은 별개로 남는다.

## 이전 세션에서 수행한 설정

원 채팅 ID는 `01a0efe0-9e13-77d0-b4b9-6805876c54fa`, 제목은 **05단계 Google 수집 구현**이다. 기존 채팅 도구로 이 세션의 사용자 메시지·실행 기록·제한된 도구 출력을 읽었다. 과거 실행 명령은 재실행하지 않았다.

- 초기 Cloud 계정에서는 프로젝트를 찾지 못했고, 사용자가 본인 계정으로 다시 로그인했다고 답한 뒤 전용 프로젝트를 확인했다.
- 세션에 명시된 Cloud 사용자 계정과 그 사용자의 추가 진행 승인을 찾았다. 개인 이름·이메일 원문은 새 문서와 영수증에 복사하지 않는다. 이는 당시 작업 계정의 근거이며, 아래 token 응답에 원 사용자 subject가 없으므로 token 소유자와의 직접 결속 증거로 확대하지 않는다.
- 전용 서비스 계정에 한정한 Token Creator 설정과 IAM Service Account Credentials API 활성화 후, 에이전트가 공식 Cloud CLI를 준비하고 ADC 로그인 흐름을 실행했다.
- 당시 실행은 `meta-ads-daily-automation` 프로젝트와 `daily-data-automation-ads-read` 서비스 계정의 impersonation을 지정했고 custom client 파일은 지정하지 않았다. 로그인 명령은 성공했고 ADC 저장 완료가 기록됐다. 이 문서에는 재실행 가능한 전체 명령을 복사하지 않는다.
- 저장 직후 확인한 형식은 `impersonated_service_account`, 내부 source는 `authorized_user`, source refresh 존재, 예상 impersonation target 일치였다. 당시 ADC의 source account/scopes 값은 비어 있었다. [05 결과의 인증 경위](05_결과.md)와도 일치한다.

## 현재 자격과 정확히 일치한 증거

현재 `%APPDATA%/gcloud/application_default_credentials.json`과 2026-09-30의 로그인 로그 `gcloud/logs/2026.09.30/10.47.56.922271.log`를 메모리에서만 대조했다. 해당 날짜의 고정 로그5개만 읽었으며 범용 소비자 재조사를 하지 않았다.

| 확인 항목 | 결과와 의미 |
|---|---|
| 현재 client ID·secret·refresh와 원 로그인 로그 | 세 값 모두 정확 일치한다. 같은 refresh를 포함한 token 응답1개를 구조적으로 확인했다. 기존 단순 설정 시점 추정에서 **실제 source refresh의 생성 흐름 결속**으로 강화됐다. |
| source client ID 지문 | `cfb97dad7d896f37931b821cac52078418c6bf19049756af97ad4489fecf19c3`. 기존 소비자 조사 지문과 일치한다. |
| 실제 OAuth client 종류 | 설치된 SDK `googlecloudsdk/api_lib/auth/util.py`의 `DEFAULT_CREDENTIALS_DEFAULT_CLIENT_ID`와 현재 client ID가 정확히 같다. gcloud 일반 client와 ADC 기본 client도 구분했다. 전용 프로젝트에서 만든 custom OAuth client가 현재 source라는 근거는 없다. |
| 당시 요청 | `accounts.google.com /o/oauth2/auth`, offline, 요청 scope `https://www.googleapis.com/auth/cloud-platform`, login hint 없음이다. URL 원문·state·code는 출력하거나 저장하지 않았다. |
| 당시 발급 응답 | 현재 refresh와 정확 일치하는 응답의 scope도 `https://www.googleapis.com/auth/cloud-platform`이다. access token은 포함돼 있었으나 새 출력/복사/사용을 하지 않았다. id token·사용자 email·subject는 없다. |
| 현재 ADC | source가 `authorized_user`이고 예상 서비스 계정 target과 client 지문이 일치한다. source account와 source scopes는 비어 있다. 현재 자격이 유효하다고 시험하거나 refresh하지 않았다. |

원 로그인 로그 SHA256은 `1ca98ad732edc5fb0e37ef7abb7cac0d77ed0da99867d856f600cb7c35043457`이다. 새 영수증은 경로·해시·일치 여부·허용된 scope만 담으며 인증 응답 원문은 담지 않는다.

## 폐기 준비에서 바뀐 점

1. **찾아야 할 승인 항목:** 전용 프로젝트의 `Meta Ads Daily Automation` 동의 화면만 찾는 방식으로는 현재 source grant를 식별할 수 없다. 대상은 이번에 특정한 **gcloud 기본 ADC OAuth client**다. 실제 Google 계정 연결 화면의 표시명은 이번에 관측하지 못했으므로 특정 이름으로 확정하지 않는다. SDK의 기본 client와 custom 앱을 혼동하지 않는다.
2. **철회 영향 범위:** `--project`와 impersonation target이 전용 프로젝트였다는 사실은 source OAuth client도 그 프로젝트 소유라는 뜻이 아니다. 향후 철회 때 전용 프로젝트 앱만 영향받는다고 가정하지 않는다. 같은 사용자의 다른 ADC·도구가 같은 기본 client의 grant에 의존하는지 구분해야 한다. ADC 삭제나 SA IAM 해제로 원 OAuth grant 철회를 대신할 수 없다는 기준은 유지한다.
3. **보존 자격 복사본:** 기존에 확인한 ADC1곳 외에 원 로그인 로그1개에서도 같은 client secret·refresh 자격 복사본을 찾았다. 이는 추가 실행 소비자나 추가 유효 access token1개를 뜻하지 않는다. 로그의 과거 access token은 현재 유효성 미검증이며 사용하지 않았다. 원 로그를 삭제·편집·공개 복사하지 않았고 향후 자격 처분 후 별도 보존 정책에 따라 다룰 대상으로 기록한다.
4. **scope의 확정 범위:** 이 refresh의 원 발급 scope는 `cloud-platform`으로 확인됐다. 현재 사용자-client에 누적된 전체 grant scope와 다른 기기의 승인은 이 과거 응답만으로 확정하지 않는다. 서비스 계정으로 발급받는 Ads용 token의 `adwords` scope와 source OAuth scope도 구분한다.

Google의 [ADC 안내](https://docs.cloud.google.com/java/getting-started/getting-started-with-google-auth-library?hl=ko)는 gcloud ADC가 사용자 인증 정보를 제공하는 경로임을 설명한다. 이 일반 안내보다 위의 실제 client·refresh 일치 증거를 현재 대상 판정의 우선 근거로 삼는다.

## 남은 최소 확인과 실행 경계

이제 사용자가 원 설정 경위를 재구성하거나 OAuth 앱을 처음부터 찾아야 한다고 넘기지 않는다. 에이전트가 확보한 당시 계정 기록과 기본 ADC client 정보를 출발점으로 다음 읽기를 이어갈 수 있다. 개인 계정 식별정보가 필요할 때는 원 채팅의 기존 사용자 확인 메시지를 사용하며 새 공개 파일에 복사하지 않는다.

남은 직접 확인은 **그 계정의 현재 연결 승인 항목과 허용 범위**, 조사 범위 밖에서 같은 grant를 쓰는 도구 여부다. 본인 로그인/MFA가 요구될 때만 사용자가 수행한다. 현재 grant의 원 사용자 subject를 과거 Cloud 작업 계정과 동일하다고 단정하지 않는다. 이번 발급 응답에는 identity claim이 없고 현재 ADC에도 account가 없기 때문이다. 브라우저 제어 차단과 refresh 금지 조건에서 이 직접 결속을 더 증명할 읽기 경로는 확보하지 못했다.

이번 새 영수증: `C:/Users/seong/AppData/Local/MetaAdsPhase10Evaluation/continuation-20261021/google-oauth-origin-read-v1/origin.json`. source ADC·원 로그의 전후 해시와 공개 문서 지문을 새 영수증에 결속한다. 과거 영수증과 로그는 덮어쓰지 않는다.

**이번 Google token 발급·refresh·철회·교체0, IAM 변경0, 운영 변경0, 새 로그인0,11·12 미착수**다. 조직 사용량과 다른 공유 자격은 이번 추가 조사에서 재검증하지 않았다. 운영 NO-GO와 정확20바이트 CDN의 EXCLUDED_LIMITATION을 유지한다.
