import { HttpException } from "@nestjs/common";
import { ProviderFailure } from "./bounded-request";

/** Fixed, nonidentifying reason codes for a failed Cafe24 day. Never use provider values here. */
export const CAFE24_FAILURE_DIAGNOSTIC_CODES = [
  "CAFE24_RESPONSE_HTTP_400",
  "CAFE24_RESPONSE_HTTP_404",
  "CAFE24_RESPONSE_HTTP_422",
  "CAFE24_RESPONSE_INVALID_JSON",
  "CAFE24_EVIDENCE_APP_VERSION",
  "CAFE24_EVIDENCE_SELLER_OPTIONS",
  "CAFE24_EVIDENCE_RAW_ALL_ITEMS",
  "CAFE24_EVIDENCE_STATUS_SET",
  "CAFE24_EVIDENCE_PAYMENT_MAP",
  "CAFE24_STATUS_APPROVAL_MISMATCH",
  "CAFE24_PROVIDER_TIME_FUTURE",
  "CAFE24_FIELD_ORDER_SHAPE",
  "CAFE24_FIELD_ORDER_ID",
  "CAFE24_FIELD_ORDER_DATE",
  "CAFE24_FIELD_UPDATED_DATE",
  "CAFE24_FIELD_ORDER_STATUS",
  "CAFE24_FIELD_TOP_ORDER_PRICE",
  "CAFE24_FIELD_PAYMENT_AMOUNT",
  "CAFE24_FIELD_ACTUAL_AMOUNT",
  "CAFE24_FIELD_INITIAL_AMOUNT",
  "CAFE24_FIELD_PAYMENT_METHOD",
  "CAFE24_FIELD_ITEM_SHAPE",
  "CAFE24_FIELD_ITEM_ID",
  "CAFE24_FIELD_PRODUCT_NO",
  "CAFE24_FIELD_PRODUCT_NAME",
  "CAFE24_FIELD_OPTION_VALUE",
  "CAFE24_FIELD_OPTION_COMPOSITION",
  "CAFE24_FIELD_QUANTITY",
  "CAFE24_FIELD_PRODUCT_PRICE",
  "CAFE24_FIELD_ITEM_STATUS",
  "CAFE24_FIELD_PROJECTION"
] as const;

export type Cafe24FailureDiagnosticCode = typeof CAFE24_FAILURE_DIAGNOSTIC_CODES[number];

export function isCafe24FailureDiagnosticCode(value: unknown): value is Cafe24FailureDiagnosticCode {
  return typeof value === "string" &&
    (CAFE24_FAILURE_DIAGNOSTIC_CODES as readonly string[]).includes(value);
}

export function withCafe24Diagnostic<T>(code: Cafe24FailureDiagnosticCode, read: () => T): T {
  try { return read(); }
  catch (error) {
    // Preserve the original safe code and error class; attach only a fixed
    // identifier to the in-process failure, never the provider value.
    const response = error instanceof HttpException ? error.getResponse() : null;
    const safeCode = error instanceof ProviderFailure ? error.safeCode :
      response && typeof response === "object" && "code" in response ? response.code : null;
    if ((safeCode === "FIELD_UNSUPPORTED" ||
         (code === "CAFE24_EVIDENCE_APP_VERSION" && safeCode === "PROVIDER_VERSION_UNVERIFIED")) &&
        error && typeof error === "object" &&
        !('diagnosticCode' in error && typeof error.diagnosticCode === "string"))
      Object.assign(error, { diagnosticCode: code });
    throw error;
  }
}

