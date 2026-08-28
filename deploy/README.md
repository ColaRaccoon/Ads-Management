# Local-native deployment and recovery runbook

This is the active deployment path for the local multi-user installation. The
application keeps **only PostgreSQL** in the existing Supabase project. Login is
local native username authentication and file payloads use local NTFS storage.
Supabase Auth and Supabase Storage are not used by this deployment.

The older Docker/compose staging files are retained as historical step-8
artifacts; they are not an installation dependency and must not be built,
published, pulled, or promoted for this local-native rollout.

## Fixed security boundary

```text
approved LAN client -- HTTPS 443 --> Windows Edge
                                      |-- Web 127.0.0.1:3200
                                      `-- signed /backend-api --> API 127.0.0.1:4200
                                                                  |-- TLS verify-full --> exact Supabase PostgreSQL :5432
                                                                  `-- local NTFS data/storage
```

- No Web, API, database, or filesystem path is directly exposed to the LAN.
- Port 443 binds only to the explicitly configured private server address.
- Empty hostname, bind address, exact client `/32` list, client trust, or firewall evidence
  means loopback-only. It never means “allow the LAN.”
- Router port forwarding, UPnP, public DNS, internet publication, cloud hosting,
  container registry use, and external deployment are outside the design.
- The application never owns or changes the existing `3100`/`4100` processes.
- Source and release paths are immutable inputs. Data, secrets, evidence, logs,
  and backups live outside the repository and outside release directories.

The Node application and release verifier are path-, hostname-, IP-, and
OS-independent. `deploy/windows` is the replaceable host layer for service,
firewall, certificate-store, account-right, and NTFS ACL operations.

## Offline installation media prerequisites

The deployment scripts do not download or install software. Prepare approved
offline media containing the immutable release, a supported Node 22 runtime,
WinSW service wrapper, PostgreSQL client tools (`psql`, `pg_dump`, `pg_restore`)
compatible with the selected Supabase PostgreSQL server, and an approved offline
PowerShell 7.4 LTS runtime. Certificate generation uses the pinned Windows
PowerShell certificate APIs and does not require OpenSSL.
Record SHA-256 for every executable. Windows host operations require the exact
hash-pinned `pwsh.exe`; Windows PowerShell 5.1 parsing is only a syntax regression
check and is not an operationally supported executor. No PostgreSQL server,
Docker, package registry, or cloud CLI is needed.

On a replacement PC, copy the same hash-pinned media to install-selected paths;
do not download “latest” binaries during recovery. Node and WinSW paths are
arguments/configuration, not fixed drive locations.

## Install-time settings

Start from `deploy/local/config.example.json` and validate against
`deploy/local/config.schema.json`. Do not put the completed file in Git.

Required choices are the exact existing Supabase project reference, direct or
session-pooler host on port 5432, database/schema, four distinct restricted DB
roles (runtime/migration/backup/restore), pinned CA file/hash, release ID/digest,
OS application-data root, and four distinct non-admin Windows principals
(Core, Edge, Backup, and receipt Signer). The
restore role may authenticate only to the isolated restore database and must
have no CONNECT, schema, object, or membership path into the production
database. LAN hostname, private bind IP,
exact private IPv4 `/32` addresses, and client UUIDs remain null/empty until deployment. Subnet-wide CIDRs are rejected. Backup root and
daily time remain null until a different encrypted physical disk or encrypted
SMB 3.1.1 NAS is selected.

The default data root is resolved outside the repository:

- Windows: `%ProgramData%\MetaAdsPerformance`
- macOS: `~/Library/Application Support/MetaAdsPerformance`
- Linux: `$XDG_DATA_HOME/meta-ads-performance`, or
  `~/.local/share/meta-ads-performance`

Use absolute install-specific paths in the generated configuration. Code must
not assume a drive letter, computer name, address, or user profile.

`deploy/local/api.env.example` is a shape reference. The completed API file and
each pgpass file are secret files and must never be printed, logged, copied into
a release, or committed. The local API configuration rejects Supabase Auth and
Storage variables and requires the database URL to match the exact runtime
configuration with `sslmode=verify-full` and the pinned CA.

## Preparation without host or database changes

These steps are safe before approval:

1. Run the repository tests, lint, build, Prisma validation/generation, and the
   PowerShell parser check.
