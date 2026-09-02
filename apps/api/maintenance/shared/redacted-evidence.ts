import { randomUUID } from "node:crypto";
import { canonicalJson } from "./strict-json";
import type { CloudTargetBinding } from "./target-binding";
import { targetBindingSha256 } from "./target-binding";

const FORBIDDEN_KEY = /(?:secret|password|token|cookie|authorization|email|subject|credential|databaseurl|privatekey|objectkey|filename)/i;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const JWT = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/;
const CREDENTIAL_URL = /[a-z][a-z0-9+.-]*:\/\/[^\s/:]+:[^\s/@]+@/i;

export type EvidenceResult = "PASS" | "BLOCKED" | "FAIL" | "NOT_RUN";

export interface RedactedEvidence {
  version: "cloud-redacted-evidence/v1";
  evidenceId: string;
  kind: string;
  generatedAt: string;
  environmentId: string;
  projectRef: string;
  releaseGitSha: string;
  targetSha256: string;
  result: EvidenceResult;
  counts: Record<string, number>;
  codes: string[];
}

export function createRedactedEvidence(input: {
  kind: string;
  generatedAt?: Date;
  target: CloudTargetBinding;
  result: EvidenceResult;
  counts?: Record<string, number>;
  codes?: string[];
  evidenceId?: string;
}): RedactedEvidence {
  const evidence: RedactedEvidence = {
    version: "cloud-redacted-evidence/v1",
    evidenceId: input.evidenceId ?? randomUUID(),
    kind: requireCode(input.kind, "EVIDENCE_KIND_INVALID"),
    generatedAt: (input.generatedAt ?? new Date()).toISOString(),
    environmentId: input.target.environmentId,
    projectRef: input.target.projectRef,
    releaseGitSha: input.target.releaseGitSha,
    targetSha256: targetBindingSha256(input.target),
    result: input.result,
    counts: normalizeCounts(input.counts ?? {}),
    codes: [...new Set((input.codes ?? []).map((code) => requireCode(code, "EVIDENCE_CODE_INVALID")))].sort()
  };
  assertNoSensitiveEvidence(evidence);
  return evidence;
}

export function serializeRedactedEvidence(evidence: RedactedEvidence): string {
  assertNoSensitiveEvidence(evidence);
  return `${canonicalJson(evidence)}\n`;
}

export function assertNoSensitiveEvidence(value: unknown, path = "$"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSensitiveEvidence(entry, `${path}[${index}]`));
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEY.test(key)) throw new Error(`EVIDENCE_FORBIDDEN_KEY:${path}.${key}`);
      assertNoSensitiveEvidence(entry, `${path}.${key}`);
    }
    return;
  }
  if (typeof value === "string" && (EMAIL.test(value) || JWT.test(value) || CREDENTIAL_URL.test(value))) {
    throw new Error(`EVIDENCE_SENSITIVE_VALUE:${path}`);
  }
}

function normalizeCounts(counts: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => {
    const normalizedKey = requireCode(key, "EVIDENCE_COUNT_KEY_INVALID");
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("EVIDENCE_COUNT_INVALID");
    return [normalizedKey, value];
  }));
}

function requireCode(value: string, errorCode: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(value)) throw new Error(errorCode);
  return value;
}
