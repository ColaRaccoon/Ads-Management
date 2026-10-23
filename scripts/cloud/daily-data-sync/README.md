# 08 isolated daily/weekly scheduler

> **Current: phase08 DONE (isolated verification), final actual state2026-10-16 13:51:06 KST.** Normal3ccd/source0f790 is SLEEPING/backend0/lease0/current-runCP0, STOPfalse/149active/paused0, originalcall0f11 and Edgev7 with nine secret digests preserved. Actual Meta7/7/5,061 rows and Cafe379 checkpoint recovery passed strict lineage/purchase/video/metadata proofs. Same collection25e also naturally slept. Final22-deployment/Edge/PG known57 log scan passed. Read the latest records08 completion section; all historical mutation markers are consumed. Operating resources, previous05–07 and local changes are preserved. Stage09 remains unstarted.

> **Historical 2026-10-15 17:16 KST user-requested safe stop:** Read the final 17:16 handoff in `docs/daily-data-automation/records/08_결과.md` first. The isolated scheduler is globally stopped, leases are inactive, deployment751/source436 is SLEEPING, and v17 build217 was cancelled/REMOVED; its source variable was restored to436 without deploying. Normal02 definitions/call/Edge restoration is incomplete; no isolated overnight collection will run. Preserve the failed/queued units and expired-by-tomorrow checkpoint. The local v17 candidate and some forward helpers target42 and today's fixed deadlines; do not replay consumed markers, resume expired occurrences, or run mutation examples below without a fresh scope review. Production is unchanged.

This directory is a new scheduler. It never uses the production Storage function,
secret, jobs or pg_net queue. `control.mjs` rejects every DB target except the
isolated Supabase `ehnfrrmbkvlsbpvqcvkr`, database `postgres`, privileged role
`postgres`, session port 5432 and verified TLS. The install also refuses a DB
containing the production `storage_renewal_ops` schema. No production installation
or deployment is authorized in phase 08.

## Historical interface and preparation (October14–15)

The former candidate `grand-fascination-staging.up.railway.app` was verified on
2026-10-13 as the **same operating service** as `patimagroup-work.com`. Both
origins are denied. A distinct full Next/Nest service was provisioned and v5
deployed on 2026-10-14: `phase08-daily-data-sync-production.up.railway.app`,
service `4b30daa8-9333-46b7-ad89-cfd64ff5266c`, project
`d72f4256-8632-437a-9dae-9b5d96736fc7`, environment
`d261a432-a6a4-4031-b8ea-c619ac263cc3`, isolated DB schema `phase08_meta_ads`.
The reviewed v7 source is `b361da10cf16c0955ca0dc8c51bff195f289d6e8c7aae934f81f030b42a68e81`;
its historical deployment was `b41e222d-8a18-47c9-81cc-e26132796cf8`.
On 2026-10-14 the root operator completed normal Cafe OAuth/bootstrap, installed
the isolated scheduler, bound its new machine Vault credential, and enabled
three definitions/149 finite jobs. App scheduling is ON and globalStopped is false.
That setup-only evidence did not establish on-time collection. The final closure above and below supersedes its historical incomplete status.
The first real anchors were 2026-10-15 02:00/02:01/02:02 KST (Cafe/Google/Meta),
with 110/90/90-minute windows, selecting Cafe October14 and ads October8–14.
They failed before app/provider execution: 149 FAILED/TRANSPORT_FAILED and three
INCOMPLETE_SCHEDULE markers, with no run/unit/coverage. Keep that failed evidence.
At that historical checkpoint, with the original cadence preserved, the next Cafe occurrence was October16
02:00 KST (October15 only), and the next ads occurrences are October22
02:01/02:02 KST (October15–21, seven dated units each). Do not advance the clock,
re-anchor the definitions, or add the missed dates to these next ranges.
Fresh signed target evidence is required for every mutable activation action.
Status/kill/pause remain available for inspection and stopping.
The new service's Next `/backend-api/internal/daily-sync`
must forward to loopback Nest `/api/internal/daily-sync` on port4200. Do not call
that loopback listener externally.
POST body is `{scheduleKey,scheduledFor}`. `scheduledFor` is an immutable UTC
occurrence timestamp with milliseconds. The application derives connection,
account-local completed dates and a deterministic request key from its protected
`DAILY_SYNC_SCHEDULES` configuration. Caller dates/accounts/URLs are unsupported.
`/internal/daily-sync/status` returns DB state without executing a provider unit.

Before activation, prove the isolated app/DB/runtime fingerprint, deploy the
reviewed phase-08 source only to the isolated full Next/Nest target, provision
portable provider credentials there and verify each connection independently.
The Cafe24-only phase-06 callback image and phase-07 cleared temporary AES files
are insufficient. Preserve the 22-table Cafe24 DB and existing completed evidence;
do not run initial setup or all migrations against that DB.

