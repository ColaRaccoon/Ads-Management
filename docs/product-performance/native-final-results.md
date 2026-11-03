# Original platform final results

The unified report's `NATIVE_FINAL` mode reads immutable `NATIVE_RESULT` facts.
The report may add persisted amounts and calculate ratios or period changes; it
must not reconstruct profit from sales, ads, shipping, VAT, coupons or unit costs.
Legacy ledgers remain audit evidence and are available for rollback.

## Source ownership

- Storefront: the original sales product-margin calculator and its visible-product
  total rules. Its whole-store sales basis can overlap Google's original view.
- Google: the original unfiltered profit calculator, including its original coupon
  policy. Pagination is removed only for publication. Old unbound CSV inputs are
  not dropped by an added current-account filter.
- Coupang: the same shared function used by Daily Report. Revenue is reported
  sales; final and known profit retain its manual-purchase and incomplete-cost
  semantics. Adjusted net sales are audit fields, not replacement report revenue.
- Naver: persisted profit-v2 product rows and store summary. The source producer
  applies the native UI's final fake-purchase deduction once and stores that final
  summary separately from product profits. Shipping and store-level adjustments
  therefore do not have to equal the product profit subtotal.

One configured storefront owns the original full-shop snapshot, including its
authorized historical CSV inputs. Explicit ownership metadata supersedes the old
unbound audit scope on that date. Multiple configured shops are not guessed or
allocated. This rule never deduplicates or adjusts financial amounts.

## Persistence and publication

`NativeStoredResult` preserves decimal strings and independent SUMMARY/PRODUCT
results, quantity, completeness, source timestamp and provenance. The numeric
ledger columns use six decimals; the original JSON retains greater precision.
Validation checks group ownership, unique keys, exactly one summary per group and
known/complete consistency. Publication checks exact JSON copy conservation.
Existing immutable-run and atomic-pointer transaction protections remain active.

The private publisher uses `UNIFIED_NATIVE_RESULTS_WRITE_REQUIRED=true`. Missing
native summaries or source execution failures retain the preceding successful
publication. A successful native result is not vetoed by separate legacy audit
matcher or cost-rule warnings. The report's restricted role cannot read source
tables or invoke the source calculators.

## Refresh and performance

Use the private reconciliation service every five minutes with
`--lookback=1 --limit=24 --deadline-seconds=90`. The service has no HTTP listener.
Recent dates are prioritized; a durable last-checked cursor reserves work for
older dates, including unchanged and failed checks. Previously published dates
remain discoverable after source row deletion. Five-minute idempotency buckets
allow failed work to retry without an hour-long delay. Provider data collection
and native Naver calculation completion are prerequisites, not guaranteed by the
publication schedule. Reports display source and publication times.

Only the background publisher runs native calculators. A report GET reads one
authorized immutable snapshot. Excel/print activity uses that product's persisted
report-day quantity and ad spend, independently of legacy audit rows. Platform
export filters do not alter the daily summary.

## Deployment and rollback

1. Apply `20261103085000_native_final_results` and
   `20261103090000_unified_reconciliation_checks`, then the reviewed minimal
   source-column grants. `scripts/unified-native-finals-apply.ps1` pins the project,
   SQL hash, owner authority and preceding fact constraint; temporary membership
   is restored in the same transaction. No source business rows are written.
2. Deploy the private publisher with native summaries required; backfill original
   source results. Verify source/native/published parity before enabling reads.
3. Deploy the app with `UNIFIED_NATIVE_RESULTS_READ_ENABLED=true`.

For an application rollback, disable the reader flag and redeploy the previous
application source. Existing audit facts remain valid for that reader. To roll
back the publisher, restore its source, required flag and cron/start-command
configuration together. Retain the additive migrations and immutable historical
runs; dropping a component constraint after native facts exist is unsafe.

## Verification

