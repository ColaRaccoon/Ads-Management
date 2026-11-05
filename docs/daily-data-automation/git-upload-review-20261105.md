# Git preparation and next-day collection check — 2026-11-05

The deployed Meta diagnostic/retry and USD 10 tolerance changes from `codex/meta-retry-evidence` have been merged into the main workspace branch, `codex/platform-product-mapping`. This preparation does not deploy or push that branch. The running production release remains `6c66dbf4b35e55928e6a358dcc4cf9597f36f30b`.

## Next scheduled verification

Automation 24 remains active at 04:10 Asia/Seoul. On November 6 it must report the November 5 Cafe24 and Meta **scheduled** results even when healthy, followed by the actual product-margin sales/ad-spend verification. Manual recovery is reported separately from scheduled success.

1. Run `scripts/check-daily-collection.ps1` without a date override. It validates actual scheduled success, coverage pointers, API source policies, scheduler/auth health and approved spend-tolerance evidence.
2. Run `scripts/check-daily-product-margin.ts` without a date override through the existing authenticated Railway production environment. It uses the existing protected database context and a repeatable-read, read-only transaction. It calls the same `SalesMetricsService.productPerformance` as the product-margin screen and compares sales/adset counts, allocated plus unallocated ad spend, and exchange-rate availability against canonical data. It makes no provider requests or business writes.
3. Save aggregate receipts under ignored `reports/`; report failures, missing data and mapping/FX issues without printing customer records, ad names or credentials.

The new margin checker was verified read-only against November 4: 328 sales lines, 200 adsets, matching allocated/canonical ad spend, no unallocated ad spend or missing FX. This verifies the checker and existing manual recovery, not the next scheduled run.

## Upload exclusions

- `outputs/`: locally retained user spreadsheets, preview images and generation artifacts.
- `reports/`, environment files, local credentials, build/cache output: existing exclusions retained.
- `docs/performance/*-evidence*.json` and `*-logs-*.json`: local operational receipts retained outside the upload set. The explanatory Markdown remains available.
- Date-bound incident executors, the incident SQL generator and the production capture comparison helper: locally retained and explicitly ignored. The capture comparison helper contained a machine-specific absolute path and is removed from the current Git index.
- The I/O investigation analyzer and plan generator depend on machine-local temporary snapshots or a fixed historical date range; they are also retained locally and excluded. Standalone read-only diagnostics and synthetic regression fixtures remain source candidates.
- Three historical calculation `.log` files: removed from the current Git index and retained locally under the existing `*.log` exclusion.
- Scheduler source fix, guarded repair SQL, rollback-only SQL regression, monitoring sources, synthetic fixtures/tests and explanatory incident Markdown remain suitable source material.

No credentials were printed during review. Credential-pattern candidates in the source scan were test database URL inputs and a private-key marker used by a negative test, rather than newly introduced live credentials. Environment files and business export directories are absent from the current Git index. This is a working-tree review, not a rewrite or exhaustive audit of historical Git objects.

Unrelated in-progress reconciliation and Google spreadsheet changes were preserved. Relevant API type checking and 67 collection/scheduler/reconciliation/deployment-guard tests passed after the merge. The current upload should retain their required `scripts/fixtures/reconciliation-date-baseline.ts` fixture if the related PostgreSQL regression is included.