Provide a new random machine credential to staging Nest `DAILY_SYNC_MACHINE_TOKEN`
and isolated Vault under `daily_data_sync_08_machine`; it must differ from probe,
Auth, Storage and provider credentials. Keep the secret out of command lines,
source, logs and this document. Store `RUNTIME_API_TARGET_ID` in management settings
as `targetId`. Enable `DAILY_SYNC_FEATURE_ENABLED` and `DAILY_SYNC_SCHEDULE_ENABLED` only in
the isolated app after checking identity. Configuration uses
`[{key,connectionId,anchorAt,windowMinutes}]`; the corresponding CLI configuration
also includes `provider`, `timeZone:"Asia/Seoul"` and `targetId`. All three current
verified accounts are in Seoul time. Other zones need independently reviewed
external scheduler windows; never substitute Seoul dates for them.

## Install, configure, pause, resume, kill and inspect

The install/configure description below records the initial setup. **Do not
rerun `install.sql` or the initial installer on this already installed target.**
The original file is retained as a legacy reference and contains the unsupported
curl option. Reinstalling would overwrite the reviewed transport recovery.
Use the independently reviewed, guarded function-only relay patch for this
existing ON/149-job/152-record baseline; it preserves schedules and attempts.

The normal root path uses the protected parent and fixed Supabase management
endpoint, without an administrator database URL. Live Railway config/deployment,
protected readiness, postgres/read-only runtime identity, 68 FORCE RLS tables,
UTC cron and three READY enabled connections/policies are checked before signing.
Public evidence lasts ten minutes; observations are within five minutes of signing.
Source/deployment and dedicated Ed25519 key pins cannot be supplied by callers.
Config files are secret-free arrays of exactly three definitions, containing
`key,connectionId,provider,timeZone,anchorAt,windowMinutes,targetId`. The reviewed
file is `C:/Users/seong/AppData/Local/MetaAdsPhase08Evaluation/schedules-20261015-v7.json`.

```powershell
pwsh -File scripts/cloud/daily-data-sync/prepare-scheduler-evidence.ps1 -ConfigurationPath <public-config.json> -OutputPath <new-public-evidence.json>
pwsh -File scripts/cloud/daily-data-sync/apply-scheduler-batch.ps1 -Mode <install|configure|resume|enable> -EvidencePath <fresh-public-evidence.json> -ConfigurationPath <public-config.json>
```

Install requires app schedule OFF/empty definitions and creates a stopped singleton.
Configure requires schedule OFF/three loaded definitions and creates 149 inactive
jobs/three paused schedules in one transaction. Resume requires schedule ON and
enables the exact three job sets while globally stopped; enable releases the switch.
An initial configure response was uncertain because automatic JSON timestamp
conversion removed milliseconds. Root inspected the committed inactive baseline
and verified readback after fixing the decoder; configuration was not resubmitted.
Inspect uncertain outcomes before retrying. The root-only `stop-scheduler.ps1`
supports `kill`, `pause`, and read-only `status` without signing keys, healthy
application, or an administrator DB URL. Kill first checks only the fixed
management endpoint's postgres identity, changes the global stop switch in one
batch, and verifies its boolean readback even when other metadata is broken.
Pause operates on the three fixed keys and checks pre/post preservation and
inactive jobs. Use this concrete stopping order:

```powershell
pwsh -File scripts/cloud/daily-data-sync/stop-scheduler.ps1 -Mode kill
pwsh -File scripts/cloud/daily-data-sync/stop-scheduler.ps1 -Mode pause
pwsh -File scripts/cloud/daily-data-sync/stop-scheduler.ps1 -Mode status
```

Then the root operator independently fences the new app: read and verify the
fixed project/environment/service, current v7 source, standard launcher and
latest deployment; upsert **only** `DAILY_SYNC_SCHEDULE_ENABLED='false'` with
`skipDeploys=true`, keeping the three definitions and all credentials unchanged.
Read back this one variable before proceeding. Submit `railway up` from the
already reviewed immutable v7 snapshot to the same new service, then inspect the
new deployment's successful status, unchanged source hash and loaded flag OFF.
Configuration preparation alone does not fence a running deployment. Do not
use generic redeploy, which can reuse the prior deployment's old configuration;
do not run the initial bindings helper, whose empty/PENDING baseline no longer
applies. Record the successor ID and review pins separately before any future
resume. A stopped global switch stays useful if Railway is down.

`kill` stops future invocations; it does not cancel
an already executing PostgreSQL HTTP request. Also disable the app schedule feature
to fence new application invocations when stopping collection. In-flight publish
is governed by the account lease/generation/deadline, never force-written.

`probe-scheduled-http.ps1 -ConfigurationPath <public-config.json>` is future-only:
it refuses operation within 30 minutes of any first anchor and rechecks before
each POST. Missing/bad/probe token and wrong target expect403, unknown key409,
caller fields400, and each configured future status400 RUN_LIMIT_EXCEEDED.
Pre/post run/unit/coverage/lease/checkpoint/attempt counts must remain zero.
It wakes the app and records HTTP elapsed time, not regular cron/provider success.

