import { createLocalJWKSet, JSONWebKeySet, jwtVerify } from "jose";
import { canonicalJson, canonicalSha256, sha256Hex } from "../shared/strict-json";
import { CloudTargetBinding, targetBindingSha256 } from "../shared/target-binding";

export const STORAGE_TOKEN_ARTIFACT_VERSION = 1;
const DAY_SECONDS = 86_400;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type StorageTokenExpectation = {
  issuer: string;
  audience: string;
  subject: string;
  role: "storage_app";
  minRemainingSeconds?: number;
  maxLifetimeSeconds?: number;
  clockToleranceSeconds?: number;
};

export type StorageTokenApprovalBundle = {
  version: "storage-token-approval/v1";
  targetSha256: string;
  projectRef: string;
  officialJwksUrl: string;
  officialJwksSha256: string;
  approvedKid: string;
  tokenSha256: string;
  expectation: Required<StorageTokenExpectation>;
  issuedAt: string;
  expiresAt: string;
};

export type VerifiedStorageTokenArtifact = {
  artifactVersion: typeof STORAGE_TOKEN_ARTIFACT_VERSION;
  algorithm: "ES256" | "RS256";
  kid: string;
  issuer: string;
  audience: string;
  subject: string;
  role: "storage_app";
  issuedAt: number;
  expiresAt: number;
  remainingSeconds: number;
  lifetimeSeconds: number;
  alertDueAt: number;
  claimsDigestSha256: string;
};

export async function verifySuppliedStorageToken(input: {
  token: string;
  jwks: JSONWebKeySet;
  expected: StorageTokenExpectation;
  nowEpochSeconds?: number;
}): Promise<VerifiedStorageTokenArtifact> {
  const expectationKeys = Object.keys(input.expected);
  const allowedExpectationKeys = new Set([
    "issuer", "audience", "subject", "role", "minRemainingSeconds", "maxLifetimeSeconds", "clockToleranceSeconds"
  ]);
  if (expectationKeys.some((key) => !allowedExpectationKeys.has(key))) throw new Error("STORAGE_TOKEN_EXPECTATION_FIELDS_INVALID");
  if (!input.token || input.token.length > 16_384) throw new Error("STORAGE_TOKEN_VALUE_INVALID");
  if (!input.jwks || !Array.isArray(input.jwks.keys) || input.jwks.keys.length < 1 || input.jwks.keys.length > 20) {
    throw new Error("STORAGE_TOKEN_JWKS_INVALID");
  }
  for (const key of input.jwks.keys) {
    if (!key || typeof key !== "object" || "d" in key || "k" in key ||
        (key.use !== undefined && key.use !== "sig") || (key.alg !== undefined && key.alg !== "ES256" && key.alg !== "RS256")) {
      throw new Error("STORAGE_TOKEN_PUBLIC_JWKS_REQUIRED");
    }
  }
  const now = input.nowEpochSeconds ?? Math.floor(Date.now() / 1_000);
  const minRemaining = input.expected.minRemainingSeconds ?? DAY_SECONDS;
  const maxLifetime = input.expected.maxLifetimeSeconds ?? 7 * DAY_SECONDS;
  const tolerance = input.expected.clockToleranceSeconds ?? 30;
  if (!Number.isSafeInteger(now) || minRemaining < DAY_SECONDS || maxLifetime > 7 * DAY_SECONDS || maxLifetime < minRemaining) {
    throw new Error("STORAGE_TOKEN_TTL_CONTRACT_INVALID");
  }
  if (!UUID.test(input.expected.subject) || input.expected.role !== "storage_app") {
    throw new Error("STORAGE_TOKEN_EXPECTATION_INVALID");
  }
  const { payload, protectedHeader } = await jwtVerify(input.token, createLocalJWKSet(input.jwks), {
    algorithms: ["ES256", "RS256"],
    issuer: input.expected.issuer,
    audience: input.expected.audience,
    requiredClaims: ["iat", "exp", "sub", "role"],
    clockTolerance: tolerance,
    currentDate: new Date(now * 1_000)
  });
  if (protectedHeader.typ && protectedHeader.typ !== "JWT") throw new Error("STORAGE_TOKEN_TYPE_INVALID");
  if (!protectedHeader.kid || protectedHeader.kid.length > 128) throw new Error("STORAGE_TOKEN_KID_INVALID");
  if (protectedHeader.alg !== "ES256" && protectedHeader.alg !== "RS256") throw new Error("STORAGE_TOKEN_ALGORITHM_INVALID");
  if (payload.sub !== input.expected.subject || payload.role !== "storage_app") throw new Error("STORAGE_TOKEN_CLAIMS_INVALID");
  if (!Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp)) throw new Error("STORAGE_TOKEN_TIME_CLAIMS_INVALID");
  const issuedAt = payload.iat!;
  const expiresAt = payload.exp!;
  const lifetimeSeconds = expiresAt - issuedAt;
  const remainingSeconds = expiresAt - now;
  if (issuedAt > now + tolerance || lifetimeSeconds < minRemaining || lifetimeSeconds > maxLifetime || remainingSeconds < minRemaining) {
    throw new Error("STORAGE_TOKEN_TTL_INVALID");
  }
  const audience = Array.isArray(payload.aud) ? [...payload.aud].sort().join(" ") : payload.aud!;
  const claims = {
    algorithm: protectedHeader.alg,
    kid: protectedHeader.kid,
    issuer: payload.iss!,
    audience,
    subject: payload.sub,
    role: payload.role,
    issuedAt,
    expiresAt
  };
  return {
    artifactVersion: STORAGE_TOKEN_ARTIFACT_VERSION,
    ...claims,
    algorithm: protectedHeader.alg,
    role: "storage_app",
    remainingSeconds,
    lifetimeSeconds,
    alertDueAt: expiresAt - DAY_SECONDS,
    claimsDigestSha256: sha256Hex(canonicalJson(claims))
  };
}

