import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import { assertRedactedEvidence } from "./redaction";
import { E2eTargetContract, readProtectedJson, readProtectedText } from "./target-contract";

export type ScenarioResult = "PASS" | "FAIL" | "BLOCKED" | "NOT_RUN";
export type ScenarioEvidence = {
  version: "e2e-evidence/v1";
  evidenceId: string;
  scenario: string;
  environmentId: string;
  projectRef: string;
  releaseGitSha: string;
  imageDigest: string;
  result: ScenarioResult;
  assertionCount: number;
  counts: Record<string, number>;
  digests: Record<string, string>;
  codes: string[];
};

export type ApprovedE2eReceipt<T = unknown> = {
  version: "e2e-approved-receipt/v1";
  kind: string;
  targetContractSha256: string;
  environmentId: string;
  projectRef: string;
  releaseGitSha: string;
  imageDigest: string;
  producerArtifactDigestSha256: string;
  payload: T;
  signature: string;
};

export type E2eReceiptSigningRequest<T = unknown> = {
  version: "e2e-receipt-signing-request/v1";
  unsigned: Omit<ApprovedE2eReceipt<T>, "signature">;
  signingPayloadSha256: string;
};

export function createE2eReceiptSigningRequest<T>(input: {
  target: E2eTargetContract;
  kind: string;
  producerArtifactDigestSha256: string;
  payload: T;
}): E2eReceiptSigningRequest<T> {
  if (!/^[a-z][a-z0-9.-]{2,127}$/.test(input.kind) ||
      input.producerArtifactDigestSha256 !== input.target.receiptTrust.producerArtifactDigestSha256) {
    throw new Error("E2E_RECEIPT_PRODUCER_BINDING_MISMATCH");
  }
  assertRedactedEvidence(input.payload);
  const unsigned: Omit<ApprovedE2eReceipt<T>, "signature"> = {
    version: "e2e-approved-receipt/v1",
    kind: input.kind,
    targetContractSha256: canonicalDigest(input.target),
    environmentId: input.target.environmentId,
    projectRef: input.target.projectRef,
    releaseGitSha: input.target.releaseGitSha,
    imageDigest: input.target.imageDigest,
    producerArtifactDigestSha256: input.producerArtifactDigestSha256,
    payload: input.payload
  };
  return {
    version: "e2e-receipt-signing-request/v1",
    unsigned,
    signingPayloadSha256: canonicalDigest(unsigned)
  };
}

export function assembleApprovedE2eReceipt<T>(input: {
  request: E2eReceiptSigningRequest<T>;
  signature: string;
  target: E2eTargetContract;
  independentlyApprovedReceiptSha256: string;
  publicKeyFile: string;
}): ApprovedE2eReceipt<T> {
  if (input.request.version !== "e2e-receipt-signing-request/v1" ||
      input.request.signingPayloadSha256 !== canonicalDigest(input.request.unsigned)) {
    throw new Error("E2E_RECEIPT_SIGNING_REQUEST_INVALID");
  }
  const receipt = { ...input.request.unsigned, signature: input.signature };
  return verifyApprovedE2eReceipt<T>({
    value: receipt,
    target: input.target,
    kind: input.request.unsigned.kind,
    approvedReceiptSha256: input.independentlyApprovedReceiptSha256,
    publicKeyFile: input.publicKeyFile
  });
}

