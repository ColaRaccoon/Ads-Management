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

`resource-probe.mjs` is a local-only harness and is not copied into the runtime
image. Mount it and a scratch fixture volume into fresh `--memory=1g`
containers to measure `text-max`, `xlsx-max`, `bundle-max`, and `report-max`.
Each JSON result records process RSS/heap/external peaks, cgroup
`memory.current`/`memory.peak`/`memory.events`, and `/tmp` peak bytes. Treat an
OOM-killed container as failure. The harness itself returns non-zero and emits
`FAIL` unless the cgroup limit is exactly 1GiB, `oom`/`oom_kill` deltas are zero,
and peak cgroup memory stays at or below 700MiB for baseline or 850MiB for a
workload. Never infer an application-target PASS from this parser/report
resource harness.

The scripts under `fixtures/` are also local-only. Mount them over the two
runtime entry files to rehearse the production launcher, single public Web
port, Web-to-loopback health path, and SIGTERM shutdown without connecting to
Supabase. This proves container wiring only; it is not application readiness,
storage, Auth, DB, or staging evidence.

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
