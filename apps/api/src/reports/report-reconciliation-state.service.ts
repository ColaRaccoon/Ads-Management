import { Injectable } from "@nestjs/common";

export type ReportReconciliationResult = {
  scanned: number;
  created: number;
  failed: number;
  unresolved: number;
};

@Injectable()
export class ReportReconciliationStateService {
  private attempted = false;
  private unresolved = 1;
  private lastCompletedAt: Date | null = null;

  record(result: ReportReconciliationResult) {
    this.attempted = true;
    this.unresolved = result.unresolved;
    this.lastCompletedAt = new Date();
  }

  recordFailure() {
    this.attempted = true;
    this.unresolved = Math.max(1, this.unresolved);
    this.lastCompletedAt = new Date();
  }

  assertReady() {
    if (!this.attempted || this.unresolved !== 0) {
      throw new Error("REPORT_RECONCILIATION_PENDING");
    }
  }

  snapshot() {
    return Object.freeze({
      attempted: this.attempted,
      unresolved: this.unresolved,
      lastCompletedAt: this.lastCompletedAt
    });
  }
}