`observe-scheduler.ps1 -Samples 1` reads bounded scheduler/DB/Graph metadata without
application health pings. At most five samples and 1–30-second intervals are allowed.
It returns safe enums/dates/counts, provider units/coverage, Cafe day policy flags,
leases/checkpoint expiry and own runtime sessions. These are Supavisor backend
sessions; frontend pool disconnect cannot be inferred from their idle state.
Graph SLEEPING is recorded only when observed. RSS/cost require separate evidence:
the 1-GiB limit is not measured RSS, and sleeping does not establish zero cron cost.

## Execution and recovery

### 2026-10-15 first-run transport failure and local relay recovery artifact

The first real occurrence produced 149 transport failures and three incomplete
markers, with no application run/unit/coverage. Root's actual isolated read-only
diagnostic, with no HTTP/provider request, confirmed that this installed HTTP extension rejects
`CURLOPT_FOLLOWLOCATION` before making HTTP. Prior synthetic curl-option stubs
returned true for every option and did not establish real extension compatibility.
Preserve these 152 records and the original schedule anchors/ranges; do not replay
the closed slot as a new regular success or request a CSV.

The new local recovery source is `supabase/functions/phase08-scheduled-relay/`.
Deployment, secret provisioning and guarded SQL patching belong to the root
operator. As of this documentation update, the new independent relay Vault
secret was actually created once, with one SYSTEM audit; bound-parameter input,
self-revoked temporary access and exact-source-hash function removal all passed.
The fresh relay password was separately protected in a new CurrentUser DPAPI file.
The root operator deployed Edge version 1
(`42f4d9e1-eddb-4b00-b574-399a489f78b4`, source
`207bd3040b55e01d01531636b7cf42dd64bcef3326320853e750a664a83863b9`, bundle
`e4aa0eb68513b50380f45272796d1c15f9345e3591bb3bbc0f6849e837c262a6`)
with `verifyJWT=false` and the relay's independent Basic authentication. Two custom
secrets were added; seven platform defaults were preserved. The platform itself
added `SUPABASE_URL` during the temporary probe (six defaults became seven),
separately from those two custom secret writes.

The function-only patch actually passed at `2026-10-15T00:21:23Z`, yielding
the initial `call()` source MD5 `c08c905c50aaae6c7b70a286c704f0c6`.
The independently reviewed cancellation cleanup passed at `00:28:58Z`;
the current source MD5 is `0f11e36961a628ab665302b950d0b9aa`.
It clears native curl state on `query_canceled` before rethrowing.
Readback preserved
149 active jobs, three unpaused definitions, global stopped false, all 152 prior
records and their digest, 68 FORCE RLS tables, and zero runs/coverage.
Three direct Edge closed-slot status requests and three single-request native
DB → Edge → App status diagnostics returned HTTP 200 / `EXPIRED`, no-store,
and zero completed units. These are actual manual read-only transport diagnostics,
not provider collection or a successful regular occurrence. Twelve actual relay
negative cases passed. The final known-secret scan covered 57 candidates against
1114 retained Railway entries, with no matches. The separate recorded one-hour
Supabase window contained 57 Edge/gateway/function plus 127 Postgres entries,
also with no matches. Public Storage role
and subject configuration were initially false positives; exactly those two
metadata names are excluded while actual signed-token detection remains tested.
Future provider/renewal logs and actual regular collection are not covered.
The v7 app and original
`install.sql` are preserved. The relay accepts only the three original anchors and
their 1/7/7-day cadences. Normal bodies have two keys. Explicit
`{scheduleKey,scheduledFor,mode:"status"}` selects only the fixed read-only app
status path, accepts past aligned occurrences and rejects future timestamps.
Status diagnostics do not retry a provider or complete a missed slot.

DB → Edge uses libcurl's built-in Basic USERPWD with an independent Vault value
`daily_data_sync_08_relay_userpwd` (`phase08-scheduler:<fresh password>`), not the
machine credential. **This hop still automatically follows redirects:** root's
secret-free actual POST controls covered canonical and alternate direct paths,
a same-origin307 and a cross-origin307. Basic was present/matched on the direct
and same-origin paths and absent only on the cross-origin307 destination. The
temporary secret-free probe function was deleted and its absence checked.
This is credential-scoping evidence,
not a native no-redirect capability. The fixed relay function returns no redirects.
Edge → fixed Railway uses `fetch(..., {redirect:"manual"})`, rejects upstream3xx
as a fixed502 without Location, and attaches the machine token only on this hop.
The relay handler has a75second execution budget starting after authentication,
including the app's55second unit. The complete native DB request is bounded by
85seconds; Edge platform cold start and gateway waiting occur outside the handler
timer, so the remaining startup/network budget requires actual measurement.
Bodies/responses are bounded and projected to
safe date/count/status fields; raw errors, provider data and tokens are omitted.

Only `PHASE08_RELAY_BASIC_PASSWORD` and `PHASE08_RELAY_MACHINE_TOKEN` are read by
the relay entrypoint. Supabase Edge secrets are **project-wide**, so distinct names
do not isolate them from another function in the same project or its privileged
administrators. Preserve this limitation and the existing service_role Vault
administrator exception; do not claim per-function secret isolation.