export function verifyApprovedE2eReceipt<T>(input: {
  value: unknown;
  target: E2eTargetContract;
  kind: string;
  approvedReceiptSha256: string;
  publicKeyFile: string;
}): ApprovedE2eReceipt<T> {
  const receipt = strictRecord(input.value, "E2E_RECEIPT_OBJECT_REQUIRED");
  exactKeys(receipt, [
    "version", "kind", "targetContractSha256", "environmentId", "projectRef", "releaseGitSha", "imageDigest",
    "producerArtifactDigestSha256", "payload", "signature"
  ], "E2E_RECEIPT_KEYS_INVALID");
  if (receipt.version !== "e2e-approved-receipt/v1" || receipt.kind !== input.kind ||
      receipt.targetContractSha256 !== canonicalDigest(input.target) ||
      receipt.environmentId !== input.target.environmentId || receipt.projectRef !== input.target.projectRef ||
      receipt.releaseGitSha !== input.target.releaseGitSha || receipt.imageDigest !== input.target.imageDigest ||
      receipt.producerArtifactDigestSha256 !== input.target.receiptTrust.producerArtifactDigestSha256) {
    throw new Error("E2E_RECEIPT_BINDING_MISMATCH");
  }
  assertDigest(input.approvedReceiptSha256, "E2E_RECEIPT_APPROVAL_DIGEST_INVALID");
  if (canonicalDigest(receipt) !== input.approvedReceiptSha256) throw new Error("E2E_RECEIPT_APPROVAL_MISMATCH");
  if (typeof receipt.signature !== "string" || !/^[A-Za-z0-9_-]{40,2048}$/.test(receipt.signature)) {
    throw new Error("E2E_RECEIPT_SIGNATURE_INVALID");
  }
  const publicKeyPem = readProtectedText(input.publicKeyFile, 32 * 1024).trim();
  if (/PRIVATE KEY/.test(publicKeyPem)) throw new Error("E2E_RECEIPT_PUBLIC_KEY_TYPE_INVALID");
  const publicKey = createPublicKey(publicKeyPem);
  if (!publicKey.asymmetricKeyType || !["ec", "rsa", "rsa-pss"].includes(publicKey.asymmetricKeyType)) {
    throw new Error("E2E_RECEIPT_PUBLIC_KEY_TYPE_INVALID");
  }
  const keyDigest = createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex");
  if (keyDigest !== input.target.receiptTrust.publicKeySha256) throw new Error("E2E_RECEIPT_PUBLIC_KEY_MISMATCH");
  const { signature, ...unsigned } = receipt;
  if (!verify("sha256", Buffer.from(canonicalJson(unsigned)), publicKey, Buffer.from(signature as string, "base64url"))) {
    throw new Error("E2E_RECEIPT_SIGNATURE_INVALID");
  }
  return receipt as ApprovedE2eReceipt<T>;
}

export function createScenarioEvidence(input: {
  target: E2eTargetContract;
  scenario: string;
  result: ScenarioResult;
  assertionCount: number;
  counts?: Record<string, number>;
  digests?: Record<string, string>;
  codes?: string[];
}): ScenarioEvidence {
  if (!/^[a-z][a-z0-9.-]{2,127}$/.test(input.scenario)) throw new Error("E2E_EVIDENCE_SCENARIO_INVALID");
  if (!Number.isSafeInteger(input.assertionCount) || input.assertionCount < 0 ||
      (input.result === "PASS" && input.assertionCount < 1)) throw new Error("E2E_EVIDENCE_ASSERTIONS_INVALID");
  const counts = normalizeCounts(input.counts ?? {});
  const digests = Object.fromEntries(Object.entries(input.digests ?? {}).sort().map(([key, value]) => {
    if (!/^[a-z][a-z0-9_]{1,63}$/.test(key) || !/^[0-9a-f]{64}$/.test(value)) throw new Error("E2E_EVIDENCE_DIGEST_INVALID");
    return [key, value];
  }));
  const evidence: ScenarioEvidence = {
    version: "e2e-evidence/v1",
    evidenceId: randomUUID(),
    scenario: input.scenario,
    environmentId: input.target.environmentId,
    projectRef: input.target.projectRef,
    releaseGitSha: input.target.releaseGitSha,
    imageDigest: input.target.imageDigest,
    result: input.result,
    assertionCount: input.assertionCount,
    counts,
    digests,
    codes: [...new Set(input.codes ?? [])].sort()
  };
  assertRedactedEvidence(evidence);
  return evidence;
}

export type CleanupEntry = {
  kind: "UPLOAD_BATCH" | "CAFE24_BATCH" | "COUPANG_BATCH" | "REPORT_EXPORT" | "TOMBSTONE" | "AUTH_IDENTITY";
  opaqueId: string;
  cleanupOwner: "APP_API" | "SUPABASE_MAINTENANCE";
};

export type CleanupManifest = {
  version: "e2e-cleanup/v1";
  runId: string;
  environmentId: string;
  projectRef: string;
  releaseGitSha: string;
  entries: CleanupEntry[];
};

