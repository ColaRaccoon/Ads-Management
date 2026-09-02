import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { canonicalSha256, sha256Hex } from "../shared/strict-json";
import { CloudTargetBinding, targetBindingSha256 } from "../shared/target-binding";
import {
  advanceRotationJournal,
  createBoundStorageHttpAdapter,
  createRotationJournal,
  storageTokenRollbackDecision,
  tokenArtifactPublicEvidence,
  verifyApprovedStorageTokenBundle,
  verifySuppliedStorageToken
} from "./token-artifact";

const issuer = "https://abcdefghijklmnopqrst.supabase.co/auth/v1";
const subject = "11111111-1111-4111-8111-111111111111";
const now = 1_788_192_000;
const target = {
  version: "cloud-target-binding/v1", environmentId: "staging-one", environmentClass: "staging",
  projectRef: "abcdefghijklmnopqrst", supabaseOrigin: "https://abcdefghijklmnopqrst.supabase.co",
  database: {
    connectionMode: "direct", host: "db.abcdefghijklmnopqrst.supabase.co", port: 5432, name: "postgres", schema: "app_runtime",
    loginUser: "postgres", expectedCurrentUser: "postgres", requiredRole: "app_maintenance", sslMode: "verify-full",
    tlsServerName: "db.abcdefghijklmnopqrst.supabase.co"
  },
  releaseGitSha: "b".repeat(40), issuedAt: "2026-08-31T15:50:00.000Z", expiresAt: "2026-09-01T15:50:00.000Z"
} satisfies CloudTargetBinding;

