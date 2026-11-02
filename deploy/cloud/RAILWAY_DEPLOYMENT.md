# Railway 운영 배포 절차와 권한

2026-10-28에 `patimagroup-work.com`에 실제 적용한 배포 절차다. 다른 세션은 아래 대상과 현재 도구 권한을 다시 확인한 뒤, 사용자가 허용한 변경 범위에 적용한다. 이 문서를 읽는 것만으로 배포 권한이 생기지는 않는다.

## 운영 대상

| 항목 | 확인한 값 |
| --- | --- |
| GitHub 저장소 | `ColaRaccoon/Ads-Management` |
| 배포 소스 브랜치 | `codex/google-daily-d1-d7` |
| Railway 프로젝트 | `meta-ads-security-staging` |
| 프로젝트 ID | `6fe72710-1fc8-445a-a77f-da2da8fee200` |
| 환경 이름 / ID | `staging` / `01ab3d5a-1036-45b0-aa9c-47179339c9be` |
| 운영 서비스 / ID | `grand-fascination` / `b0835b08-7799-4c1c-8bcd-90746b9d4248` |
| 사용자 접속 주소 | `https://patimagroup-work.com` |
| Dockerfile | `deploy/cloud/production-reporting.Dockerfile` |
| 시작 명령 | `setpriv --no-new-privs node deploy/cloud/production-source-launch.mjs` |

**이름에 staging이 있어도 위 서비스는 실제 운영 사이트다.** 같은 프로젝트의 `patima-marketing` 서비스나 별도 `cafe24-order-read-test` 프로젝트를 대신 선택하지 않는다.

2026-10-28 확인 당시 이 프로젝트에는 환경이 하나였고, 운영 서비스는 특정 커밋에 고정돼 있었다. `connect_service_source`의 즉시 적용은 서비스의 모든 환경에 영향을 주므로 실행 전에 환경 목록과 실제 도메인을 확인한다. 환경이 늘어났다면 이 문서의 단일 환경 전제를 그대로 적용하지 않는다.

## 필요한 권한

아래 표는 실제 작업에 필요한 기능 권한이다. Railway 요금제별 역할 이름을 추정한 목록은 아니다.

| 구분 | 필요한 권한 또는 조건 | 확인 방법 |
| --- | --- | --- |
| 사용자 요청 | 해당 변경을 해당 운영 서비스에 배포할 수 있는 작업 범위 | 현재 대화의 지시·승인 확인 |
| Codex 실행 환경 | 저장소 수정, 필요한 Git 작업, 허용된 네트워크 실행 | 현재 세션의 권한·승인 정책과 실제 실행 결과 확인 |
| Railway 연결 도구 | 프로젝트·서비스 조회, 서비스 소스 변경 및 배포, 상태·로그 조회 | 도구 검색 후 현재 스키마 확인, 서비스 조회 |
| Railway 환경변수 | 해당 서비스의 `RELEASE_GIT_SHA` 수정 | `set_variables` 또는 허용된 CLI 사용 |
| GitHub | 대상 저장소·브랜치에 일반 push 가능 | 원격 주소와 push 결과 확인 |
| Railway의 GitHub 연결 | Railway가 위 저장소의 지정 커밋을 읽고 빌드할 수 있음 | 현재 소스 연결과 배포 빌드 결과 확인 |
| CLI 사용 시 | 로컬 Railway CLI가 대상 프로젝트에 접근 가능한 계정으로 인증됨 | `railway whoami`, 대상 조회 등 허용된 읽기 작업 |
| 운영 준비 상태 확인 | `INTERNAL_PROBE_TOKEN`을 기존 승인된 실행 환경에서 사용할 수 있음 | 아래 준비 상태 확인 스크립트 |

연결 도구의 로그인과 CLI 로그인은 각각 확인한다. 서비스 조회에 성공했다는 사실만으로 쓰기 권한까지 확인됐다고 기록하지 않는다.