2. Assemble a release directory containing the built API/Web runtime and
   dependencies. Run `node deploy/local/package-local-release.mjs
   --root=<RELEASE_ROOT> --release-id=<RELEASE_ID>` once. Record the returned
   manifest hash and migration digest without modifying the release afterward.
   Packaging parses the staged Windows host bundle and runs the staged
   source-free cold-start contract before it writes manifest v4.
3. Run `node deploy/local/verify-local-release.mjs --root=<RELEASE_ROOT>
   --manifest-sha256=<HASH>` whenever the release is transferred.
4. Create the data-root directory layout and four distinct local non-admin account
   names in an installation worksheet only. Passwords are never worksheet data.
5. For service, firewall, ACL, principal rights, backup schedule, maintenance,
   recovery kit, restore, client trust, CA issue/renew/activate, production
   migration, release switch, legacy quiesce, legacy storage staging, and every
   evidence-writing Verify/Merge/Measure/Publish action, run
   `-Action Plan -PlannedAction <exact-mutation>` with every final non-secret
   argument. Retain the JSON containing `exactParameters`, target, impact,
   rollback, script/contract hashes, CSPRNG `approvalNonce`, issued/expiry times,
   `approvalInstanceId`, ADMIN_ONLY `approvalLedgerPath`, and `planSha256`. Review
   and approve that exact plan immediately before execution. The mutation command
   must repeat the identical arguments and add `-Approved`,
   `-ApprovedPlanSha256 <planSha256>`, and the five approval-instance fields from
   that Plan; a changed path, account, hostname, bind IP,
   client `/32`, release/manifest/evidence hash, or Supabase project/host/database/
   schema produces `APPROVED_PLAN_MISMATCH` before mutation. Approval expires in
   ten minutes and the plan instance is atomically consumed in its ADMIN_ONLY
   ledger before the first mutation; replay and partial-failure reuse are rejected.
   `-Approved` alone is never sufficient. Credential/password contents
   are never plan fields; only their exact protected path and expected file hash
   may be included. Generate a new Plan for rollback/finalize or evidence-writing
   Verify actions instead of reusing an Apply plan.
6. Obtain an approved Supabase CA bundle through the installation process, pin
   its SHA-256, and prepare exact one-record pgpass files for runtime, migration,
   backup and read-only administrative audit. Prepare the distinct restore
   credential only for the separately approved isolated restore database; the
   production boundary records the role identity and proves it has no production
   access. Do not reuse passwords.

The release assembler must produce this minimum layout before packaging. Copy
the complete API `dist` tree (including the compiled local bootstrap CLI), the
complete Prisma schema/migrations, production API dependencies, the complete
Next standalone server tree plus `.next/static` and `public`, and the listed
local launchers. Do not copy source `.env` files or any key/pgpass material.

```text
<RELEASE_ROOT>/
  api/dist/main.js
  api/dist/auth/bootstrap-local-super-admin.cli.js
  api/dist/staging/business-compatibility-smoke.cli.js
  api/dist/staging/legacy-business-compatibility-smoke.cli.js
  api/dist/staging/auth-role-matrix-smoke.cli.js
  api/package.json
  api/prisma/schema.prisma
  api/prisma/migrations/.../migration.sql
  api/node_modules/@prisma/client/...
  api/node_modules/.prisma/client/... # generated client and native engine
  api/node_modules/prisma/build/index.js # offline migrate-deploy CLI
  api/node_modules/...
  web/server.js
  web/package.json
  web/.next/BUILD_ID
  web/.next/required-server-files.json
  web/.next/server/...
  web/.next/static/...
  web/public/...                 # when the application has public assets
  web/node_modules/...
  deploy/local/launch-local-bundle.mjs
  deploy/local/start-edge.mjs
  deploy/local/https-edge.mjs
  deploy/local/runtime-config.mjs
  deploy/local/api-config.mjs
  deploy/local/verify-tls-material.mjs
  deploy/local/verify-local-release.mjs
  deploy/local/verify-runtime-readiness.mjs
  deploy/local/verify-attestation.mjs
  deploy/local/verify-https-release.mjs
  deploy/local/smoke-local-release.mjs
  deploy/windows/...             # exact 37 PS1 + 2 service XML host bundle
```