describe("supplied storage token artifact", () => {
  let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
  let jwks: { keys: Awaited<ReturnType<typeof exportJWK>>[] };

  beforeAll(async () => {
    const pair = await generateKeyPair("ES256");
    privateKey = pair.privateKey;
    jwks = { keys: [{ ...await exportJWK(pair.publicKey), kid: "storage-key-1", alg: "ES256", use: "sig" }] };
  });

  it("verifies signature, kid, claims and the one-to-seven day TTL without exposing the token", async () => {
    const token = await sign(privateKey, {});
    const artifact = await verifySuppliedStorageToken({ token, jwks, expected: expected(), nowEpochSeconds: now });
    expect(artifact).toMatchObject({ algorithm: "ES256", kid: "storage-key-1", role: "storage_app" });
    expect(artifact.lifetimeSeconds).toBe(2 * 86_400);
    const publicEvidence = JSON.stringify(tokenArtifactPublicEvidence(artifact));
    expect(publicEvidence).not.toContain(token);
    expect(publicEvidence).not.toContain(subject);
  });

  it("rejects tampering, unknown kid, wrong role and unsafe TTL", async () => {
    const valid = await sign(privateKey, {});
    const parts = valid.split(".");
    parts[1] = `${parts[1].slice(0, -2)}aa`;
    await expect(verifySuppliedStorageToken({ token: parts.join("."), jwks, expected: expected(), nowEpochSeconds: now }))
      .rejects.toBeDefined();
    await expect(verifySuppliedStorageToken({ token: await sign(privateKey, { kid: "unknown" }), jwks, expected: expected(), nowEpochSeconds: now }))
      .rejects.toBeDefined();
    await expect(verifySuppliedStorageToken({ token: await sign(privateKey, { role: "authenticated" }), jwks, expected: expected(), nowEpochSeconds: now }))
      .rejects.toThrow("STORAGE_TOKEN_CLAIMS_INVALID");
    await expect(verifySuppliedStorageToken({ token: await sign(privateKey, { expiresAt: now + 300 }), jwks, expected: expected(), nowEpochSeconds: now }))
      .rejects.toThrow("STORAGE_TOKEN_TTL_INVALID");
    await expect(verifySuppliedStorageToken({
      token: valid, jwks: { keys: [{ ...jwks.keys[0], d: "private-material-not-accepted" }] }, expected: expected(), nowEpochSeconds: now
    })).rejects.toThrow("STORAGE_TOKEN_PUBLIC_JWKS_REQUIRED");
  });

  it("binds the supplied token and official-project JWKS to one independently confirmed approval bundle", async () => {
    const token = await sign(privateKey, {});
    const bundle = approvalBundle(token, jwks, "storage-key-1");
    const verified = await verifyApprovedStorageTokenBundle({
      token, jwks, target, bundle, confirmBundleSha256: canonicalSha256(bundle), nowEpochSeconds: now
    });
    expect(verified.artifact.kid).toBe("storage-key-1");
    expect(() => createBoundStorageHttpAdapter({
      target, bucket: "private", publishableKey: "publishable", suppliedToken: token, verified,
      confirmTargetSha256: "0".repeat(64), confirmBundleSha256: verified.bundleSha256,
      fetchImpl: async () => new Response("abc", { status: 200 })
    })).toThrow("STORAGE_HTTP_TARGET_BINDING_MISMATCH");
    const requested: string[] = [];
    const adapter = createBoundStorageHttpAdapter({
      target, bucket: "private", publishableKey: "publishable", suppliedToken: token, verified,
      confirmTargetSha256: targetBindingSha256(target), confirmBundleSha256: verified.bundleSha256,
      fetchImpl: async (url) => { requested.push(String(url)); return new Response("abc", { status: 200 }); }
    });
    await expect(adapter.getBodyHash("readiness/sentinel")).resolves.toEqual({ byteSize: 3, hashSha256: sha256Hex("abc") });
    expect(requested[0]).toBe(`${target.supabaseOrigin}/storage/v1/object/private/readiness/sentinel`);

    const attacker = await generateKeyPair("ES256");
    const attackerJwks = { keys: [{ ...await exportJWK(attacker.publicKey), kid: "storage-key-1", alg: "ES256", use: "sig" }] };
    const attackerToken = await sign(attacker.privateKey, {});
    await expect(verifyApprovedStorageTokenBundle({
      token: attackerToken, jwks: attackerJwks, target, bundle,
      confirmBundleSha256: canonicalSha256(bundle), nowEpochSeconds: now
    })).rejects.toThrow(/STORAGE_TOKEN_(VALUE|OFFICIAL_JWKS)_DIGEST_MISMATCH/);
    await expect(verifyApprovedStorageTokenBundle({
      token, jwks, target, bundle, confirmBundleSha256: "f".repeat(64), nowEpochSeconds: now
    })).rejects.toThrow("STORAGE_TOKEN_BUNDLE_CONFIRMATION_MISMATCH");
  });

  it("enforces the exact no-skip rotation sequence and explicit old-token disposition", () => {
    const digest = "a".repeat(64);
    let journal = createRotationJournal({ targetDigestSha256: digest, tokenClaimsDigestSha256: digest, at: iso(0), evidenceDigestSha256: digest });
    expect(() => advanceRotationJournal(journal, "SENTINEL_HEAD", { at: iso(1), evidenceDigestSha256: digest }))
      .toThrow("STORAGE_TOKEN_ROTATION_TRANSITION_INVALID");
    for (const state of ["JWKS_VERIFIED", "SENTINEL_HEAD", "SYNTHETIC_LIFECYCLE", "NEW_SECRET_STAGED", "NEW_REV_READY", "NEW_ACTIVE", "OLD_SECRET_REMOVED"] as const) {
      journal = advanceRotationJournal(journal, state, { at: iso(journal.events.length), evidenceDigestSha256: digest });
    }
    expect(() => advanceRotationJournal(journal, "OLD_TOKEN_REVOKED_OR_EXPIRED", { at: iso(8), evidenceDigestSha256: digest }))
      .toThrow("STORAGE_TOKEN_OLD_DISPOSITION_REQUIRED");
    journal = advanceRotationJournal(journal, "OLD_TOKEN_REVOKED_OR_EXPIRED", {
      at: iso(8), evidenceDigestSha256: digest, oldTokenDisposition: "TTL_EXPIRED"
    });
    expect(journal).toMatchObject({ state: "OLD_TOKEN_REVOKED_OR_EXPIRED", oldTokenDisposition: "TTL_EXPIRED" });
  });

  it("never treats signing-key revocation as a token rollback", () => {
    expect(storageTokenRollbackDecision({
      state: "NEW_ACTIVE", oldSecretRecoverable: true, oldTokenExpiresAt: now + 100, nowEpochSeconds: now
    })).toEqual({ action: "REACTIVATE_OLD_REVISION", signingKeyAction: "NONE" });
    expect(storageTokenRollbackDecision({
      state: "OLD_SECRET_REMOVED", oldSecretRecoverable: false, oldTokenExpiresAt: now - 1, nowEpochSeconds: now
    })).toEqual({ action: "ENTER_MAINTENANCE", signingKeyAction: "NONE" });
  });
});

function expected() {
  return { issuer, audience: "authenticated", subject, role: "storage_app" as const };
}

function approvalBundle(token: string, officialJwks: typeof jwks, kid: string) {
  return {
    version: "storage-token-approval/v1" as const,
    targetSha256: targetBindingSha256(target), projectRef: target.projectRef,
    officialJwksUrl: `${target.supabaseOrigin}/auth/v1/.well-known/jwks.json`,
    officialJwksSha256: canonicalSha256(officialJwks), approvedKid: kid, tokenSha256: sha256Hex(token),
    expectation: { ...expected(), minRemainingSeconds: 86_400, maxLifetimeSeconds: 7 * 86_400, clockToleranceSeconds: 30 },
    issuedAt: "2026-08-31T15:55:00.000Z", expiresAt: "2026-09-01T15:55:00.000Z"
  };
}

async function sign(key: typeof privateKey, overrides: { kid?: string; role?: string; expiresAt?: number }) {
  return new SignJWT({ role: overrides.role ?? "storage_app" })
    .setProtectedHeader({ alg: "ES256", typ: "JWT", kid: overrides.kid ?? "storage-key-1" })
    .setIssuer(issuer)
    .setAudience("authenticated")
    .setSubject(subject)
    .setIssuedAt(now)
    .setExpirationTime(overrides.expiresAt ?? now + 2 * 86_400)
    .sign(key);
}

function iso(offsetSeconds: number) {
  return new Date(Date.UTC(2026, 8, 1, 0, 0, offsetSeconds)).toISOString();
}