export async function verifyApprovedStorageTokenBundle(input: {
  token: string;
  jwks: JSONWebKeySet;
  target: CloudTargetBinding;
  bundle: unknown;
  confirmBundleSha256: string;
  nowEpochSeconds?: number;
}) {
  const now = input.nowEpochSeconds ?? Math.floor(Date.now() / 1_000);
  const bundle = parseStorageTokenApprovalBundle(input.bundle, input.target, now);
  assertDigest(input.confirmBundleSha256);
  const bundleSha256 = canonicalSha256(bundle);
  if (bundleSha256 !== input.confirmBundleSha256) throw new Error("STORAGE_TOKEN_BUNDLE_CONFIRMATION_MISMATCH");
  if (sha256Hex(input.token) !== bundle.tokenSha256) throw new Error("STORAGE_TOKEN_VALUE_DIGEST_MISMATCH");
  if (canonicalSha256(input.jwks) !== bundle.officialJwksSha256) throw new Error("STORAGE_TOKEN_OFFICIAL_JWKS_DIGEST_MISMATCH");
  const artifact = await verifySuppliedStorageToken({
    token: input.token, jwks: input.jwks, expected: bundle.expectation, nowEpochSeconds: now
  });
  if (artifact.kid !== bundle.approvedKid) throw new Error("STORAGE_TOKEN_APPROVED_KID_MISMATCH");
  return { artifact, bundle, bundleSha256 };
}