`relay-vault-bootstrap.mjs` and its protected stdin bridge implement a separate
five-minute, hash-bound temporary bootstrap for this ON/149active/152-record
baseline. Do not rerun the original OFF/zero-record machine bootstrap. The new
function binds one parameter, checks logging, creates only the new relay secret
and SYSTEM audit, revokes its temporary runtime access, and is then removed by
root with an exact function-source hash guard. `relay-transport-patch.mjs` changes
only `call()` after checking its previous MD5, the reviewed relay source hash,
68 FORCE RLS tables, exact definitions/jobs and frozen pre/post metadata. It resets
native curl state at start/success/error and refuses debug logging before USERPWD.
The closed-status diagnostic uses HTTP45/SQL50/Management60-second limits and
explicit cancellation cleanup; its fixed first-slot/zero-run baseline is a
one-time diagnostic, not the next morning's observer. Use
`observe-scheduler.ps1 -Samples 1` to inspect later regular runs. The separate
`scan-relay-live-logs.ps1 -OutputName <new-safe-json-name> -Hours 1` scans bounded
read-only logs without writing raw messages or credentials.
These are recovery artifacts, not permission to change operating resources.
The operating Storage function, jobs and secrets are not reused. The 149 existing
jobs, three original anchors, selected dates and failed history remain intact.
Closed-slot status calls and other manual diagnostics are recorded separately
from actual regular cron collection. No new CSV is required. Meta PURCHASE_V1
purchase count/value remain mandatory; video requests remain excluded.

### Relay cost and quota boundary

