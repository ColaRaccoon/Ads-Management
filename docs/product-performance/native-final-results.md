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