The packager inventories every file, rejects secret-like paths and reparse
points, rejects `api/src`, `web/src`, and `.git`, and creates the manifest with
exclusive-create semantics. Manifest v4 binds a digest of the exact Windows host
file set and a digest of the cold-start contract. The staged smoke syntax-checks
all entrypoints, proves missing production config fails closed, executes the
seven-state role matrix, starts the packaged Prisma CLI, and starts the packaged
Web server only on loopback. The manifest
binds the target OS, CPU architecture and Node modules ABI because the Prisma
engine is native; a bundle may be rebuilt on another supported Windows PC but a
native bundle from a different platform/architecture/ABI is rejected. Transfer
and service installation must use only a release that passes full-tree
verification. Prisma migration commands use only the CLI, schema and migrations
inside that same immutable release, so an offline recovery does not depend on a
source checkout or registry.

The production database roles and existing schema must satisfy
`Test-SupabaseDatabaseBoundary.ps1`: non-superuser/no-create/no-bypass-RLS,
bounded connections, SCRAM credentials, no role memberships, migration-owned
objects, runtime DML only, backup read only, no runtime access to
`_prisma_migrations`, no PUBLIC schema/function privilege, and safe default
privileges. The configured restore role must be a restricted LOGIN role with no
production database CONNECT, schema usage, object rights, or role memberships.
The migration LOGIN owns the application schema and is therefore explicitly a
full-data privileged account, not a DDL-only account. Its pgpass must remain in
the `ADMIN_ONLY` ACL class and may be read only during an approved maintenance
migration. Runtime and backup services never receive that credential. Boundary
evidence also verifies the exact append-only audit function and both enabled
update/delete and truncate rejection triggers.
Creating or changing production roles is a production database change
and therefore requires a separate immediate approval before it is done.

## Approval-gated Windows installation

Run elevated PowerShell only after presenting the exact values and rollback for
the step being approved. Approval for one step does not authorize another.

1. **Principal rights** — `Manage-PrincipalRights.ps1` assigns service logon and
   explicit interactive/remote/network logon denial to the three exact local
   principals. Rollback restores the prior policy backup.
2. **NTFS ACL** — `Manage-Acl.ps1` applies eleven disjoint access classes and
   verifies every descendant. Rollback restores hash-pinned DACL and owner data.
3. **Database boundary read-only check** —
   `Test-SupabaseDatabaseBoundary.ps1` verifies TLS, credentials, roles, schema,
   grants, ownership, sequences, functions, and default privileges. Its optional
   evidence write also requires approval. It never changes the database.
4. **Stopped service install** — `Manage-Service.ps1 -Action Install` installs
   the hash-pinned Core and Edge wrappers with both services Manual/stopped. A
   reboot cannot implicitly start them. This does not stop or reconfigure
   `3100`/`4100`.
5. **Bootstrap** — while loopback-only, place a version 2 request containing
   `username`, `authorizationPrivateKeySha256`,
   `authorizationPublicKeySha256`, and `signingKeyId` in a newly created
   ADMIN_ONLY file using an interactive editor or hidden prompt. The username is
   never accepted in argv. The private key is readable only from SIGNER_ONLY;
   its Ed25519 public key is hash-pinned in SHARED_RUNTIME. Runtime files belong
   to SHARED_RUNTIME, the filesystem/database-boundary evidence to
   ADMIN_EVIDENCE, and request/authorization/ledger/setup-token outputs to
   ADMIN_ONLY. Run the
   compiled `api/dist/auth/bootstrap-local-super-admin.cli.js` from the verified
   release in dry-run mode with the request file/hash, runtime config/hash,
   filesystem evidence/hash/descriptor digest, database-boundary evidence/hash,
   and the intended ADMIN_ONLY setup-token path. Dry-run does not accept or
   consume an authorization.

   Immediately before an apply, present the exact Supabase project/host/database/
   schema, normalized username digest, release/runtime/evidence hashes, target
   setup-token path, impact, and rollback, then obtain the database-mutation
   approval. Only after that approval, run
   `deploy/local/new-bootstrap-authorization.mjs` with `--mode=bootstrap`, the
   exact request/runtime/filesystem/boundary/setup-token paths and their expected
   hashes, the filesystem descriptor digest, private/public key paths and hashes,
   expected signing key ID, a fresh unused ADMIN_ONLY ledger path, and a new
   ADMIN_ONLY authorization output path. The producer rejects reparse/hard-link,
   filesystem-class, key-pair, or hash drift. Pass the resulting authorization
   hash, public-key path/hash and ledger path to the CLI together with `--apply`
   and the exact database confirmations. The CLI verifies the pinned signer and
   signed ten-minute
   authorization, consumes it with create-new semantics immediately before the
   first DB write, deletes the request, and writes the one-time setup token only
   to the evidenced handoff directory. A failed or repeated attempt requires a
   new request, ledger path, approval and authorization; never delete or reuse a
   consumed ledger record.

   `--recover` follows the same sequence with `--mode=recover` and additionally
   binds the fresh maintenance, drain and pre-change backup evidence files and
   hashes. It always requires a new immediate approval. Exactly one bootstrap
   `SUPER_ADMIN` can be created; later users are created from the management
   screen and complete a one-time setup token. No password or token is emailed,
   placed in argv, or written to logs.
