import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runReconciliation } from "../apps/api/src/unified-performance/reconciliation-entrypoint";

// Run only via the protected Stage 11 wrapper. Persist counts, never source rows or errors.
const started = Date.now();
runReconciliation(process.argv.slice(2)).then(result => {
  writeFileSync(join(tmpdir(), "unified-reconcile-current-result.json"), JSON.stringify({
    observedAt: new Date().toISOString(), elapsedMs: Date.now() - started, ...result,
  }, null, 2) + "\n");
  if (result.failed || result.discoveryFailures.length) process.exitCode = 1;
}).catch(() => {
  writeFileSync(join(tmpdir(), "unified-reconcile-current-result.json"), JSON.stringify({
    status: "FAILED", elapsedMs: Date.now() - started,
  }) + "\n");
  process.exitCode = 1;
});
