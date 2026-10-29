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