6. **Separate process start** — immediately before `Manage-Service.ps1 -Action
   Start`, present the exact services, bind state, impact and `Stop` rollback and
   obtain process-transition approval. A prepared LAN-disabled configuration
   starts Core only on loopback; a fully evidenced LAN configuration starts both
   services. Run `Verify` after start.

Do not install services until the executable, launchers, runtime/API config,
filesystem evidence, and principal-right evidence hashes match the command.

## CA and LAN opening sequence

Client trust is established before the server listens on the LAN:

1. `New-InternalCa.ps1` creates the CA temporarily in the administrator's
   CurrentUser store, exports its private key immediately to an encrypted PFX plus
   a separately ACL-protected random escrow-password file under `ADMIN_ONLY`, and
   removes the online-store private key before success. The public CA is copied to
   `EDGE_READ`; the script does not trust it on any client. Store removal and the
   encrypted offline artifacts are verified. `Renew-ServerCertificate.ps1`
   imports that PFX only with `EphemeralKeySet`, issues hash-pinned same-CA server
   material for the configured hostname, and verifies that no CA/server private
   key remains in the online store.
2. On each explicit client, assign a random lowercase UUIDv4 and run
   `Manage-ClientTrust.ps1 -Action Install` only after approval. Rollback removes
   only the exact thumbprint.
3. Still with Edge stopped and firewall closed, run client `PreOpen` verification
   against the public CA/server certificate and merge the records with
   `Merge-ClientTrustEvidence.ps1`. Each record binds its install-time client UUID
   hash to one exact private IPv4 address; the aggregate stores those `/32`
   addresses plus UUID-set hashes/counts and must match the firewall/runtime list.
4. Update the runtime configuration with the exact hostname, private bind IP,
   exact approved client `/32` addresses, client aggregate, and HSTS. Re-run configuration and release
   validation. The hostname must already resolve to that private IP through an
   existing LAN resolver or an explicitly approved per-client hosts entry. Do
   not create public DNS or change the router. Name-resolution changes are not
   performed by these scripts and require their own target/rollback approval.
   Missing or stale evidence fails closed.
5. Immediately before applying `Manage-Firewall.ps1` and starting/enabling Edge,
   present the exact rule, interface/profile, program hash, service SID, client `/32` addresses,
   impact, and rollback and obtain approval. All firewall profiles must already
   be enabled with default inbound Block. The rule permits only TCP 443 on the
   exact private address and rejects Public-profile exposure, EdgeTraversal,
   conflicting allow rules, or internal-port rules.
6. From every authorized client, run `Manage-ClientTrust.ps1 -Phase Live` and
   merge live evidence. Confirm HTTPS release identity. Any unlisted client IP,
   direct Web/API ports, local data paths, and forbidden ports must remain
   unreachable.

All CA, renewal and activation commands hash-pin Node and their verifier scripts
and require those executors to be covered by the `SHARED_RUNTIME` ACL evidence.
Certificate rotation uses `Activate-ServerCertificate.ps1`. It requires
maintenance plus a fresh Edge-signed zero-request drain bound to the exact
service tree PID/start time, Node/command/release/runtime identity and 443
listener owner, swaps only hash-pinned same-CA
server files, restarts only Edge, verifies HTTPS by direct bind address with SNI,
and automatically restores the prior files on failure. Apply, rollback, and
finalize each require immediate approval; client trust-store state is unchanged.

