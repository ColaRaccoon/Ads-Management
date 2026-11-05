# Meta daily spend tolerance — 2026-11-05

Approved by the user: allow up to and including USD 10 of daily spend discrepancy, retaining source values and an explicit warning. Counts, identity, complete pagination, raw zero exclusion and purchase evidence stay strict.

## Policy

`DAILY_HIERARCHY_L1_USD_10` computes the sum of absolute parent-minus-child spend differences for each boundary: ads/adsets, adsets/campaigns and ads/campaigns. It also checks each level against the account total. Every boundary must be <= 10.0000 USD. Taking the maximum avoids charging the same discrepancy multiple times as it propagates through the hierarchy. Opposite signs cannot cancel; individual entities do not each receive a USD 10 allowance. This is a fixed USD policy for the existing MCP daily scope.

Exact days retain their existing normalized JSON and source revisions. For nonzero tolerated differences, every published row carries the same `sourceContext.spendReconciliation`, including the day, original level totals, absolute boundary differences, maximum and the explicit no-allocation flag. No balancing entry, spend rewrite or null filling is introduced. Empty-day publication still requires zero observed spend.

The canonical writer recalculates ad/adset absolute differences and totals, verifies identical day evidence on all rows, and passes it to the existing atomic publication transaction. Both coverage slices receive `META_SPEND_DIFFERENCE_WITHIN_10_USD`; each slice keeps its own exact total. `SYNC_UNIT_PUBLISHED` persists the numeric evidence in the same transaction. The runner also emits it on success. Existing bounded retry and final failure history are retained for differences above the limit and other retryable reconciliation failures.

Product margin continues to use source adset spend; ad spend is retained independently. An accepted discrepancy can therefore produce a bounded difference between reports at different granularities. It is visible in the persisted evidence rather than concealed by allocation.

## Verification

- Boundary tests: 0, +/-0.06, +/-10 accepted; +/-10.0001 rejected.
- Multiple same-sign and cancelling entity differences with L1 USD 12 rejected.
- Counts, purchase counts, missing parent, pagination and strict zero-discard tests remain rejecting.
- Actual canonical writer and foundation publication tested for evidence validation, independent totals, coverage warnings and transactional audit persistence.
- Relevant regression and deployment-guard tests: 49 passing. API lint/build and web webpack build pass.
- One fresh successful production capture on November 4 scope: 938 raw ads, 314 raw adsets, 9 complete pages; selected 598 ads/200 adsets. Exact successful normalized business JSON identical to the previous implementation. Read-only; no historical business data rewritten.

## Monitoring

`scripts/check-daily-collection.ps1` continues to require actual scheduled `SUCCEEDED` results and exact own-level coverage/canonical amounts. Only the above warning is accepted, with the publication evidence, independently recomputed ad/adset L1, original totals, day and all six <= USD 10 boundaries checked. Other warnings remain attention items. Past manual recovery does not become scheduled success: the November 4 Meta scheduled run remains `ACTION_REQUIRED` in preserved history.

The monitor in the main workspace uses the existing protected production query helper. No Supabase relogin or new authentication mechanism is required.

## Production deployment verified

- Release: `6c66dbf4b35e55928e6a358dcc4cf9597f36f30b`.
- Railway deployment: `f7a609c7-2000-4a7c-aee0-9313a2f0a4b6`, `SUCCESS`.
- Protected readiness probe at 2026-11-05 09:38 KST returned `ready` with that exact release. Cafe24/Meta daily schedule flags and definitions remain enabled.
- Monitoring automation 24 remains active at 04:10 KST and references the approved tolerance and persisted evidence checks.
- Monitor regression with synthetic receipts accepted USD 6 and rejected accumulated USD 12. Actual read-only production health check still reports the preserved November 4 Meta scheduled failure, with both stored Meta totals exactly USD 3,938.27.
- No historical canonical data rewritten; the next scheduled execution is the first real scheduled test of this release.