Root's actual organization metadata reported the Free plan, a maximum of100
functions and a20-MiB bundle limit. The published Free allowance is500,000 Edge
invocations/month ([pricing](https://supabase.com/pricing)). A conservative count
for the defined schedule is `149 × 31 = 4,619` job opportunities/month; successful
slots skip subsequent HTTP and weekly slots do not collect on intervening days.
This arithmetic excludes public unauthenticated requests, manual diagnostics and
other organization functions. The remaining-organization-quota request returned
401, so remaining quota was not verified. Included allowances and configured
limits do not guarantee zero charges or establish actual usage/cost. Preserve
this uncertainty rather than treating the schedule count as an organization cap.

Cafe24 anchor is 02:00 KST and the selected range is exactly the completed prior
day. Google/Meta anchors are each separated by 7 days; each slot selects exactly
the preceding completed 7 dates. Each application request advances a bounded unit
and persists checkpoint/state before returning. An HTTP 200/202 is never enough:
only `SUCCEEDED` with all dated units completed, matching key/occurrence/range is
recorded as success. An invalid response or machine authentication failure becomes
`ACTION_REQUIRED`. 429/network/5xx and partial results are eligible for later
bounded calls of the same slot. Successful slots cause later management calls to
skip HTTP; no persistent worker or health ping is added.

Candidate weekly calls use 5-minute slots within a configured 35–120-minute
window, ending by 03:55 KST to reserve reconciliation and HTTP timeout before 04:00 Storage maintenance. Cafe24 chunk continuation uses
one-minute work slots in a finite 60–120-minute window (current candidate 110 minutes), only while the
original occurrence is incomplete. This is collection continuation, with no
health ping. The original 02:00/02:10/02:20 and 02:30 SLA proposal cannot handle
the observed 422-order two-pass workload in three short requests. Its actual
completion limit requires staging measurement. Each account has separate jobs and
locks, so provider failure does not permanently block other accounts. App heavy
concurrency remains 1 and DB pool limit remains 3.

Apply only the new `20261012170000_scheduled_unit_checkpoints` migration to a
verified isolated full-app database. Provide an independent random AES-256 key
as `DAILY_SYNC_CHECKPOINT_KEY_B64`. Checkpoints bind connection/run/day and claim
generation, expire after two hours and have a 16 MiB payload limit. Expired rows
are cleaned in bounded batches on the next scheduled account wake; a permanently
stopped account needs explicit isolated maintenance. No provider secret is stored
in checkpoints. Do not replay all migrations into the phase-06 callback database.

HTTP timeout is 85 seconds (connect timeout 15 seconds); the application request
budget is smaller, with publish reserve. Per slot external calls are capped at
120 for Cafe24 chunks and 24 for Google/Meta;
per unit application retries are separately capped. Supabase records safe enums,
HTTP status, counts and elapsed time even when Railway is unavailable. It stores
no response payload or transport exception text. The audit creates a missing or
incomplete warning if the selected slot never succeeded; cron engine failures are
also observable in `cron.job_run_details`. A closed-slot audit can reconcile
already committed units through the application step, with no expired provider
fetch; it runs three minutes after the work deadline to outlast the two-minute
lease, has a separate three-inspection cap and must finish before 04:00 KST.
The application warnings API scans the latest 31 daily / 5 weekly slots and
exposes its tracking boundary and unscanned older history. A missed historical slot is never
added to the next range. Use the existing authenticated manual endpoint to name
one completed day explicitly and execute that provider, preserving source-policy
conflicts; do not submit a new multi-day scheduled or backfill request. New CSV
uploads are not a recovery prerequisite. Meta PURCHASE_V1 count/value validation
and video exclusion remain in the provider writer/runner.

## Evidence

Run `node --test scripts/cloud/daily-data-sync/core.test.mjs` for synthetic contract
checks. The phase-08 result record must distinguish virtual-clock tests, synthetic
provider/real-DB tests, local real-HTTP forwarding and actual remote scheduled
provider collection. Remote evidence must contain target fingerprint, selected
dates, real due/start/finish timestamps, row/unit counts, last-success/checkpoint,
restart/duplicate/upload-contention results and pool disconnect/sleep observation.
Never promote an accelerated trigger or historical phase05–07 run to regular
scheduled evidence. Final weekday/timeouts/capacity are measured candidates for
phase10; phases09 onward are outside this request.

References checked 2026-10-12: [Supabase HTTP](https://supabase.com/docs/guides/database/extensions/http),
[Supabase Cron](https://supabase.com/docs/guides/cron).

## October 15 test recovery

The October 15 10:00/10:01/10:02 KST trial is a real-clock accelerated test.
Its original collection deadlines have closed. Do not reinstall the scheduler,
repeat the one-shot reanchor/operator approval, or extend those deadlines.
Preserve the original failed Meta weekly run, all dated units and missing warnings.

`restore-normal-02-database.ps1` requires a fresh signed proof of the reviewed
pre-cutover deployment and a stopped, quiescent isolated scheduler. It restores
only the original three anchors, 149 job times and reviewed call function while
checking business/history/checkpoint preservation. It intentionally leaves the
global stop and provider pause in place. `prepare-normal-02-v11.ps1` changes only
the isolated source digest and application schedule definitions, with skipDeploys
and exact preservation of every other variable. Deploy the approved immutable
v11 snapshot separately, then verify the actual deployment and refresh literal
pins before producing a new signed proof.

`update-relay-restore02.ps1` prepares a separate immutable v3 bundle and updates
only the existing new08 Edge function under a stopped scheduler. It preserves all
nine secret digests and the database state. Historical 10:00 status routing does
not imply that a restored 02:00 application accepts the old occurrence.

`run-meta-manual-oct8.ps1` defaults to a local plan. Its execution path is a
single explicit MANUAL day, with one normal authenticated queue request and one
execute request. An uncertain response requires inspection; never blindly repeat
it. A successful manual day is not a successful seven-day scheduled occurrence.
The encrypted-capture writer probes always roll back and are diagnostic evidence
only. See the latest phase08 result record for actual outcomes and the final
global stop/pause state before resuming work.

The reviewed pre-afternoon deployment was v12/Singapore `5dac048f-5015-46fa-8ca4-5227352c834c`,
source `d1f04a19272fc58b0ebd344cbfdd4ce660cb8e553a519968f42e9d81da4eff21`.
Use the frozen `full-app-build-20261015-meta-v12` snapshot, not a fresh assembly of
this dirty checkout. `verify-meta-v12-sin-build.ps1` v2 includes a fresh read-only
quiescent-state check; its pre-resume conditions no longer hold after resume.
Historical helpers and CreateNew artifacts must not be rerun just to observe state.

`run-meta-manual-oct8-v12-r3.ps1` completed its single normal HTTP recovery of
October 8 at 13:55:08.251 KST: 55 ads/13 adsets, 68 published rows. Its fixed request
key is consumed. The old weekly failure and two failed manual runs remain intact.
`observe-manual-meta-v12-r3-warnings.ps1` observed exactly October 9–14 missing,
with automatic backfill disabled. `resume-normal02-v12-r3.ps1` then resumed the
isolated normal clock with all three provider pauses cleared and global stop off.
The alternative v12 healthy-provider partial resume was reviewed but not executed.

The next normal Cafe24 slot is October 16 02:00 KST for October 15. The next Google
and Meta slots are October 22 02:01/02:02 for October 15–21. These remain pending
actual evidence; manual recovery is not a seven-day scheduled success. Renew only
the new isolated Storage credentials before the October 18 13:42 KST TTL gate
(expiry October 19 13:42:15); preserve the seven-day maximum and 24-hour minimum.
See the final record for precise log coverage, idle evidence and remaining gates.
Final October 15 read-only observations: 14:04 KST log scan completed across all
seven deployments (2,033 returned Railway entries), Edge (171) and Postgres (774),
with zero matches against 57 current known-secret candidates. The Edge/Postgres
window was 09:55:39–13:55:39 KST; late arrivals and future logs remain excluded.
At 14:05:50 KST v12 was SLEEPING, with zero live leases and zero own-runtime
client/active Postgres backends. This is manual-day save-to-sleep evidence; it does
not establish all frontend sockets, RSS, billing, or a weekly seven-day success.

## October 15 afternoon isolated test

The user authorized same-day accelerated real-clock validation. The immutable
v13 source is `6bf11939a6f7b4c676377c1c679a3a6473d158374072896b4ee15711f36a1fde`
in `full-app-build-20261015-accelerated-v13`; the current reviewed deployment ID
is pinned in `deployment-evidence.mjs`. Its two application changes accept only
the three fixed October 15 test tuples and preserve coherent already-published
Cafe24 API lineage when an unchanged daily snapshot is collected again.

The outage profile is Meta 15:00 KST with a 35-minute window; Cafe24 is 15:40,
and Google retains its original 02:01 anchor. The collection profile changes only
Meta to 16:00 with a 90-minute window. These are explicit one-day test exceptions,
not permission for general accelerated schedules or automatic historical backfill.
All real changes use the new08 project/schema/service only.

The v13 app was actually removed before 15:00. While the app is absent, leave the
scheduler enabled so its external failures and closed-window audit are durable.
After the real 15:38 audit, stop scheduling, restore the old outage configuration,
and observe the authenticated missing-date warning before changing Meta's anchor.
Prepare collection variables, database profile, same-image deployment, actual
deployment verification and new signed evidence in that order before resuming.
Do not reuse a consumed CreateNew mutation marker or expired evidence envelope.

For restart evidence, stop between committed Meta units at a natural zero-lease
boundary, fingerprint October 8, redeploy the same image, verify and resume with
fresh proof. Compare the first-day fingerprint and attempt count only after more
dates actually complete. After both providers finish, read their strict aggregate
proofs and the native forwarding status, then observe the same collection
deployment naturally sleeping before any final redeployment. Restore normal
02:00/02:01/02:02 definitions, all 149 active jobs, original call-function bytes
and normal v3 Edge source using the guarded afternoon helpers. Keep the v13 fix.

`records/08_결과.md` is authoritative for completed actions and pending results.
A 35-minute window-exceeding outage is actual evidence for bounded outage recovery;
it is not a claim of multiple elapsed days without service. Forced lease expiry,
commit-response loss and virtual clocks remain separately identified synthetic tests.

### October 16 isolated continuation (real clock, v18)

The October 16 contract and latest `records/08_결과.md` supersede the October 15
pause. The fixed isolated v18 manifest is
`f1b78cdbdb2a7bd7c6c86da5891c8725181297c4f1b431893bb44042d4ff9b09`
(`full-app-build-20261016-v18`, 475 files). Meta publication remains bounded by
30 seconds and remaining-unit-budget minus 2.5 seconds; the Meta unit ceiling is
65 seconds, with unchanged 75/85-second relay/native timeouts and final fencing.
The application additionally accepts only Cafe24 October 16 10:15 KST / 110
minutes and Meta October 16 10:20 / 90 minutes, bound to the existing new08
identity and connections. Google retains its original weekly anchor.

Use the October 16 helpers with single-use mutation markers. The initial v18
image is a new build; later restart and normal cutover must prove the same
actual image digest. First verify an actual SUCCESS/SLEEPING deployment before
updating the literal source/deployment pins. These helpers reject raw/string
counts, unknown mutation outcomes and any attempt to retry an ambiguous write.

1. Prepare test variables (`prepare-october16-variables.ps1 -Phase test`), upload
   the immutable source once, and run `verify-october16-deployment.ps1 -Action
   initial -DeploymentId <actual-id> -FrozenSourceNewBuild`. Pin only that
   verified identity; apply test DB and relay profiles with
   `apply-october16-profile.ps1` and `deploy-october16-relay.ps1 -Phase test`.
2. `prepare-october16-meta-fixture.ps1` creates only a fresh QUEUED run with seven
   empty units. This administrator preparation avoids overlapping the preserved
   failed October 15 weekly range without weakening ordinary cadence guards.
   It performs no provider calls and inherits no successful data. It is not
   automatic queue creation evidence. Cafe24 October 15 uses the ordinary new
   daily queue path; do not reuse the previous expired checkpoint.
3. Prepare fresh signed evidence with `prepare-scheduler-evidence.ps1` and the
   `schedules-october16-test-20261016.json` definition. Before 10:10, use
   `control-october16-global.ps1 -Action resume-test -EvidencePath <fresh-proof>`.
   Let the application sleep naturally; DB/control-plane observers do not make
   application HTTP calls. Never advance a virtual clock to label real success.
4. After actual October 9 Meta publication and natural zero leases, use
   `stop-restart`, `observe-october16-proof.ps1 -Mode first-before`, then
   `change-october16-runtime.ps1 -Action restart`. Verify the returned actual
   deployment using `verify-october16-deployment.ps1 -Action restart`, update the
   deployment pin, create new signed evidence, and `resume-restart`. After actual
   October 10 publication, `-Mode first-after` must verify unchanged October 9
   fingerprint/attempt count and a same-image receipt. Preserve the Cafe24
   checkpoint throughout the restart.
5. `observe-october16-proof.ps1 -Mode weekly` and `-Mode cafe` must both pass
   strict stored-data proofs (seven Meta dates and completed October 15 Cafe24).
   Then stop-normalize at zero leases, collect the two native success-status
   responses with `probe-october16-complete-status.ps1`, and observe the same
   collection deployment naturally SLEEPING with zero own runtime backends.
   These status requests write only expected transport-security tables; do not
   claim globally zero database writes.
6. Prepare normal variables, apply normal DB and relay profiles, and use
   `change-october16-runtime.ps1 -Action normal` / strict same-image verifier.
   Pin the verified deployment and run
   `probe-october16-normal-definition.ps1 -NormalProbeApproved` before new normal
   signed evidence and `resume-normal`. The direct closed-status oracle must
   reject the now-nonmatching test occurrence without collecting provider data.

Every mutating helper also requires `-ExecuteApproved`; this is a guarded CLI
argument for the user's already authorized new08 work, not permission to touch
operating resources. `first-before`, `first-after`, `weekly`, and `cafe` are
read-only proof modes and do not take that switch.

Normal alignment is Cafe24 daily 02:00, Google Thursday 02:01, Meta Friday 02:02
KST. Meta's normal anchor is October 15 17:02Z (October 16 02:02 KST), so the next
weekly selection on October 23 is October 16-22. Restoring the old Thursday
anchor would select the already tested October 15 again. The normal relay is
based on the old normal code with this explicit anchor and fixed read-only
inspection scopes; do not claim byte-identical restoration of the old relay.

Public receipts stay outside the checkout in `MetaAdsPhase08Evaluation`.
Keep old failures and the 38m58s real outage evidence. Its measured duration is
not a multi-day outage; virtual multi-day recovery tests remain synthetic.
Final records must distinguish administrator preparation, actual Cron calls,
manual assistance, protected offline observations, synthetic tests and bounded
known-secret log scans. Do not mark 08 DONE until all actual proof gates pass.

### October 16 separate 12:30 verification

The first Meta 10:20–11:50 run ended at 5/7. Preserve it and its original
counters, deadline, failed attempts and two queued dates. Do not extend that
run or relabel it complete. Cafe24 completed at 12:00:13 KST before its original
12:05 deadline. Its 343 orders/379 lines, API-only policy, current versions and
links, and zero checkpoints are independently verified.

The new 12:30–14:00 run is an additional isolated verification iteration. It
really fetches all October 9–15 dates again, including five prior successes;
this repeated test traffic is separate from normal weekly once-per-date
collection. Its administrator-created seven QUEUED units start at attempt zero
and inherit no successful unit. Cafe24 keeps its completed 10:15 occurrence for
status verification and adds no collection. Google adds no provider request.

Frozen v21 has 475 files and source
`f7592804a9763eb228d7c97be00479431700e78b7c57e4544b4c6a863556e4df`.
It changes only the exact isolated 12:30 Meta tuple relative to frozen v20.
The actual initial deployment is `5b6caf98-f569-4c6e-9086-2401cae2dd7b`.
The database repeat call is `e53b9aad9453733a4113c09d0ee69657`; Edge is version6.
The temporary minute-interval cron and two terminal retry exceptions were
removed before this profile. Cafe24 paused is false. Cooldown adjustment,
slot11:50 pause, and direct operator collection dispatch were never executed.

The earlier actual v20 same-image restart already proves two committed dates'
fingerprints/attempts unchanged and the next date's subsequent success. Do not
add a second restart requirement or use the original 10:20 controls for this
new occurrence. The repeat runtime helper only permits final normal cutover.

Read-only observation is `observe-october16-repeat-progress.ps1`. After real
collection, `observe-october16-repeat-proof.ps1 -Mode weekly` and `-Mode cafe`
must pass. The new seven SUCCEEDED units, their publish audits and fourteen
coverage slices are mandatory. An unchanged idempotent metric can retain a
previous PARTIAL run's committed owner only when its exact successful unit,
atomic publish audit, current metric/version/link and account/day all agree.
This does not copy an old successful unit into the new run.

Only after real success: stop at natural zero leases with
`control-october16-global.ps1 -Action stop-repeat-normalize -ExecuteApproved`.
Run the protected read-only membership verifier and two success statuses with
`probe-october16-repeat-complete-status.ps1`, then observe this same collection
deployment naturally SLEEPING and its own runtime backend count zero. Native
status forwarding can write expected transport security records; it is not a
globally write-free database action.

For final normal cutover, while stopped: `prepare-october16-v21-variables.ps1
-Phase normal`, `apply-october16-repeat-profile.ps1 -Phase normal`, and
`deploy-october16-repeat-relay.ps1 -Phase normal` restore normal app/DB/Edge
profiles. The expected call becomes 0f11 and Edge version7; preserve all nine
secret digests. Use `change-october16-repeat-runtime.ps1 -Action normal`, verify
the actual returned deployment with `verify-october16-v21-deployment.ps1`, and
only then update the literal deployment pin. The normal negative loaded-profile
oracle must run within thirty minutes of the two complete native status
receipts. Create fresh signed normal evidence from
`schedules-october16-v21-normal-20261016.json`, then `resume-normal`.
Every mutation helper also requires `-ExecuteApproved` and a fresh single-use
marker; do not replay consumed commands.

Normal scheduling remains Cafe24 daily02:00, Google Thursday02:01, and Meta
Friday02:02 KST. After the normal deployment is actually verified, append only
that exact ID to the reviewed log profile (all earlier deployments retained),
run the final bounded live log scan, and verify normal SLEEPING/runtime0,
149 enabled jobs, force-RLS68, and original152 history preservation. Stage09
and operating resources remain outside this task.

### October16 v22 continuation delta

The exact two-file frozen candidate is475files/source0f790d901c949fc456dce6ab863b4bccca10a212b7c7b75afb03f52a0979fdc1, actual initial25e68a9b-04f6-4329-b6bd-b5a3391fb01c. Initial upload, variable preparation, verification and resume-repeat-publish-fix are consumed. New version-specific observation is observe-october16-v22-repeat-progress.ps1 and observe-october16-v22-repeat-proof.ps1. Use october16-v22-repeat-meta-membership-readonly.mjs, probe-october16-v22-repeat-complete-status.ps1 and probe-october16-v22-repeat-normal-definition.ps1 for final proofs. The pure repeat SQL/profile contract and original14:00 deadline remain unchanged.

After all real seven-day proofs: stop-repeat-normalize once, then prepare-october16-v22-variables.ps1 -Phase normal, apply-october16-v22-repeat-profile.ps1 -Phase normal, deploy-october16-v22-repeat-relay.ps1 -Phase normal, change-october16-v22-repeat-runtime.ps1 -Action normal, verify-october16-v22-deployment.ps1 -Action normal. Each mutation requires -ExecuteApproved; preserve original v21 test receipts. Normal call0f11/Edgev7/FridayMeta remain mandatory. After actual normal deployment verification, update literal pins; run the negative loaded-definition oracle within30minutes of complete native status, fresh signed evidence scheduler-evidence-october16-v22-normal-20261016.json generated from configuration schedules-october16-v22-normal-20261016.json, and resume-normal. Reviewed log IDs may be appended only after actual verification; previous20 must remain. Do not replay consumed markers or change counters/deadline to obtain success.
The actual whole-week metadata BOUND failure is preserved in october16-v22-repeat-membership-bound-failure-actual-20261016.json. Use the approved new october16-v22-repeat-meta-membership-per-day-readonly.mjs (export verifyMetaMembershipPerDay): same RR30s snapshot,7days sequentially, each-day16MiB, whole50k rows, existing complete metadata/unit/coverage proof unchanged, only safe day hashes/counts accumulated. Actual success is october16-v22-repeat-membership-per-day-actual-20261016.json. No new image or provider collection was used for this reader correction. Final observation is observe-october16-v22-final-state.ps1 -Mode collection-idle, then -Mode final-normal after normal restoration; each writes a separate CreateNew receipt and requires actual SLEEPING/backend0.
### Final closure — October16

All phase08 isolated verification gates passed. Actual final state is october16-v22-final-normal-state-actual-20261016.json (13:51:06KST), same source0f790/normal3ccd/same-image previous25e, SLEEPING/Supavisorbackend0/lease0/currentCafe+MetaCP0, STOPfalse/149active/paused0/normal3definitions/original0f11/68FORCE_RLS/original152history preserved. Earlier post-scan idle1 observation rejected the gate and produced no false success receipt; it naturally drained before the final pass. Do not replay any completed prepare, control, deployment, fixture or restoration command.

Actual full-week proof is october16-v22-repeat-weekly-proof-actual-20261016.json:7dates/3,661ads+1,400sets=5,061,14coverage slices, required purchases, raw-null basis, retained value differences and five NULL video fields. Per-day membership success and the earlier whole-week bound failure are both retained. Cafe379-line/343-order checkpoint recovery finished before its original deadline. Original Meta10:20 partial5/7 remains unchanged; the separate12:30 test really re-fetched the five earlier successes, with no inherited units or reset deadlines/counters.

Actual final log scan relay-log-scan-actual-20261016-final.json passed22deployments/6,313returnedRailwaylogs,258Edge/functionlogs/11pages and828PGlogs/34pages,57currentknownsecretcandidates/no match/full paging exhaustion. Supabase window09:38:03–13:38:03KST; Railway responses are not time-filtered, analytics ingestion is not atomic, and late/future logs or every possible secret are outside this proof.

Normal isolated scheduling is Cafe daily02:00, Google Thursday02:01, Meta Friday02:02KST. NextMetaOctober23 selectsOctober16–22. No automatic backfill/month correction, newCSV, operating resource change or stage09 work was added. Actual38m58s outage and native forwarding/guard/restart proofs are separate from synthetic multi-day/multi-week, lease-expiry and forced-kill tests. Temporary minute cadence, three Cafe yield slots and terminal retry exceptions were restored; this is not a claim of unassisted fairness or recurring02:00SLA. Existing isolated credential expiry/rotation handoff remains; no operating Storage schedule was touched. All local test processes/PG54418 are stopped. Continue only from latest completed records08 and a new user instruction.