## Daily backup and restore gate

The target is RPO 24 hours, RTO 4 hours, one backup daily. Until a backup target
and time are configured, the schedule must not run and readiness remains false.

1. `Test-BackupTarget.ps1` accepts only an exact protected ACL on a different
   BitLocker-encrypted physical disk, or an administratively confirmed encrypted
   SMB 3.1.1 NAS with snapshots/versioning. A UNC server that is localhost, the
   current hostname, a local interface address, or any alias resolving to a local
   interface is rejected. The approval plan and evidence bind a stable digest of
   the normalized remote server/share and its resolved remote address set. Core
   and Edge are denied; the dedicated backup principal is the only application
   writer.
2. `Manage-BackupSchedule.ps1` creates the exact daily task under that principal
   only after approval. Verification requires the Windows daily-trigger class,
   `DaysInterval=1`, `Trigger.Enabled=true`, the configured local time, an enabled
   task, start-when-available, the four-hour limit, and exact hashes for the
   runtime config, action and immutable release. The approved schedule plan binds
   the complete recurring `Backup-Local.ps1` invocation plus an admin-signed,
   maximum-31-day schedule authorization. The invocation binds the exact runtime
   config hash, backup-target evidence hash/fingerprint/root, ACL class, executor
   hashes, PgPass/integrity/receipt-key hashes and size/deadline caps; changing any
   value requires a new authorization and schedule plan. The schedule authorization
   is v3, also binds the exact NAS-identity helper hash, and carries its own CSPRNG
   nonce and instance identifier. Bare `-Approved`
   is never delegated to the backup account.
   Runtime readiness hashes the exact backup-target evidence bytes and requires the
   schedule receipt to bind that hash. Its target fingerprint includes the stable
   NAS server/share/address-set identity, resolved-address count, local-alias
   rejection, share-ACL confirmation, retention control, and the hash-pinned
   NAS-identity helper; any drift closes
   readiness and requires a new target verification and schedule approval.
3. `Backup-Local.ps1` verifies live disk/NAS identity, encryption and ACL drift,
   then makes a Supabase database dump with the backup role plus the local
   storage manifest. The migration digest is computed only from the verified
   immutable release. It publishes only an immutable `receipt-request.json` next
   to the completed artifacts and cannot read the receipt private key or modify
   `BACKUP_RECEIPT`. Before a one-time publish, an administrator consumes an exact
   ADMIN_ONLY plan and issues a signed, request-hash-bound authorization lasting no
   more than 15 minutes. Scheduled publication consumes the v3 admin-signed schedule
   authorization instead. `Publish-BackupReceipt.ps1` then runs under the fourth
   distinct, non-admin signer account: the key is read-only in `SIGNER_ONLY`, while
   immutable request copies and the independent one-use replay ledger are confined
   to `SIGNER_STATE`. It rechecks the publisher, semantic signer, PgPass, integrity
   key and receipt-key hashes immediately before signing. The semantic signer
   independently re-hashes the exact v6 manifest, HMAC, bounded dump, storage
   inventory, the NAS-identity helper binding, and any legacy reference-conversion
   artifact before publishing the
   signed latest receipt. Generic attestation signing refuses `backup-latest`.
   Receipts are constructed from an allowlist and contain hashes/metadata, never
   rows, file contents, credentials or unknown request fields.
4. `Restore-Verify.ps1` must run as the dedicated unprivileged restore verifier
   against a separately approved, existing isolated Supabase restore database
   and scratch filesystem. The isolated database may be a different database in
   the same existing Supabase project when the platform permits it; it must never
   be the production database. No script provisions a project or database. All
   secret inputs and output paths are copied into an ACL-isolated verifier scratch
   tree first. It first streams only bounded manifests, validates counts and byte
   limits, then copies only the manifest-listed dump and payload objects while
   hashing them. The archive TOC is restricted to the exact application schema.
   The script binds both API configs to the isolated target/database/schema and
   per-run local Storage root, proves the target catalog was pristine, runs
   previous-before, previous-after-migration and target-after-migration API and
   business smoke plus the complete 121-handler/10-permission compiled guard
   matrix and representative real HTTP non-invocation checks, checks KPI, storage
   references and byte hashes, then verifies full catalog cleanup and removes
   restored Storage, copied input and all scratch credentials/configs. Every
   external child process shares one absolute four-hour deadline; timeout kills
   its process tree, and database calls also have connection, statement, lock and
   idle timeouts.
