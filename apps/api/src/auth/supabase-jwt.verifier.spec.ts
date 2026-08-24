import { errors as joseErrors, generateKeyPair, KeyLike, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { AuthConfig } from "./auth.config";
import { SupabaseJwtVerifier } from "./supabase-jwt.verifier";

const issuer = "https://project.supabase.co/auth/v1";
const subject = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const config = {
  jwtIssuer: issuer,
  jwtAudience: "authenticated"
} as AuthConfig;

describe("SupabaseJwtVerifier", () => {
  let privateKey: KeyLike;
  let publicKey: KeyLike;

  beforeAll(async () => {
    ({ privateKey, publicKey } = await generateKeyPair("ES256"));
  });

  it("verifies signature, algorithm, issuer, audience, expiry, subject, and session_id", async () => {
    const verifier = new SupabaseJwtVerifier(config, async () => publicKey);
    const token = await sign(privateKey, {});
    await expect(verifier.verify(token)).resolves.toEqual({
      subject,
      sessionId,
      expiresAt: expect.any(Number)
    });
  });

  it.each([
    ["issuer", { issuer: "https://attacker.example/auth/v1" }],
    ["audience", { audience: "other" }],
    ["session", { sessionId: undefined }],
    ["subject", { subject: "not-a-uuid" }]
  ])("rejects an invalid %s as SESSION_INVALID", async (_name, overrides) => {
    const verifier = new SupabaseJwtVerifier(config, async () => publicKey);
    const token = await sign(privateKey, overrides);
    await expect(verifier.verify(token)).rejects.toMatchObject({ code: "SESSION_INVALID" });
  });

  it("distinguishes only a normally expired token", async () => {
    const verifier = new SupabaseJwtVerifier(config, async () => publicKey);
    const token = await sign(privateKey, { expiresAt: Math.floor(Date.now() / 1000) - 1 });
    await expect(verifier.verify(token)).rejects.toMatchObject({ code: "ACCESS_TOKEN_EXPIRED" });
  });

  it("rejects a tampered signed payload as SESSION_INVALID", async () => {
    const verifier = new SupabaseJwtVerifier(config, async () => publicKey);
    const valid = await sign(privateKey, {});
    const parts = valid.split(".");
    const index = Math.floor(parts[1].length / 2);
    parts[1] = `${parts[1].slice(0, index)}${parts[1][index] === "A" ? "B" : "A"}${parts[1].slice(index + 1)}`;
    await expect(verifier.verify(parts.join("."))).rejects.toMatchObject({ code: "SESSION_INVALID" });
  });

  it("rejects an unsupported symmetric algorithm even when presented with a key", async () => {
    const secret = new TextEncoder().encode("not-a-project-secret-but-long-enough-for-test");
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ session_id: sessionId })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer(issuer)
      .setAudience("authenticated")
      .setSubject(subject)
      .setExpirationTime(now + 300)
      .sign(secret);
    const verifier = new SupabaseJwtVerifier(config, async () => secret);
    await expect(verifier.verify(token)).rejects.toMatchObject({ code: "SESSION_INVALID" });
  });

  it("supports JWKS key rotation by resolving the key id for every unknown key", async () => {
    const rotated = await generateKeyPair("ES256");
    const keys = new Map<string, KeyLike>([["first", publicKey], ["rotated", rotated.publicKey]]);
    const verifier = new SupabaseJwtVerifier(config, async (header) => keys.get(header.kid!)!);
    await expect(verifier.verify(await sign(privateKey, { kid: "first" }))).resolves.toBeDefined();
    await expect(verifier.verify(await sign(rotated.privateKey, { kid: "rotated" })))
      .resolves.toBeDefined();
  });

  it("maps a transient JWKS network failure to AUTH_PROVIDER_UNAVAILABLE", async () => {
    const verifier = new SupabaseJwtVerifier(config, async () => {
      throw new TypeError("fetch failed: network unavailable");
    });
    await expect(verifier.verify(await sign(privateKey, {}))).rejects.toMatchObject({
      code: "AUTH_PROVIDER_UNAVAILABLE",
      status: 503
    });
  });

  it("maps a JWKS HTTP failure to provider unavailable but keeps unknown kid invalid", async () => {
    const unavailable = new SupabaseJwtVerifier(config, async () => {
      throw new joseErrors.JOSEError("Expected 200 OK from the JSON Web Key Set HTTP response");
    });
    await expect(unavailable.verify(await sign(privateKey, {}))).rejects.toMatchObject({
      code: "AUTH_PROVIDER_UNAVAILABLE",
      status: 503
    });

    const malformedJson = new SupabaseJwtVerifier(config, async () => {
      throw new joseErrors.JOSEError("Failed to parse the JSON Web Key Set HTTP response as JSON");
    });
    await expect(malformedJson.verify(await sign(privateKey, {}))).rejects.toMatchObject({
      code: "AUTH_PROVIDER_UNAVAILABLE",
      status: 503
    });

    const unknownKid = new SupabaseJwtVerifier(config, async () => {
      throw new joseErrors.JWKSNoMatchingKey();
    });
    await expect(unknownKid.verify(await sign(privateKey, {}))).rejects.toMatchObject({
      code: "SESSION_INVALID",
      status: 401
    });
  });
});

async function sign(
  key: KeyLike,
  overrides: {
    issuer?: string;
    audience?: string;
    subject?: string;
    sessionId?: string;
    expiresAt?: number;
    kid?: string;
  }
) {
  const now = Math.floor(Date.now() / 1000);
  const builder = new SignJWT({
    session_id: overrides.sessionId === undefined && "sessionId" in overrides
      ? undefined
      : overrides.sessionId ?? sessionId,
    role: "authenticated"
  })
    .setProtectedHeader({ alg: "ES256", typ: "JWT", kid: overrides.kid ?? "first" })
    .setIssuer(overrides.issuer ?? issuer)
    .setAudience(overrides.audience ?? "authenticated")
    .setSubject(overrides.subject ?? subject)
    .setIssuedAt(now)
    .setExpirationTime(overrides.expiresAt ?? now + 300);
  return builder.sign(key);
}