export function parseStorageTokenApprovalBundle(
  value: unknown,
  target: CloudTargetBinding,
  nowEpochSeconds = Math.floor(Date.now() / 1_000)
): StorageTokenApprovalBundle {
  const input = object(value, "STORAGE_TOKEN_BUNDLE_OBJECT_REQUIRED");
  exactKeys(input, [
    "version", "targetSha256", "projectRef", "officialJwksUrl", "officialJwksSha256", "approvedKid",
    "tokenSha256", "expectation", "issuedAt", "expiresAt"
  ], "STORAGE_TOKEN_BUNDLE_KEYS_INVALID");
  if (input.version !== "storage-token-approval/v1" || input.targetSha256 !== targetBindingSha256(target) ||
      input.projectRef !== target.projectRef || input.officialJwksUrl !== `${target.supabaseOrigin}/auth/v1/.well-known/jwks.json`) {
    throw new Error("STORAGE_TOKEN_BUNDLE_TARGET_MISMATCH");
  }
  const expectation = object(input.expectation, "STORAGE_TOKEN_EXPECTATION_INVALID");
  exactKeys(expectation, [
    "issuer", "audience", "subject", "role", "minRemainingSeconds", "maxLifetimeSeconds", "clockToleranceSeconds"
  ], "STORAGE_TOKEN_EXPECTATION_FIELDS_INVALID");
  if (expectation.issuer !== `${target.supabaseOrigin}/auth/v1`) throw new Error("STORAGE_TOKEN_ISSUER_TARGET_MISMATCH");
  const issuedAt = iso(input.issuedAt, "STORAGE_TOKEN_BUNDLE_ISSUED_AT_INVALID");
  const expiresAt = iso(input.expiresAt, "STORAGE_TOKEN_BUNDLE_EXPIRES_AT_INVALID");
  if (Date.parse(issuedAt) > nowEpochSeconds * 1_000 + 5 * 60_000 || Date.parse(expiresAt) <= nowEpochSeconds * 1_000 ||
      Date.parse(expiresAt) <= Date.parse(issuedAt) || Date.parse(expiresAt) - Date.parse(issuedAt) > DAY_SECONDS * 1_000) {
    throw new Error("STORAGE_TOKEN_BUNDLE_LIFETIME_INVALID");
  }
  const officialJwksSha256 = string(input.officialJwksSha256, /^[0-9a-f]{64}$/, "STORAGE_TOKEN_OFFICIAL_JWKS_DIGEST_INVALID", 64);
  const tokenSha256 = string(input.tokenSha256, /^[0-9a-f]{64}$/, "STORAGE_TOKEN_VALUE_DIGEST_INVALID", 64);
  const approvedKid = string(input.approvedKid, /^[A-Za-z0-9._-]{1,128}$/, "STORAGE_TOKEN_APPROVED_KID_INVALID", 128);
  return {
    version: "storage-token-approval/v1",
    targetSha256: input.targetSha256 as string,
    projectRef: target.projectRef,
    officialJwksUrl: input.officialJwksUrl as string,
    officialJwksSha256,
    approvedKid,
    tokenSha256,
    expectation: {
      issuer: expectation.issuer as string,
      audience: string(expectation.audience, /^[A-Za-z0-9:_-]{1,128}$/, "STORAGE_TOKEN_AUDIENCE_INVALID", 128),
      subject: string(expectation.subject, UUID, "STORAGE_TOKEN_SUBJECT_INVALID", 36),
      role: expectation.role === "storage_app" ? "storage_app" : fail("STORAGE_TOKEN_ROLE_INVALID"),
      minRemainingSeconds: integer(expectation.minRemainingSeconds, DAY_SECONDS, 7 * DAY_SECONDS),
      maxLifetimeSeconds: integer(expectation.maxLifetimeSeconds, DAY_SECONDS, 7 * DAY_SECONDS),
      clockToleranceSeconds: integer(expectation.clockToleranceSeconds, 0, 300)
    },
    issuedAt,
    expiresAt
  };
}

export const ROTATION_STATES = [
  "PLANNED", "JWKS_VERIFIED", "SENTINEL_HEAD", "SYNTHETIC_LIFECYCLE",
  "NEW_SECRET_STAGED", "NEW_REV_READY", "NEW_ACTIVE", "OLD_SECRET_REMOVED",
  "OLD_TOKEN_REVOKED_OR_EXPIRED"
] as const;
export type RotationState = typeof ROTATION_STATES[number];

export type RotationJournal = {
  artifactVersion: typeof STORAGE_TOKEN_ARTIFACT_VERSION;
  targetDigestSha256: string;
  tokenClaimsDigestSha256: string;
  state: RotationState;
  events: Array<{ state: RotationState; at: string; evidenceDigestSha256: string }>;
  oldTokenDisposition?: "TOKEN_SPECIFIC_REVOKED" | "TTL_EXPIRED";
};