5. Copy only the signed, non-secret restore receipt out of scratch with
   `Publish-RestoreEvidence.ps1` after presenting its exact source/destination,
   impact and rollback and obtaining approval. Never publish scratch secrets,
   logs, database rows, or payload bytes.
6. Only a fresh signed backup and a successful signed restore receipt make
   `operationalReady` true. A configured schedule alone is insufficient.

Backup, restore/rehearsal, and legacy-quiesce attestations use distinct Ed25519
key pairs. Every consuming Plan binds the exact public-key path and SHA-256;
substituting another attestation domain's otherwise valid public key is rejected.

If the physical/NAS target is not yet selected, the correct result is a warning,
no scheduled backup, and `operationalReady=false`—never a repository or same-disk
fallback.

Every 30 days, and immediately after host/role/firewall/client changes, renew the
read-only database-boundary, NTFS, firewall, client-trust, recovery-kit, backup
target/schedule, and isolated restore evidence. The Edge fails readiness when
these attestations expire. Daily backup receipt freshness is still limited to
24 hours; the monthly cycle is not a substitute for the daily task.

## Migration, maintenance, release switch, and rollback

Production database migration and process switching are separate approvals.

1. Verify both immutable release trees and their complete runtime dependency
   closure. Enable maintenance with `Manage-Maintenance.ps1` using a change
   approval ID.
   Its file binds the release and approval digest.
2. Wait for the Edge drain record to show zero active requests and a live Edge
   process. Migration and switch scripts accept only a fresh record.
