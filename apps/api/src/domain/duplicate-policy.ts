export type ConflictPolicyValue = "SKIP" | "OVERWRITE" | "NEW_VERSION";

export type DuplicateDecision = {
  importMetric: boolean;
  supersedeExisting: boolean;
  note: string;
};

export class DuplicatePolicyResolver {
  resolve(policy: ConflictPolicyValue, hasCurrentMetric: boolean): DuplicateDecision {
    if (!hasCurrentMetric) {
      return {
        importMetric: true,
        supersedeExisting: false,
        note: "No duplicate current metric found."
      };
    }

    if (policy === "SKIP") {
      return {
        importMetric: false,
        supersedeExisting: false,
        note: "Existing current metric kept by SKIP policy."
      };
    }

    return {
      importMetric: true,
      supersedeExisting: true,
      note:
        policy === "NEW_VERSION"
          ? "NEW_VERSION stores the new row as current and preserves the previous current row."
          : "OVERWRITE stores the new row as current and supersedes the previous current row."
    };
  }
}
