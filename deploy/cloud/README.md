# Single-container cloud bundle

This is the production target introduced on 2026-09-01: one continuously
running 1GB Node container using the existing Supabase Pro Auth, PostgreSQL and
private Storage services. The Next.js standalone server is the only public
listener (`0.0.0.0:$PORT`). NestJS always listens on `127.0.0.1:4200`, and Next
routes same-origin `/backend-api/*` requests over that loopback boundary.

`deploy/local/**`, `deploy/windows/**`, `deploy/edge.Dockerfile`, and
`deploy/compose.staging.yaml` are historical records. The final Docker stage
does not copy or execute any of them.

## Runtime boundary

- `NODE_ENV=production`, `APP_ENV=production`, and
  `DEPLOYMENT_MODE=cloud_container` are mandatory.
- Auth and Storage must be explicitly set to `supabase`. Local username Auth,
  local durable directories, `CONFIG_PATH`, the LAN Edge and Windows host
  controls are rejected by cloud startup validation.
- The database target is bound to the same 20-character Supabase project ref
  used by Auth/Storage. Direct connections use `db.<project-ref>.supabase.co`
  and the exact runtime role. Session pooler connections use port 5432 and a
  URL username of `<runtime-role>.<project-ref>`. The container uses
  `sslmode=verify-full` with system trust; private CA paths are rejected.
  `SUPABASE_DATABASE_NAME` and `SUPABASE_DATABASE_SCHEMA` must also exactly
  match the URL target.
- `AUTH_INVITE_REDIRECT_ORIGIN` is mandatory, must be an exact member of
  `APP_ALLOWED_ORIGINS`, and is the sole `/invite/accept` redirect origin.
  The approved Supabase email template must be verified to deliver the
  application contract's `#token_hash=...` fragment before staging PASS.
- `API_INTERNAL_PORT` is fixed at `4200`; changing it requires a rebuilt Web
  artifact and is deliberately rejected by the launcher.
- `RELEASE_GIT_SHA` is required both as an image build argument and a runtime
  variable. It must be the full 40-character SHA-1 or 64-character SHA-256
  source revision and match the image-baked `IMAGE_RELEASE_GIT_SHA`.
- The default old-space limits are 512MB for API and 192MB for Web. The launcher
  rejects a combined value over 704MB so native allocations, buffers and the
  runtime itself retain headroom inside 1GB. `NODE_OPTIONS` may not override an
  old-space limit.
- If either child exits unexpectedly, the launcher terminates the sibling and
  returns failure. SIGINT/SIGTERM are forwarded to both children; after 10
  seconds the launcher sends SIGKILL and its own exit is bounded at 12 seconds.

## Local 1GB rehearsal

Copy `.env.example` to the ignored `.env.local`, inject the approved local test
values without printing them, then bind the image to the exact commit:

```powershell
$env:RELEASE_GIT_SHA = git rev-parse HEAD
$env:NODE_IMAGE = 'node:22.18.0-bookworm-slim@sha256:<APPROVED_INDEX_OR_PLATFORM_DIGEST>'
docker compose -f deploy/cloud/compose.local.yaml config
docker compose -f deploy/cloud/compose.local.yaml build
docker compose -f deploy/cloud/compose.local.yaml up --wait
```

Resolve and approve the base digest read-only before the build, and record the
target platform plus resulting image digest/SBOM. A tag-only or unresolved base
is rejected by the Docker build and is not a releasable production artifact.

The compose file publishes only `127.0.0.1:3200 -> 8000`; it does not publish
port 4200. It also uses a read-only root filesystem, a 192MB `/tmp` tmpfs,
non-root image user, no Linux capabilities, no privilege escalation, a 256 PID
limit, no swap beyond the 1GB memory limit, and an init process. The healthcheck
uses `GET /backend-api/health/live`, proving both the public Web listener and the
loopback rewrite without requiring the secret readiness token.

Useful read-only checks after startup:

```powershell
Invoke-WebRequest http://127.0.0.1:3200/backend-api/health/live
docker compose -f deploy/cloud/compose.local.yaml ps
docker compose -f deploy/cloud/compose.local.yaml exec app node -e "fetch('http://127.0.0.1:4200/api/health/live').then(r=>console.log(r.status))"
docker compose -f deploy/cloud/compose.local.yaml exec app node -e "fetch('http://127.0.0.1:4200/api/health/ready',{headers:{'x-internal-probe':process.env.INTERNAL_PROBE_TOKEN}}).then(async r=>{if(!r.ok)process.exit(1);const b=await r.json();if(b.releaseId!==process.env.RELEASE_GIT_SHA||!b.runtimeConfigFingerprint)process.exit(1);console.log('ready',b.releaseId)})"
```

The readiness command consumes the token only inside the container and prints
no secret. Staging or production must not be promoted from a live-only result;
the approved target needs a 200 ready response with the expected release and
runtime fingerprint.

The local-only resource probe, synthetic fixtures, and automated test sources were removed on 2026-10-08 at the user's request. Earlier harness results remain historical evidence; the removed tools are unavailable in this checkout. The application launcher and runtime readiness checks remain available.

The launcher passes only a non-secret allowlist to the Web child instead of
inheriting API credentials. Both children still run as the same non-root UID in
one container as required by this deployment shape. A Web-process compromise
may therefore have sibling-process visibility through the shared process
namespace on some hosts; environment allowlisting is defense in depth, not a
strong process-isolation boundary. Reassess separate containers if that threat
must be eliminated.

Stop with `docker compose -f deploy/cloud/compose.local.yaml down`. Do not use
this local rehearsal to modify the operating Supabase project. Staging and
production deployment, registry publication, migrations, bucket policy changes,
DNS and traffic switching remain separate approval gates. Until those gates
have run against the approved target, `operationalReady=false`.

## CSV upload and authentication connection contention

Meta CSV imports and authentication share one Prisma pool. A long upload
transaction can occupy the only connection when `PRISMA_CONNECTION_LIMIT=1`.
The cloud example uses `3`; keep `HEAVY_OPERATION_CONCURRENCY=1`.
If `DATABASE_URL` explicitly contains `connection_limit`, it must match
`PRISMA_CONNECTION_LIMIT`. Changing a source default or this example does not
change an explicitly configured deployment. Additional connections do not reserve one
for authentication, so validate mixed traffic and database/pooler capacity before
applying the candidate. Increasing request timeouts is not the remedy.

The opt-in test
`apps/api/src/uploads/upload-auth-contention.postgres.integration.spec.ts`
compares pools of one and two with the same synthetic 500-row CSV, three imports
per pool, and simultaneous login, refresh and lightweight database reads after
the first real row write. It uses the actual parser, import services, Prisma,
PostgreSQL transactions and AuthService. External identity/JWT verification and
object storage calls are test doubles; exchange rates are preloaded fixtures.
It also checks imported counts and aggregates, SKIP behavior, rollback after a
mid-write failure, incorrect passwords and inactive accounts.

Set `UPLOAD_AUTH_TEST_CONNECTION_LIMIT=3` to validate three connections alone.
Only `1`, `2`, or `3` is accepted; omitting the variable retains the original
one-versus-two comparison. The example below selects three without rerunning
the other schemas.

Run from the repository root against a **new disposable local PostgreSQL**
database named `meta_ads_contention`, using role `contention_test`. Never use a
forwarded production connection. Selected schemas must be fresh; the test
refuses existing users/upload batches and does not clear database contents.
Replace the password and port below with the disposable instance values. No
production environment or `.env` file is needed.