3. Make and verify a fresh signed backup for the previous release. The restore,
   rehearsal and final compatibility evidence must all bind the same backup ID,
   backup-manifest hash and latest signed receipt; an older rehearsal cannot be
   reused with a new pre-migration backup.

   For later local-to-local upgrades, generate `Test-ReleaseCompatibility.ps1`
   evidence from both immutable manifests and the signed receipts. Previous
   migrations must be byte-identical; the delta must be additive and actual
   previous-before, previous-after and target-after API/business smoke must pass.

   The first conversion is deliberately different because the running legacy
   3100/4100 app uses old Supabase Auth but its uploads and reports are local
   files under the legacy repository; it is not a version-3 local release and it
   does not use Supabase Storage. `New-LegacyRunningBaseline.ps1` binds the clean
   Git tree, legacy migration chain, exact Node listener PIDs/start times, a
   protected restart specification, and aggregate byte/hash inventories for the
   two repository-local roots. It also measures the actual listener command-line
   arguments and process working directories, stores only secret-free canonical
   digests, requires them to match the restart specification, and records bounded
   loopback identity/health smoke digests. It never records the command line or
   working-directory text, reads file contents into evidence, or calls Supabase
   Auth or Storage.

   Immediately before the prechange backup, present the exact PIDs, impact and
   restart rollback and obtain process-transition approval. Run
   `Manage-LegacyQuiesce.ps1 -Action Apply`; it stops only the baseline-bound
   3100/4100 pair and signs evidence that both PIDs/listeners are absent. Then run
   `Stage-LegacyLocalStorage.ps1 -Action Stage` with separate approval. It copies
   into the configured data root only after the source inventory still matches,
   verifies every source/destination byte hash, and can roll back only those
   staged roots. Neither script contacts cloud Storage.

   Run `Backup-Local.ps1 -BackupMode LEGACY_BASELINE` after quiesce. This mode is
   bound directly to the baseline and stage evidence instead of requiring a v3
   release manifest. It accepts an explicitly proven zero-reference database,
   or creates a bounded, hash-pinned `storage-reference-conversion.sql` for the
   exact legacy rows while copying the complete local payload. The signed backup
   receipt binds the baseline, stage, conversion count/hash and migration chain.

   Run `Restore-Verify.ps1 -PreviousReleaseKind LEGACY_BASELINE`; it applies that
   conversion only to the isolated restore, verifies payload hashes/references,
   KPI and the target RBAC matrix, and labels the target-bundled projection smoke
   honestly: it is not execution of legacy code and cannot prove rollback-code
   compatibility. `Test-InitialCutoverCompatibility.ps1` requires the signed
   quiesce, backup and rehearsal evidence and does not require live 3100/4100.
   `Manage-SupabaseMigration.ps1 -PreviousReleaseKind LEGACY_BASELINE` rechecks
   their absence and, only after a fresh immediate production-migration approval,
   applies the signed reference conversion before the target Prisma migration.
   Rollback after that point uses `Manage-SupabaseRollbackRestore.ps1`: create a
   fresh `Apply` Plan bound to the exact production Supabase project/host/database/
   schema, maintenance/drain, migration journal, signed legacy backup chain,
    executor/credential/key hashes, durable rollback journal, fresh drain and the
     current Edge PID/start time/executable/command/release/listener identity, and
     the exact signed `legacy-quiesce` evidence and type-specific public-key hashes.
     It rechecks the baseline PIDs, restart digest, evidence freshness, and writer/
     listener absence immediately before INTENT. Apply keeps 3100/4100 quiesced and writes a flushed atomic `INTENT` before the first
    mutation. In one transaction it renames the current schema to an approval-
    instance-specific preserved schema; it never drops that pre-rollback schema.
    The signed archive then recreates a pristine target schema. Apply restores the
    runtime-role grants, verifies them, KPI, and unchanged repository-local storage
    inventories, while every stream/hash/child/cleanup shares one monotonic four-
    hour deadline and verified process-tree termination. It retains the preserved
    schema, writes `COMPLETE_MAINTENANCE_REQUIRED`, and signs
    `legacy-database-rollback` with the restore key. On any failure after INTENT it
    transactionally drops only the partial restored target and renames the
    preserved original back when possible; otherwise it atomically writes
    `FAILED_MAINTENANCE_REQUIRED` and the preserved schema must remain untouched.
    Because a client failure can make COMMIT acknowledgement uncertain, every
    boundary failure freshly queries both schema names. It treats `0|1` and `1|1`
    as committed/partial states, transactionally restores the preserved original,
    verifies `1|0`, and journals the observed state; it never trusts only the child
    exit result to decide whether mutation occurred.
    Maintenance and quiesce remain mandatory in either case. A separately approved
    `VerifyEvidence` Plan rechecks the journal, receipt, role grants and live hashes.
    Only then is the rollback receipt supplied to
   `Manage-LegacyQuiesce.ps1 -Action Rollback` using the exact restart
   specification. Rollback must reproduce the protected launch identity and pass
   the same bounded legacy health smoke before it reports success. It never
   records `rollbackCodeCompatible=true` for this first cutover.
4. `Manage-SupabaseMigration.ps1 -Action Apply` writes an INTENT journal before
   invoking the exact target Prisma migration digest, and requires a new immediate
   production-migration approval. It uses the dedicated migration role, pinned
   CA, pinned Node/Prisma/verifier, exact ACL classes, previous-release backup,
   maintenance, signed exact-Edge drain identity and compatibility evidence.
   The Plan, action-time check, and durable journal reject a restarted process,
   wrong listener owner, command/release drift, or stale drain. Apply stops at
   `APPLIED_PENDING_BOUNDARY`; it cannot claim final PASS.
5. Produce fresh post-migration database-boundary evidence, verify the exact
   applied migration chain, then run `Manage-SupabaseMigration.ps1 -Action
   Finalize` to create final migration evidence. Rollback is an independently
   approved restore, not an implicit SQL reversal.
6. Make a target-release backup and complete/publish its restore verification
   before target readiness is asserted.
7. `Switch-LocalRelease.ps1` requires the finalized migration evidence whenever
   the migration digest changes and verifies the target's signed operational-
   readiness evidence. Under maintenance and a fresh drain it stops Edge then
   Core, atomically switches stable config plus both service XML generations,
   starts Core then Edge, and verifies each exact Node executable, launcher,
   release root, manifest, runtime/API path and live process identity. The durable
   journal binds both prior and target XML/process identities. Apply, rollback and
   finalize Plans also bind the current Core/Edge XML hashes, PID/start times and
    process identity digests, plus the signed drain snapshot and exact 443
    listener owner, so an approval cannot be reused after service drift.
   Prior XML/config copies and journal updates use write-through file flush plus
   atomic same-directory replacement. On failure it
    runs the hash-pinned bounded HTTPS verifier against the exact private bind
    address, SNI hostname, CA, server certificate and expected release response.
    Probe failure is an Apply failure and automatically restores and HTTPS-probes
    both prior services. Explicit rollback
   verifies the old full manifest and both hash-pinned XML files before starting.
   Finalize removes only rollback artifacts after an approval.