export function appendCleanupEntry(file: string, base: Omit<CleanupManifest, "entries">, entry: CleanupEntry) {
  validateCleanupEntry(entry);
  let manifest: CleanupManifest = { ...base, entries: [] };
  try {
    manifest = parseCleanupManifest(readProtectedJson(file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  assertCleanupBinding(manifest, base);
  if (!manifest.entries.some((candidate) => candidate.kind === entry.kind && candidate.opaqueId === entry.opaqueId)) {
    manifest.entries.push(entry);
    manifest.entries.sort((left, right) => `${left.kind}|${left.opaqueId}`.localeCompare(`${right.kind}|${right.opaqueId}`));
  }
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${canonicalJson(manifest)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  renameSync(temporary, file);
  return manifest;
}

export function loadCleanupManifest(file: string): CleanupManifest {
  return parseCleanupManifest(readProtectedJson(file));
}

export function cleanupManifestDigest(manifest: CleanupManifest) {
  return createHash("sha256").update(canonicalJson(manifest)).digest("hex");
}

export function canonicalDigest(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function validateCleanupEntry(entry: CleanupEntry) {
  exactKeys(entry as unknown as Record<string, unknown>, ["kind", "opaqueId", "cleanupOwner"], "E2E_CLEANUP_ENTRY_KEYS_INVALID");
  if (!["UPLOAD_BATCH", "CAFE24_BATCH", "COUPANG_BATCH", "REPORT_EXPORT", "TOMBSTONE", "AUTH_IDENTITY"].includes(entry.kind) ||
      (entry.cleanupOwner !== "APP_API" && entry.cleanupOwner !== "SUPABASE_MAINTENANCE")) {
    throw new Error("E2E_CLEANUP_ENTRY_INVALID");
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(entry.opaqueId)) {
    throw new Error("E2E_CLEANUP_ID_INVALID");
  }
}

function parseCleanupManifest(value: unknown): CleanupManifest {
  const input = strictRecord(value, "E2E_CLEANUP_OBJECT_REQUIRED");
  exactKeys(input, ["version", "runId", "environmentId", "projectRef", "releaseGitSha", "entries"], "E2E_CLEANUP_KEYS_INVALID");
  if (input.version !== "e2e-cleanup/v1" || typeof input.runId !== "string" || typeof input.environmentId !== "string" ||
      typeof input.projectRef !== "string" || typeof input.releaseGitSha !== "string" || !Array.isArray(input.entries)) {
    throw new Error("E2E_CLEANUP_MANIFEST_INVALID");
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.runId) ||
      !/^[a-z][a-z0-9-]{2,62}$/.test(input.environmentId) || !/^[a-z]{20}$/.test(input.projectRef) ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(input.releaseGitSha) || input.entries.length > 10_000) {
    throw new Error("E2E_CLEANUP_MANIFEST_INVALID");
  }
  const parsed = input as unknown as CleanupManifest;
  parsed.entries.forEach(validateCleanupEntry);
  if (new Set(parsed.entries.map((entry) => `${entry.kind}|${entry.opaqueId}`)).size !== parsed.entries.length) {
    throw new Error("E2E_CLEANUP_ENTRY_DUPLICATE");
  }
  return parsed;
}

function assertCleanupBinding(actual: CleanupManifest, expected: Omit<CleanupManifest, "entries">) {
  for (const key of ["version", "runId", "environmentId", "projectRef", "releaseGitSha"] as const) {
    if (actual[key] !== expected[key]) throw new Error("E2E_CLEANUP_BINDING_MISMATCH");
  }
  if (!Array.isArray(actual.entries)) throw new Error("E2E_CLEANUP_ENTRIES_INVALID");
  actual.entries.forEach(validateCleanupEntry);
}

function normalizeCounts(counts: Record<string, number>) {
  return Object.fromEntries(Object.entries(counts).sort().map(([key, value]) => {
    if (!/^[a-z][a-z0-9_]{1,63}$/.test(key) || !Number.isSafeInteger(value) || value < 0) {
      throw new Error("E2E_EVIDENCE_COUNT_INVALID");
    }
    return [key, value];
  }));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function strictRecord(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: string[], code: string) {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) throw new Error(code);
}

function assertDigest(value: string, code: string) {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(code);
}