export function createRotationJournal(input: {
  targetDigestSha256: string;
  tokenClaimsDigestSha256: string;
  at: string;
  evidenceDigestSha256: string;
}): RotationJournal {
  assertDigest(input.targetDigestSha256);
  assertDigest(input.tokenClaimsDigestSha256);
  assertDigest(input.evidenceDigestSha256);
  assertIso(input.at);
  return {
    artifactVersion: STORAGE_TOKEN_ARTIFACT_VERSION,
    targetDigestSha256: input.targetDigestSha256,
    tokenClaimsDigestSha256: input.tokenClaimsDigestSha256,
    state: "PLANNED",
    events: [{ state: "PLANNED", at: input.at, evidenceDigestSha256: input.evidenceDigestSha256 }]
  };
}

export function advanceRotationJournal(
  journal: RotationJournal,
  next: RotationState,
  input: { at: string; evidenceDigestSha256: string; oldTokenDisposition?: "TOKEN_SPECIFIC_REVOKED" | "TTL_EXPIRED" }
): RotationJournal {
  assertIso(input.at);
  assertDigest(input.evidenceDigestSha256);
  const currentIndex = ROTATION_STATES.indexOf(journal.state);
  if (ROTATION_STATES[currentIndex + 1] !== next) throw new Error("STORAGE_TOKEN_ROTATION_TRANSITION_INVALID");
  if (Date.parse(input.at) < Date.parse(journal.events[journal.events.length - 1].at)) {
    throw new Error("STORAGE_TOKEN_ROTATION_TIME_INVALID");
  }
  if (next === "OLD_TOKEN_REVOKED_OR_EXPIRED" && !input.oldTokenDisposition) {
    throw new Error("STORAGE_TOKEN_OLD_DISPOSITION_REQUIRED");
  }
  if (next !== "OLD_TOKEN_REVOKED_OR_EXPIRED" && input.oldTokenDisposition) {
    throw new Error("STORAGE_TOKEN_OLD_DISPOSITION_INVALID");
  }
  return {
    ...journal,
    state: next,
    events: [...journal.events, { state: next, at: input.at, evidenceDigestSha256: input.evidenceDigestSha256 }],
    ...(input.oldTokenDisposition ? { oldTokenDisposition: input.oldTokenDisposition } : {})
  };
}

export function tokenArtifactPublicEvidence(artifact: VerifiedStorageTokenArtifact) {
  return {
    event: "storage-token-artifact",
    artifactVersion: artifact.artifactVersion,
    algorithm: artifact.algorithm,
    kid: artifact.kid,
    issuer: artifact.issuer,
    audience: artifact.audience,
    role: artifact.role,
    expiresAt: artifact.expiresAt,
    alertDueAt: artifact.alertDueAt,
    claimsDigestSha256: artifact.claimsDigestSha256,
    result: "PASS" as const
  };
}

export function storageTokenRollbackDecision(input: {
  state: RotationState;
  oldSecretRecoverable: boolean;
  oldTokenExpiresAt: number;
  nowEpochSeconds: number;
}) {
  if (!Number.isSafeInteger(input.oldTokenExpiresAt) || !Number.isSafeInteger(input.nowEpochSeconds)) {
    throw new Error("STORAGE_TOKEN_ROLLBACK_TIME_INVALID");
  }
  const oldTokenUsable = input.oldSecretRecoverable && input.oldTokenExpiresAt > input.nowEpochSeconds;
  if (ROTATION_STATES.indexOf(input.state) < ROTATION_STATES.indexOf("OLD_SECRET_REMOVED")) {
    return oldTokenUsable
      ? { action: "REACTIVATE_OLD_REVISION" as const, signingKeyAction: "NONE" as const }
      : { action: "ENTER_MAINTENANCE" as const, signingKeyAction: "NONE" as const };
  }
  return oldTokenUsable
    ? { action: "RESTORE_OLD_SECRET_AND_REVISION" as const, signingKeyAction: "NONE" as const }
    : { action: "ENTER_MAINTENANCE" as const, signingKeyAction: "NONE" as const };
}