8. Disable maintenance only after role matrix, KPI, storage hash, backup and
   signed runtime-readiness checks pass. Removal is followed by a hash-pinned,
   direct-address/SNI/CA HTTPS 200 check; failure atomically restores the exact
   maintenance flag.

Never run migration, restore, release switch, or certificate activation against
production merely to test a script.

## Reboot verification and incident recovery

After an approved reboot, `Test-RebootReadiness.ps1` verifies service start
modes, exact listener ownership, loopback-only Web/API, Supabase readiness,
HTTPS release identity, principal rights re-evaluated after boot, daily task,
and backup freshness. The new services must not own 3100, 4100, 5432, 55432, or
6543. A LAN-disabled installation uses the reachable `core-prepared` verifier
mode and requires Edge to remain stopped/manual; full operational readiness is
required only for an enabled LAN installation.

Recovery order is:

1. enable maintenance and preserve logs/evidence without recording secrets or
   payloads;
2. on the current host, use `Manage-RecoveryKit.ps1 -Action VerifyExtract` to
   recheck current source hashes and remove the ephemeral extraction. On a clean
   replacement PC, use `-DisasterRecovery` with only the escrow kit and its
   separately copied escrow worksheet, the worksheet's expected
   kit/manifest/runtime/install/inventory hashes, hash-pinned
   offline Node/tool executors, and an existing empty `ADMIN_ONLY` scratch root.
    The kit tool's stdout/stderr are drained concurrently under a bounded buffer;
    timeout kills the complete process tree, waits a bounded interval, and fails
    hard unless the root and every snapshotted descendant are absent. Disaster verification authenticates
   and bounded-extracts the exact 13-file
   internal inventory, retains it for recovery, and neither requires nor emits
    any original source path;
   every recovery execution also hash-pins the process-tree, host-instance and
   NAS-identity helpers before dot-sourcing them, and the approval plan binds
   those exact helper paths and hashes;
   write the current-host and clean-PC results to two distinct ADMIN_EVIDENCE
   paths configured as `recoveryEvidencePath` and
    `disasterRecoveryEvidencePath`. Operational readiness requires both v6 receipts
    to bind the same kit, escrow worksheet, manifest, runtime, install, inventory,
    credential, executor and stable escrow identities. The offline worksheet
    carries only a one-way host-instance digest (never a raw hostname or IP) and
    the disaster verifier must produce a different host digest. A same-host drill
    is rejected. UNC escrow is resolved through the NAS identity validator, so
    localhost, the current hostname/interface, CNAME/local aliases, and identity
    drift fail closed. Current-host-only evidence is insufficient.
3. restore to an isolated target and verify the signed receipt;
4. obtain immediate approval for the exact production restore target, impact,
   and rollback; run the Plan/Apply/Verify sequence above without reusing an
   approval instance;
5. verify database boundary, four-role/inactive/setup-pending matrix, KPI
   aggregates, storage-reference and file hashes, release health, and RTO;
6. reopen only after client trust, firewall, and HTTPS checks pass.

For host replacement, repeat the same install-time configuration on another
Windows PC, restore the verified data set, issue a certificate for the chosen
hostname, and recreate only the Windows host layer. No application code change
or fixed hostname/IP/drive path is required.

## Gates that are intentionally not complete in the repository

The repository can prove fail-closed behavior and procedure integrity, but it
cannot claim an installed system is operational. The following remain explicit
deployment gates until real values, immediate approval, and resulting evidence
exist: local principal rights and NTFS ACLs; Supabase role/boundary evidence;
service installation/start; CA creation and client trust; private server IP/exact client `/32` addresses and
firewall; backup target/time/task and a fresh signed backup; isolated restore;
production migration; release/certificate switch; reboot and LAN negative-path
tests. Missing any required record keeps LAN closed or
`operationalReady=false`; it is never reported as PASS from a mocked value.
