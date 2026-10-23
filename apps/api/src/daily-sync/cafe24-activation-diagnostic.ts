import { ConflictException } from "@nestjs/common";

// A single fixed guard identifies the failed phase without disclosing an order,
// product, amount, comparison count, or protected snapshot digest.
export const CAFE24_ACTIVATION_GUARDS = [
  "CAFE24_ACTIVATION_SNAPSHOT_CHANGED",
  "CAFE24_ACTIVATION_POLICY_STATE",
  "CAFE24_ACTIVATION_COVERAGE_STATE",
  "CAFE24_ACTIVATION_RUN_STATE",
  "CAFE24_ACTIVATION_UNDATED_CSV_UNREVIEWED",
  "CAFE24_ACTIVATION_ROW_CARDINALITY",
  "CAFE24_ACTIVATION_API_MAPPING_STATE",
  "CAFE24_ACTIVATION_CSV_MAPPING_STATE",
  "CAFE24_ACTIVATION_CSV_RAW_INPUT",
  "CAFE24_ACTIVATION_CSV_PRODUCT_NAME",
  "CAFE24_ACTIVATION_CSV_QUANTITY",
  "CAFE24_ACTIVATION_CSV_SALE_PRICE",
  "CAFE24_ACTIVATION_CSV_LINK",
  "CAFE24_ACTIVATION_API_VERSION_LINK",
  "CAFE24_ACTIVATION_INPUT_DIFFERENCE_REVIEW"
] as const;

export type Cafe24ActivationGuard = typeof CAFE24_ACTIVATION_GUARDS[number];

export class Cafe24ActivationRejected extends ConflictException {
  constructor(readonly activationGuardCode: Cafe24ActivationGuard) {
    super({ code: "SOURCE_SELECTION_REQUIRED" });
  }
}

export function rejectCafe24Activation(activationGuardCode: Cafe24ActivationGuard): never {
  throw new Cafe24ActivationRejected(activationGuardCode);
}
