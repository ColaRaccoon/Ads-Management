const FORBIDDEN_KEY = /(?:token|cookie|authorization|password|secret|credential|email|subject|filename|objectkey|raw|body)/i;
const JWT = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const CREDENTIAL_URL = /[a-z][a-z0-9+.-]*:\/\/[^\s/:]+:[^\s/@]+@/i;

export function assertRedactedEvidence(value: unknown, path = "$"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertRedactedEvidence(entry, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEY.test(key)) throw new Error(`E2E_EVIDENCE_FORBIDDEN_KEY:${path}.${key}`);
      assertRedactedEvidence(entry, `${path}.${key}`);
    }
    return;
  }
  if (typeof value === "string" && (JWT.test(value) || EMAIL.test(value) || CREDENTIAL_URL.test(value))) {
    throw new Error(`E2E_EVIDENCE_SENSITIVE_VALUE:${path}`);
  }
}

export function publicFailureCode(error: unknown) {
  return error instanceof Error && /^[A-Z0-9_]{3,128}$/.test(error.message) ? error.message : "E2E_SCENARIO_FAILED";
}