`scripts/unified-native-finals-postgres.mjs` uses a fresh local PG17 instance and
the exact source grant SQL. It verifies limited worker reads, source/result
parity, high-precision JSON, immutable publication, rollback on invalid copies,
last-good retention and reader/scheduler privilege isolation. Unit tests cover
source summaries distinct from product sums, missing/partial/zero values,
historical source ownership, export activity and reconciliation fairness.

The production web bundle is checked with synthetic APIs by
`QA_NATIVE_RESULTS=true node scripts/daily-products-browser-check.mjs`.
The 134-product portrait fixture remains three detail pages; the summary is one
page. Source times are compacted only for printing; screen/Excel retain per-source
details. Live monetary parity evidence is kept under the ignored
`reports/daily-products-export` directory.

## Production verification — 2026-11-03

The reporting application is healthy at release
`ad7baa6456557a00c783a96e276e84af7bc56dae`; the publisher runs the identical
financial implementation from `624dcb0f7bf21429e9922fa4e812b947620522a1`.
The follow-up application commit only registers reviewed modules in the build
allowlist. Both native read/write flags are enabled. The protected live readiness
probe and report page returned HTTP 200 at 02:28 UTC.

All 674 discovered authorized date/account partitions through November 2 now
have native publications. The first pass published 639; the remaining 35 Naver
partitions had missing summaries or an old calculation version. The existing
local Naver recalculation API persisted those exact dates using its own profit
calculator. Original dashboard responses were equal before and after all 35
operations, and the resulting published summaries also matched. Only calculated
summary/product caches were refreshed; orders, costs, mappings and fake purchases
were not edited. The separate Naver repository's concurrent changes were left
untouched. The initial publication pointers and operation evidence are retained
locally in the ignored reports directory.

November 2 live reader parity (KRW, before display rounding):

| Original platform | Revenue | Advertising | Final profit |
| --- | ---: | ---: | ---: |
| Storefront | 12,158,060 | 5,864,437.692 | 1,316,616.308 |
| Google | 338,280 | 347,160.071585 | -146,408.071585 |
| Coupang | 10,212,090 | 1,721,561 | 2,351,382.602545 |
| Naver | 11,925,810 | 4,078,157 | 2,255,626 |

These are each original platform's basis, including the documented possible
storefront/Google overlap; the overall total does not introduce a new allocation.
The November 2 zero-activity sleep-mask product has no eligible export platforms.
The 02:29 UTC scheduled reconciliation finished 24 checks, all unchanged, with
zero failures, zero discovery failures and no exhausted deadline. Earlier
historical Naver check failures were resolved by the native cache repair.

## Explicit option links (2026-11-03)

`native:NAVER_OPTION` links the exact source option display name within its store
and effective dates. The stored-only reader projects a fixed allowlist of option
identity, date, quantity and source-completed revenue/ads/profit fields. It does
not read customer data or recompute prices, fees, VAT or costs.

Only explicitly linked options become separate product facts. Their stored
amounts are subtracted from the parent once; source SUMMARY facts remain intact.
Common advertising that the source retained on the parent stays there. For
example, 2026-11-02 full-metal gyro revenue 411,600 and net 243,033 move to
아이언볼 with zero option-specific ads; parent gyro retains revenue 489,700,
ads 193,102 and net 99,027. Combined revenue and profit remain 901,300 and 342,060.
The report labels this provenance with `PARENT_COMMON_AD_SPEND_RETAINED`.

`sourceOptions` holds source amounts and `optionBasis` retains the original parent
amounts. Reapplying, changing or disabling a link reconstructs that basis and
removes prior derived option rows, preventing repeated subtraction. Invalid child
revenue/quantity reconciliation or missing required option metrics prevents an
extraction. Unlinked options remain inside the parent and are independently
available in the product mapping inventory.

Approved corrections are recorded in
`approved/platform-product-corrections-20261103.json`. The maintenance runner
preserves original publications, clones audit ledgers unchanged, verifies exact
native summary/product-total conservation, and atomically switches each source/day
pointer under the existing partition and configuration locks. All writes are in
the private unified-reporting schema; original platform source data is unchanged.