export function createBoundStorageHttpAdapter(input: {
  target: CloudTargetBinding;
  bucket: string;
  publishableKey: string;
  suppliedToken: string;
  verified: Awaited<ReturnType<typeof verifyApprovedStorageTokenBundle>>;
  confirmTargetSha256: string;
  confirmBundleSha256: string;
  fetchImpl: typeof fetch;
}) {
  if (input.confirmTargetSha256 !== targetBindingSha256(input.target)) throw new Error("STORAGE_HTTP_TARGET_BINDING_MISMATCH");
  if (input.confirmBundleSha256 !== input.verified.bundleSha256 || input.verified.bundle.targetSha256 !== input.confirmTargetSha256 ||
      input.verified.bundle.tokenSha256 !== sha256Hex(input.suppliedToken)) throw new Error("STORAGE_HTTP_TOKEN_BINDING_MISMATCH");
  if (!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(input.bucket) || !input.publishableKey || input.publishableKey.length > 4096 ||
      typeof input.fetchImpl !== "function") throw new Error("STORAGE_HTTP_CREDENTIAL_OR_TARGET_REQUIRED");
  const request = async (method: "HEAD" | "GET" | "POST" | "DELETE", key: string, body?: Uint8Array) => {
    if (!safeObjectKey(key)) throw new Error("STORAGE_HTTP_KEY_INVALID");
    const url = `${input.target.supabaseOrigin}/storage/v1/object/${encodeURIComponent(input.bucket)}/${key.split("/").map(encodeURIComponent).join("/")}`;
    const response = await input.fetchImpl(url, {
      method,
      headers: {
        apikey: input.publishableKey,
        authorization: `Bearer ${input.suppliedToken}`,
        ...(method === "POST" ? { "content-type": "application/octet-stream", "x-upsert": "false" } : {})
      },
      ...(body ? { body: Buffer.from(body) } : {})
    });
    if (response.status >= 500) throw new Error("STORAGE_HTTP_PROVIDER_FAILURE");
    return response;
  };
  return {
    head: async (key: string) => (await request("HEAD", key)).status,
    getBodyHash: async (key: string) => {
      const response = await request("GET", key);
      if (response.status !== 200) throw new Error("STORAGE_HTTP_GET_FAILED");
      const bytes = new Uint8Array(await response.arrayBuffer());
      return { byteSize: bytes.byteLength, hashSha256: sha256Hex(bytes) };
    },
    putNoOverwrite: async (key: string, bytes: Uint8Array) => {
      const response = await request("POST", key, bytes);
      if (![200, 201].includes(response.status)) throw new Error(response.status === 409 ? "STORAGE_HTTP_COLLISION" : "STORAGE_HTTP_PUT_FAILED");
      return { byteSize: bytes.byteLength, hashSha256: sha256Hex(bytes) };
    },
    deleteExact: async (key: string) => {
      const response = await request("DELETE", key);
      if (![200, 204].includes(response.status)) throw new Error("STORAGE_HTTP_DELETE_FAILED");
    }
  };
}

function assertDigest(value: string) {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error("STORAGE_TOKEN_EVIDENCE_DIGEST_INVALID");
}

function safeObjectKey(value: string) {
  return value.length > 0 && value.length <= 1024 && !value.includes("\\") && !value.includes("\0") &&
    !value.startsWith("/") && !value.split("/").some((segment) => !segment || segment === "." || segment === "..");
}

function assertIso(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error("STORAGE_TOKEN_EVENT_TIME_INVALID");
  }
}

function object(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: string[], code: string) {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) throw new Error(code);
}

function string(value: unknown, pattern: RegExp, code: string, maximum: number) {
  if (typeof value !== "string" || value !== value.trim() || value.length > maximum || !pattern.test(value)) throw new Error(code);
  return value;
}

function integer(value: unknown, minimum: number, maximum: number) {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error("STORAGE_TOKEN_EXPECTATION_NUMBER_INVALID");
  }
  return value as number;
}

function iso(value: unknown, code: string) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(code);
  }
  return value;
}

function fail(code: string): never { throw new Error(code); }