```powershell
$previousDatabaseUrl = $env:DATABASE_URL
try {
  $env:UPLOAD_AUTH_TEST_DATABASE_URL = 'postgresql://contention_test:<LOCAL_TEST_PASSWORD>@127.0.0.1:55419/meta_ads_contention'
  $env:CONFIRM_DISPOSABLE_UPLOAD_AUTH_DB = 'meta_ads_contention'
  $env:RUN_UPLOAD_AUTH_CONTENTION = '1'
  $env:UPLOAD_AUTH_TEST_CONNECTION_LIMIT = '3'
  foreach ($poolSize in 3) {
    $env:DATABASE_URL = "$($env:UPLOAD_AUTH_TEST_DATABASE_URL)?schema=test_upload_auth_$poolSize"
    node node_modules/prisma/build/index.js db push --schema apps/api/prisma/schema.prisma --skip-generate
    if ($LASTEXITCODE -ne 0) { throw 'Disposable schema preparation failed' }
  }
  npm.cmd --workspace @meta-ads-performance/api run test -- src/uploads/upload-auth-contention.postgres.integration.spec.ts
  if ($LASTEXITCODE -ne 0) { throw 'Upload/auth contention verification failed' }
} finally {
  $env:DATABASE_URL = $previousDatabaseUrl
  Remove-Item Env:UPLOAD_AUTH_TEST_DATABASE_URL, Env:CONFIRM_DISPOSABLE_UPLOAD_AUTH_DB, Env:RUN_UPLOAD_AUTH_CONTENTION, Env:UPLOAD_AUTH_TEST_CONNECTION_LIMIT -ErrorAction SilentlyContinue
}
```

JSON output includes per-request success/error codes and elapsed time, import
and parsing time, process CPU, sampled RSS and event-loop delay. Request latency
includes all service work (including failure auditing); it is not a direct
measurement of pool wait or SQL transaction duration. The default comparison
runs both pools sequentially, so RSS includes retained heap/JIT state and cannot
isolate the memory cost of an extra connection. This is a service/DB contention
test, not HTTP/browser, real-provider latency, maximum-file, or 1GB deployment
acceptance. Preserve the output before disposing of the test instance.

## Serverless idle behavior

Railway Serverless must be enabled and applied by deploying a new container.
Confirm actual `SLEEPING` through the control API, then measure the first document
request and protected readiness after waking. Do not poll application URLs during
idle observation. Public bots and maintenance checks can wake the service.

Authenticated web tabs pause recurring checks after five minutes without shared
user activity. Returning business requests await authorization revalidation;
ongoing uploads remain mounted and are not replayed. The separate two-hour idle
logout and per-request server permission checks remain enforced. Report recovery
runs at startup and retries unresolved work; a clean service does not scan every
minute. The production image disables Next.js telemetry.

`PRISMA_IDLE_DISCONNECT_MS=60000` opts into releasing the entire idle Prisma pool
once no query or transaction has been active for one minute. Unset/`0` disables
it. Model/raw operations and the full transaction callback or batch hold leases;
new work waits for a disconnect already in progress before reconnecting. This
never shuts down the server or disconnects after every request. Preserve
`PRISMA_CONNECTION_LIMIT=3` and `HEAVY_OPERATION_CONCURRENCY=1`.

Prisma 6.12's `max_idle_connection_lifetime` is checked on checkout and did not
close sockets proactively in an isolated PostgreSQL test. The production
Supabase session pooler also did not apply the attempted startup
`idle_session_timeout` option. Neither URL option was applied to production.
Do not substitute server-enforced idle termination without verifying first-query
reconnection, active queries and transaction gaps against the actual endpoint.

Storage renewal remains on Supabase. Its read-only readiness check tolerates a
bounded cold start and accepts an already-applied sleeping deployment, while
credential errors and application readiness failures stay terminal. See
[`storage-renewal`](../../scripts/cloud/storage-renewal/README.md).

Disable Serverless and redeploy to restore always-on operation. Set the idle
pool option to `0` and redeploy only if rolling back pool cleanup too; preserve
current credentials and the three-connection setting. No database restoration
or migration is part of this rollback. Initial document 502s cannot be fixed by
browser API retry code because the application has not loaded yet.

References: [Railway Serverless](https://docs.railway.com/deployments/serverless),
[Prisma 6 connections](https://www.prisma.io/docs/orm/v6/prisma-client/setup-and-configuration/databases-connections/connection-management).