Codex의 샌드박스는 명령이 접근할 파일·네트워크를, 승인 정책은 승인 요청 방식을 제어한다. MCP·앱 연결에는 별도 통제가 적용된다. 따라서 로컬 명령 허용과 Railway 쓰기 권한은 같은 것이 아니며, 승인 프롬프트가 없다는 사실도 외부 서비스 권한을 부여하지 않는다. [OpenAI 공식 권한 문서](https://learn.chatgpt.com/docs/agent-approvals-security)

이전 세션에서 차단됐던 이유는 해당 세션의 거절 기록을 확인해야 알 수 있다. 이번 작업에서는 Codex 권한 설정이나 Railway 계정 역할을 변경하지 않았다. 다른 세션에 전체 접근 권한을 일괄 부여하는 설정은 이 절차의 선행 조건이 아니다.

## 1. 대상과 변경 범위 확인

연결된 Railway 도구를 검색하고 현재 스키마를 읽는다. 이번 세션의 도구 이름은 `mcp__codex_apps__railway_*`였으며 다른 세션에서는 접두사나 제공 기능이 다를 수 있다.

- `list_services`: 프로젝트의 환경과 서비스 확인.
- `describe_service`: 도메인, 소스 저장소·브랜치·고정 커밋, Dockerfile, 시작 명령, 보류 중 변경 확인.
- `list_deployments`: 현재 정상 배포 ID와 소스 SHA 기록.

알 수 없는 보류 중 변경이 있다면 이번 배포에 함께 포함하지 않는다. 저장소에서도 다음을 확인한다.

```powershell
git status --short
git diff --cached --name-only
git branch --show-current
git remote get-url origin
```

다른 세션의 미커밋 변경을 되돌리거나 배포 커밋에 섞지 않는다. 이번 작업도 기존 통합 성과측정 변경은 제외하고, Cafe24 수정에 해당하는 부분만 커밋했다. 같은 파일에 변경이 섞여 있다면 파일 전체를 stage하지 말고 해당 변경 부분만 분리한다.

## 2. 검증하고 로컬 커밋 생성

변경에 맞는 테스트와 타입·빌드를 실행한다. 필요한 스키마 변경은 운영 코드와 호환되는 순서로 적용하고, 적용 결과를 별도로 확인한다. 코드 배포가 DB 마이그레이션이나 주문 재처리까지 자동 실행해 주지는 않는다. 운영 DB에 `prisma migrate dev`를 실행하지 않는다.

```powershell
npm run prisma:validate
if ($LASTEXITCODE -ne 0) { throw 'Schema validation failed' }
npm --workspace @meta-ads-performance/api run lint
if ($LASTEXITCODE -ne 0) { throw 'API typecheck failed' }
npm --workspace @meta-ads-performance/web run lint
if ($LASTEXITCODE -ne 0) { throw 'Web typecheck failed' }
npm run build
if ($LASTEXITCODE -ne 0) { throw 'Build failed' }
```

배포할 커밋의 파일 구성도 확인한다. 작업 폴더 전체에서 성공했더라도 미추적 파일에 의존하면 원격 빌드에서 실패할 수 있다.

검토한 파일·변경 부분만 stage하고 커밋한 뒤 SHA를 얻는다.

```powershell
git diff --cached --stat
git diff --cached --check
if ($LASTEXITCODE -ne 0) { throw 'Staged diff check failed' }
# 검토한 변경만 staged 상태인 것을 확인한 뒤 실행
git commit -m "변경 내용을 설명하는 제목"
if ($LASTEXITCODE -ne 0) { throw 'Commit failed' }
$releaseSha = (git rev-parse HEAD).Trim()
if ($releaseSha -cnotmatch '^[a-f0-9]{40}$') { throw 'Invalid release SHA' }
```

## 3. 릴리스 SHA 설정 후 push

현재 Dockerfile은 `RAILWAY_GIT_COMMIT_SHA`를 이미지의 릴리스 SHA로 기록한다. 실행 환경의 `RELEASE_GIT_SHA`가 이 값과 다르면 시작 검증에서 거절된다.

**현재 서비스가 커밋 고정 상태인지 먼저 확인한다.** 이 절차는 고정 상태에서 환경변수를 먼저 맞추고, 원격에 push한 뒤 지정 커밋을 배포하는 순서다. 브랜치 자동 배포로 바뀌었다면 push 자체가 배포를 유발할 수 있으므로 기존 순서를 그대로 실행하지 않는다.

다음 JavaScript는 Codex 도구 호출 예시이며 일반 터미널에서 그대로 실행하는 명령은 아니다. 현재 제공되는 도구 스키마에 맞춰 호출한다. `skipDeploys: true`는 변수 변경에 따른 중간 재배포를 막는다. `staged: true`와는 다르며, 변수 자체는 즉시 저장된다.

```javascript
await tools.mcp__codex_apps__railway_set_variables({
  projectId: "6fe72710-1fc8-445a-a77f-da2da8fee200",
  environmentId: "01ab3d5a-1036-45b0-aa9c-47179339c9be",
  serviceId: "b0835b08-7799-4c1c-8bcd-90746b9d4248",
  variables: { RELEASE_GIT_SHA: releaseSha },
  skipDeploys: true
});
```

이번 실행에서는 이 단계에 아래 CLI 명령을 사용했다. 확인한 CLI 버전은 `5.71.0`이다. 다른 버전을 사용한다면 먼저 해당 명령의 `--help`를 확인한다. 도구가 필요한 기능을 제공하면 연결 도구를 우선한다.

```powershell
npx --yes @railway/cli@5.71.0 variable set `
  --project 6fe72710-1fc8-445a-a77f-da2da8fee200 `
  --service b0835b08-7799-4c1c-8bcd-90746b9d4248 `
  --environment 01ab3d5a-1036-45b0-aa9c-47179339c9be `
  --skip-deploys "RELEASE_GIT_SHA=$releaseSha"
if ($LASTEXITCODE -ne 0) { throw 'Release binding failed' }

git push origin HEAD:refs/heads/codex/google-daily-d1-d7
if ($LASTEXITCODE -ne 0) { throw 'Push failed' }
git ls-remote origin refs/heads/codex/google-daily-d1-d7
if ($LASTEXITCODE -ne 0) { throw 'Remote verification failed' }
```

원격 ref의 SHA가 `$releaseSha`와 같은지 확인한다. 이 값을 다음 도구 호출에도 그대로 사용한다. 환경변수를 변경한 뒤 배포를 중단해야 한다면, 이전 정상 릴리스의 SHA와 설정을 확인해 변수도 일치시키고 남은 상태를 기록한다.

## 4. 검증한 커밋으로 실제 배포 시작

아래 JavaScript 예시의 `releaseSha`에는 앞에서 확인한 새 커밋의 전체 SHA를 넣는다. PowerShell 변수와 도구 실행 환경의 JavaScript 변수는 자동으로 공유되지 않는다.

```javascript
await tools.mcp__codex_apps__railway_connect_service_source({
  projectId: "6fe72710-1fc8-445a-a77f-da2da8fee200",
  serviceId: "b0835b08-7799-4c1c-8bcd-90746b9d4248",
  repo: "ColaRaccoon/Ads-Management",
  branch: "codex/google-daily-d1-d7",
  commitSha: releaseSha
});
```

**이 호출이 새 빌드·배포를 시작한다.** 이번 실행에서 사용한 핵심 배포 작업이다. `commitSha`를 지정하면 서비스가 그 커밋에 고정되므로 이후 push만으로 다음 버전이 배포되지는 않는다.

`create_deployment`는 새 서비스를 만드는 도구이므로 기존 운영 서비스의 업데이트에 사용하지 않는다. `redeploy`는 기존 빌드를 재사용하는 도구이므로 새 소스 커밋을 빌드하는 위 호출과 구별한다. 이번 방식에는 SSH 접속·새 SSH 키·로컬 Docker 데몬이 필요하지 않았다.

## 5. 배포와 운영 응답 확인

`list_deployments`에 위 project/environment/service ID를 명시하고, 새 배포의 ID·상태·커밋 SHA를 확인한다. 빌드 실패 시 `get_logs`의 `types: ["build"]`, 실행 실패 시 `types: ["deploy"]`를 사용한다. 오래 걸리는 동안 동일 상태를 반복 조회하지 말고 간격을 둔다.

`SUCCESS` 확인 후 실제 운영 주소의 준비 상태와 화면을 확인한다. 준비 상태 API의 정확한 헤더는 **`x-internal-probe-token`**이다. `x-internal-probe`는 403을 반환했다.

다음 내용을 로컬 임시 `.mjs` 파일로 저장한다. 토큰은 파일에 넣지 않고 기존 Railway 환경에서만 읽는다. `EXPECTED_RELEASE_SHA`는 새 SHA로 교체한다.

```javascript
const expected = "EXPECTED_RELEASE_SHA";
const token = process.env.INTERNAL_PROBE_TOKEN;
if (!/^[a-f0-9]{40}$/.test(expected) || !token) throw Error("PROBE_INPUT_REQUIRED");
const response = await fetch("https://patimagroup-work.com/backend-api/health/ready", {
  redirect: "error",
  headers: { "x-internal-probe-token": token },
  signal: AbortSignal.timeout(20000)
});
const body = await response.json();
if (!response.ok || body.status !== "ready" || body.releaseId !== expected ||
    !body.runtimeConfigFingerprint) throw Error("DEPLOYMENT_NOT_VERIFIED");
console.log(JSON.stringify({ ready: true, releaseId: body.releaseId }));
```

허용된 CLI 실행 환경에서 다음과 같이 실행한다.

```powershell
# $probePath에는 위 내용을 저장한 기존 로컬 .mjs 파일의 절대 경로를 지정한다.
npx --yes @railway/cli@5.71.0 run `
  --project 6fe72710-1fc8-445a-a77f-da2da8fee200 `
  --service b0835b08-7799-4c1c-8bcd-90746b9d4248 `
  --environment 01ab3d5a-1036-45b0-aa9c-47179339c9be `
  --no-local -- node $probePath
if ($LASTEXITCODE -ne 0) { throw 'Readiness verification failed' }
```

CLI `run`은 원격 컨테이너의 SSH 명령이 아니라 **서비스 환경변수를 사용하는 로컬 프로세스 실행**이다. 따라서 인증된 CLI와 로컬 Node 실행·필요한 환경변수 접근 권한이 있어야 한다. 환경 전체, `DATABASE_URL`, 토큰, 요청 헤더를 출력하거나 문서에 복사하지 않는다.

## 차단과 실패를 구별하는 방법

| 증상 | 구분과 대응 |
| --- | --- |
| Codex 승인 검토 거절, 명령·MCP 실행 차단 | 거절한 동작과 이유를 확인한다. 동일 동작을 다른 도구로 우회하지 않는다. 필요한 사용자·관리자 조치 또는 수동 배포로 인계한다. |
| Railway 도구 없음 | 현재 연결·도구 제공 여부를 확인한다. 기능 부재이고 CLI 사용이 별도로 허용돼 있다면 인증된 CLI의 지원 기능을 검토한다. 권한 거절을 기능 부재로 취급하지 않는다. |
| Railway 401/403 | 연결 계정의 인증·프로젝트 접근·쓰기 권한 확인. Git push 성공과 별개다. |
| GitHub push 또는 Railway 저장소 접근 실패 | Git 인증, 브랜치 제한, Railway의 GitHub 저장소 연결 확인. |
| push 후 새 배포 없음 | 서비스의 커밋 고정 여부 확인. 고정돼 있다면 4단계로 새 SHA를 지정한다. |
| `Unreviewed C7 API change` | 계정 권한이 아닌 저장소의 빌드 검증 실패다. 아래 검증 목록 절차를 따른다. |
| `Expected patch changes missing` | 검토 목록과 실제 빌드 산출물 차이 확인. 누락·불필요한 항목을 검토한다. |
| 릴리스 SHA 불일치 | 배포 커밋, 이미지 SHA, 서비스 `RELEASE_GIT_SHA`의 일치 여부 확인. |
| 준비 상태 403 | `x-internal-probe-token`과 승인된 기존 토큰 확인. 인증 검사를 제거하지 않는다. |
| `railway ssh`에 SSH 키가 없음 | 이번 배포 경로는 SSH가 필요 없다. 배포를 위해 새 SSH 접근 권한을 만들 필요가 없다. |

### 빌드 검증 목록

[verify-source-setup-patch.mjs](verify-source-setup-patch.mjs)는 고정된 C7 기준 이미지와 비교해 검토한 API 모듈만 바뀌었는지 확인한다. 이번 첫 빌드는 새로 수정한 `daily-sync/cafe24-canonical-fingerprint.js`가 목록에 없어 중단됐다. 실제 변경을 검토한 뒤 Cafe24 관련 모듈 9개만 명시적으로 추가하고 [검증 테스트](../../scripts/verify-source-setup-patch.test.mjs)를 통과시켜 재배포했다.

다음 변경도 실패 로그에 나온 파일을 무조건 허용하지 않는다. 소스 diff와 생성되는 모듈을 대조해 필요한 범위만 반영한다. 검증 명령 자체를 지우거나 와일드카드로 넓히지 않는다.

```powershell
node --test scripts/verify-source-setup-patch.test.mjs
if ($LASTEXITCODE -ne 0) { throw 'Deployment scope test failed' }
```

## 2026년 10월 28일 실제 완료 기록

- 변경: Cafe24 상품명·원본 옵션값 분리 및 각각의 포함·제외 매핑.
- 최종 배포 커밋: `1802414ef28fd6016530df2246dc3e211fc5d615`.
- 성공 배포 ID: `54e89cb3-d72c-421c-a0e5-07c7a78c43be`.
- 소스 커밋 고정, Railway 배포 상태 `SUCCESS`, 운영 준비 상태 HTTP 200과 동일 `releaseId` 확인.
- 기존 주문의 원본 옵션 보충 및 방한마스크 재매핑은 코드 배포와 별도의 작업으로 실행했다. DB 변경·주문 재처리가 필요한 다음 배포에서도 대상·검증·실행 결과를 별도로 기록한다.
- 관련 저장소 구현: [Dockerfile](production-reporting.Dockerfile), [시작 검증](../launch-bundle.mjs), [준비 상태 인증](../../apps/api/src/auth/internal-probe.guard.ts).

이 기록은 다음 배포에서 재사용할 SHA가 아니다. 다음 세션은 새 변경을 커밋하고 그 SHA로 3~5단계를 수행한다.

## 다른 세션에 전달할 요청 예시

최신 운영 배포(2026-10-29)는 메타 광고 규칙 수정·비활성화 기능의 `41729e397a0a224f419c0219a86302d51c050986` (`codex/sidebar-scroll`)이다. 배포 ID `8b6f5c38-96ca-46e5-8649-8b2a2f027b44`, 준비 상태 및 케겔 10월 28일 광고비 반영 확인. 다음 배포는 이 변경을 보존한 소스를 사용한다. 상세는 [규칙 관리 문서](../../docs/meta-ad-rule-editing.md)를 확인한다.

### 이후 사이드바 배포 기록 (2026-10-28)

- 운영 소스는 `codex/sidebar-scroll` 브랜치의 `672f69501f1c11b4ad4b07d4ea5d5f02904e6822`로 고정됐다. 위 `codex/google-daily-d1-d7` 명령 예시는 이전 배포 당시 값이므로, 다음 배포에서는 실제 소스 브랜치와 배포할 커밋을 먼저 조회한다.
- 성공 배포 ID: `f0aaa666-4fc6-4b1e-84e6-63afd403283b`. 준비 상태 `ready`와 동일한 `releaseId`를 확인했다.
- 이전 운영 커밋 `1802414ef28fd6016530df2246dc3e211fc5d615`에 사이드바 CSS 변경 한 파일만 추가해 배포했다. 로컬 개발 브랜치의 별도 통합 성과측정 변경은 이 운영 배포에 포함하지 않았다.
- 웹 타입 검사·빌드 통과. 운영 화면에서 메뉴 스크롤 602px 이동 중 본문 스크롤 0px 유지, 쿠팡/관리 메뉴 노출, 마우스가 메뉴 밖이면 스크롤바 투명 처리까지 확인했다.

> `deploy/cloud/RAILWAY_DEPLOYMENT.md`를 읽고 이번 변경을 검증한 뒤, 문서의 운영 서비스에 배포까지 진행해줘. 기존 미커밋 변경은 섞지 말고, 현재 도구 권한과 대상·고정 커밋 상태를 먼저 확인해줘. `RELEASE_GIT_SHA`를 맞추고 검증한 새 커밋으로 배포한 뒤, 성공 배포 ID·운영 준비 상태·실제 화면 결과를 보고해줘. 권한 검토가 거절하면 우회하지 말고 거절한 동작과 이유를 알려줘.


## 2026-10-30 제품 통합 성과 UI 운영 배포

- 운영 서비스·환경은 위 `grand-fascination` / `staging`과 동일하다.
- 기존 운영 커밋 `e94ce28ef03c8dc3bbb687dde5c6d43787490505`를 기준으로 UI/API 변경 13개 파일만 별도 작업트리에 반영했다. 기존 Google 공유 판매 설정 변경은 보존했다.
- 배포 브랜치: `codex/product-performance-ui-release`.
- 최종 운영 고정 커밋 및 `RELEASE_GIT_SHA`: `4c2214c2f8d718f16ae3bb28d0066b240f87d597`.
- 성공 배포 ID: `daa68eb2-07b5-436e-b541-6c98a333ba75`. 준비 상태 `ready`와 동일 releaseId 확인.
- 변경: 광고비 변경 전후 일평균, 판매처별 매출·추정 순이익의 정수 %/원 증감, 기준 100 추이, 시차, CSV. 진단은 접어서 표시한다.
- 검증: 독립 작업트리의 API·웹 빌드 및 타입 검사, 제품 성과 웹 테스트 49개, API 계산 테스트 31개, 배포 범위 테스트 10개 통과. 실데이터 매체/지표 전환, 14일·3일 시차, 확보 일수와 CSV 확인.
- 누락된 원가·수집 입력과 Meta/Google의 판매처 광고비 배분 근거가 없는 순이익은 미확정으로 표시한다. DB 마이그레이션·재집계·배분 규칙 변경은 실행하지 않았다.
- 실데이터 확인 중 긴 입력 상태 문구의 가로 넘침을 발견해 최종 커밋에서 줄바꿈과 공통 CSS의 최소 860px 제한을 이 비교표에서 해제했다.


### 같은 날 후속 수정: 일부 원천 누락 시 확인된 금액 유지

- 운영 고정 커밋과 RELEASE_GIT_SHA는 `68efe3e63852698aba891b41e3314bd0d9ec733d`로 갱신됐다. 성공 배포 `fd9d4bae-f5a4-4120-b3f1-47c0f211bc93`, 준비 상태 ready와 releaseId 일치 확인.
- 이전 UI는 complete 값만 읽어, 과거 CSV 금액이 있어도 API 계정의 동일 날짜가 없으면 확인된 금액까지 숨겼다. Cafe24의 별도 광고비 귀속 차단도 기존 자사몰 정책보다 과도했다.
- 기존 strict complete 필드는 보존하고, display/partial 원천 메타데이터를 추가했다. Cafe24 매출과 Meta·Google 광고비는 기존 자사몰 정책으로 계산한다. Google이 없는 날에도 나머지 확인된 금액은 유지한다. 알려지지 않은 부분을 0원으로 확정하지 않으며 확보일과 일부 미확인 원천을 표시한다.
- 읽기 전용 운영 대조: 10/07~10/20 Meta 광고비14일, Google1일. Cafe24·Naver·Coupang에는 확인된 매출·광고 전 이익 행이 이미 존재한다. 일부 원가/매핑/쿠폰 미확정 행과 전체 값 숨김을 구분해야 한다.
- API 계산34개, 서비스20개, 제품 성과 웹53개 테스트 및 API/웹 빌드·타입 검사 통과. DB 마이그레이션·원가 변경·재집계는 실행하지 않았다.

## 2026-11-02 제품 통합 성과 조회 성능 개선

- 현재 운영 cf8016a882011d141b4584a0f4be806a024e0c5e의 쿠팡 변경을 보존한 별도 작업트리에서 구현했다.
- 배포 브랜치 codex/performance-speedup, 고정 커밋/RELEASE_GIT_SHA df78cdd9f550bed4e046f408d9561d6706803195.
- 성공 배포 bc566475-7940-41b6-b15f-599bb7ef86ed; ready 및 releaseId 일치 확인.
- 초기 성과는 /dashboard 한 요청으로 동일 snapshot에서 합계와 전체 일별 자료를 생성한다. 사용하지 않는 100개 제품별 상세 계산과 초기 diagnostics 요청을 제거했다. selection-options는 금융 payload 없이 메타데이터만 조회하며 제품 전환 시 재사용한다. 상세 진단은 펼칠 때 조회하고 snapshot 불일치/실패를 따로 처리한다.
- 기간 내 동일 플랫폼 부분집계를 재사용하고 날짜별 자료를 한 번 인덱싱한다. DB run JSON은 사용 중인 네 필드로 제한한다. 재조회 중 기존 결과를 유지하며 취소 신호를 실제 fetch에 전달한다.
- 고정 실데이터 11,530행의 기존 합계 envelope와 30일 전체 bucket을 깊은 동등 비교해 정확히 일치했다. 같은 로컬 실행 환경의 초기 계산 합계 19,308ms → 667ms(약96.5% 감소). 이 수치는 네트워크/DB를 제외한 계산 측정이다.
- 운영 동일 조건: 2026-09-30~10-29, 비교 08-31~09-29, 전체 제품·5개 플랫폼. 배포 후 dashboard HTTP200 9,928ms 및10,108ms(평균10.02초), selection-options 1,993ms 및1,818ms. 기존10/30 정상응답35~40초 대비 약72~75% 감소. 11/02 배포직전 요청은32.2초 후HTTP500이었으므로 이를 정상속도 비교값으로 사용하지 않는다.
- API81개, 웹57개, 배포guard10개 테스트 및 양쪽 production build 통과. 별도 검토 전용 에이전트도 승인. 기존 운영 쿠팡 허용범위를 반영하지 못하던 guard 테스트fixture만 동기화했으며 guard허용범위 자체는 변경하지 않았다.
- DB 마이그레이션·재집계·원가/배분 기준 변경 없음. 남은 응답시간에는 DB조회·전송이 포함되며 로컬CPU 개선율을 화면 개선율로 오인하지 않는다.

### 2026-11-02 Google 비교 기간 안내 수정

- 운영 커밋/RELEASE_GIT_SHA 609113c80ff2311a064860c71686d407288724b3, 배포 fb613686-d294-4be9-a1a0-e4ce51a2c18b SUCCESS 및 ready/releaseId 일치.
- 원인: 조회기간 중앙인10/14를 기본 기준일로 사용했지만 Google 숫자자료는10/20~23,25~29에만 존재했다.10/24와이전기간은NOT_COLLECTED/zeroConfirmed=false이므로0원으로확정할수없다.
- 매체 선택 시 한쪽 자료가 없고 날짜가 수동 지정되지 않았으면 조회범위 내 전후 달력창과 확보일을 기준으로 날짜를 추천·적용한다. 금액 크기나 증감 방향으로 추천하지 않는다. 직접 입력한 날짜는 유지하고 명시적 추천 적용 버튼을 제공한다. 실제 예산 변경일 감지가 아님을 화면에 표시한다.
- 자료 없음, 확인된0원, 음수 기준을 구분하여 카드·상세·CSV에 표시한다. 계산식과 누락일 처리 유지. 추가API요청없음.
- 고정 실데이터72개 날짜/매체/시차/창 조합의 기존 계산결과deepEqual. 웹63tests 및productionbuild통과, 검토전용agent 독립35tests통과.
- 실제운영 Google선택 시10/23로자동조정됨을확인. 전10/16~22 중3일 평균250459.362633원, 후10/23~29 중6일 평균273020.7369708333원, +9%(정수반올림),+22561원/일. 모든카드와판매처결과/그래프공통기준일적용.
- 브라우저 도구의 date fill은 DOM입력값만변경하고React변경이벤트를발생시키지않는현상이있어, 수동날짜보존은모델테스트와독립코드검토로검증했다. 운영자동선택경로는직접검증했다.

### 2026-11-02 데일리 통합 성과 및 A4 보고서

- 기존 광고비 변화 분석을 보존하고 제품 통합 성과에 `데일리 보고` 탭을 추가했다. `?view=daily`와 `dailyDate`로 날짜를 복원한다. 최신 발행일 또는 수동 선택일 D와 정확한 D−1의 매출·추정 순이익·광고비 및 판매처/매체별 원화·정수 증감률을 표시한다.
- 선택 플랫폼·계정의 최신 발행일을 사용하고 미래 발행일은 제외한다. 선택일 자료가 없을 때 과거 관측일로 바꾸거나 0원으로 채우지 않는다. 알려진 부분 금액, 확인된 0원, 전일 누락, 0/음수 비교 기준, 잠정·추정 표시를 유지한다.
- 데일리 조회는 D−1~D 두 날짜만 요청하며 비교 범위도 D−1로 겹쳐 불필요한 추가 날짜 조회를 피했다. 데일리 탭에서는 기존 장기간 분석과 진단 요청을 실행하지 않는다. API 합계를 그대로 사용하여 판매처와 매체의 비용을 중복 합산하지 않는다.
- 구현 커밋 2ea7c3c, 실화면 인쇄 CSS 보완 ffa9a82feea28e24c4b5cc6b845f5581ab3fbf30. 최종 운영 배포 4711f9e4-ab86-477a-b0b9-db7f11b09343 SUCCESS; 정확한 readiness/releaseId 일치. main 개발 작업트리에 22adc97/93dd044로 반영했다.
- 제품 성과 테스트79개 및 웹38페이지 production build 통과. 구현2명과 검토전용1명으로 병렬 작업했다. 별도 검토자는 계산·쿼리·인쇄 기준과 테스트를 독립 확인했다.
- 고정 실데이터의 모든 합계/판매처/매체 값을 원본 API와 대조했다. 실제 운영 최신 발행일은10/29. 전일10/28 대비 매출27,460,190원(-12%,-3,775,350원), 추정 순이익1,117,239원(-71%,-2,684,580원), 광고비11,778,054원(+10%,+1,023,579원) 표시 확인. 세 합계는 확인된 부분 금액 기준이다.
- 실제 운영 날짜 버튼으로10/30 및11/01을 선택했을 때 자료 없음/전일 금액을 정확히 표시하고 최신 발행일로 복귀함을 확인했다. 신규 탭은 아직 통합 발행되지 않은 원천 날짜를 생성하지 않는다.
- 첫 운영 시각 검증에서 전역 table min-width860px/nowrap/sticky 상속으로 넘침을 발견하여 scoped reset과 행 간격을 보완했다. 최종 실화면 report clientWidth=scrollWidth=792px, 두 표701px, 본문 높이951.625px로 넘침 없음. 동일 실자료 인쇄 스타일 렌더703px폭에서 높이952.953px로 A4본문273mm(1031.81px) 안에 수용됨.
- 실제 운영 인쇄 버튼→네이티브 인쇄 미리보기에서 `1페이지로 이루어진 PDF 문서`, `용지1장`, `용지크기 A4`, `시트당페이지수1`, `여백기본`, `배율기본값`을 확인했다. 제목/날짜/세 KPI/판매처3행/매체4행/집계기준 모두 잘림 없이 표시. 실제 종이 인쇄는 실행하지 않았다.
- 증거: C:/Users/seong/.codex/visualizations/2026/10/30/product-performance-production/daily-report-live.jpg 및 daily-a4-print-preview.png. DB·원가·배분 산식·수집/재집계 설정 변경 없음.
