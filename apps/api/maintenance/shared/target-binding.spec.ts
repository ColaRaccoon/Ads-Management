import { describe, expect, it } from "vitest";
import {
  assertTargetConfirmation,
  parseCloudTargetBinding,
  targetBindingSha256
} from "./target-binding";

const now = new Date("2026-09-01T08:00:00.000Z");
const releaseGitSha = "023eed5000000000000000000000000000000000";

function target(overrides: Record<string, unknown> = {}) {
  return {
    version: "cloud-target-binding/v1",
    environmentId: "production-seoul",
    environmentClass: "production",
    projectRef: "iygjmosbelbosfxidqxv",
    supabaseOrigin: "https://iygjmosbelbosfxidqxv.supabase.co",
    database: {
      connectionMode: "direct",
      host: "db.iygjmosbelbosfxidqxv.supabase.co",
      port: 5432,
      name: "postgres",
      schema: "app",
      loginUser: "meta_ads_migration",
      expectedCurrentUser: "meta_ads_migration",
      requiredRole: "meta_ads_migration",
      sslMode: "verify-full",
      tlsServerName: "db.iygjmosbelbosfxidqxv.supabase.co"
    },
    releaseGitSha,
    issuedAt: "2026-09-01T07:55:00.000Z",
    expiresAt: "2026-09-01T09:00:00.000Z",
    ...overrides
  };
}

describe("cloud maintenance target binding", () => {
  it("binds the exact project, database, environment, release, and expiry", () => {
    const parsed = parseCloudTargetBinding(target(), now);
    const targetSha256 = targetBindingSha256(parsed);
    expect(targetSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(() => assertTargetConfirmation(parsed, {
      projectRef: parsed.projectRef,
      releaseGitSha,
      targetSha256
    })).not.toThrow();
  });

  it("rejects project/origin mismatch, local databases, expired plans, and unknown fields", () => {
    expect(() => parseCloudTargetBinding(target({ supabaseOrigin: "https://other.supabase.co" }), now))
      .toThrow("TARGET_ORIGIN_MISMATCH");
    expect(() => parseCloudTargetBinding(target({ database: {
      connectionMode: "direct", host: "127.0.0.1", port: 5432, name: "postgres", schema: "app",
      loginUser: "meta_ads_migration", expectedCurrentUser: "meta_ads_migration",
      requiredRole: "meta_ads_migration", sslMode: "verify-full", tlsServerName: "127.0.0.1"
    } }), now)).toThrow("TARGET_DATABASE_HOST_LOCAL");
    expect(() => parseCloudTargetBinding(target({ expiresAt: "2026-09-01T07:59:59.000Z" }), now))
      .toThrow("TARGET_BINDING_EXPIRED_OR_FUTURE");
    expect(() => parseCloudTargetBinding({ ...target(), unexpected: true }, now))
      .toThrow("TARGET_BINDING_KEYS_INVALID");
  });

  it("binds the login principal, membership role, and verify-full TLS", () => {
    const direct = target();
    expect(() => parseCloudTargetBinding({ ...direct, database: {
      ...(direct.database as Record<string, unknown>), loginUser: "other_user"
    } }, now)).toThrow("TARGET_DATABASE_PRINCIPAL_MISMATCH");
    expect(() => parseCloudTargetBinding({ ...direct, database: {
      ...(direct.database as Record<string, unknown>), sslMode: "require"
    } }, now)).toThrow("TARGET_DATABASE_TLS_INVALID");
    expect(() => parseCloudTargetBinding({ ...direct, database: {
      ...(direct.database as Record<string, unknown>), tlsServerName: "pooler.supabase.com"
    } }, now)).toThrow("TARGET_DATABASE_TLS_INVALID");
  });

  it("rejects an issued/expires interval in reverse", () => {
    expect(() => parseCloudTargetBinding(target({
      issuedAt: "2026-09-01T08:04:00.000Z",
      expiresAt: "2026-09-01T08:03:00.000Z"
    }), now)).toThrow("TARGET_BINDING_LIFETIME_INVALID");
  });

  it("requires independent exact confirmations", () => {
    const parsed = parseCloudTargetBinding(target(), now);
    expect(() => assertTargetConfirmation(parsed, {
      projectRef: "ehnfrrmbkvlsbpvqcvkr",
      releaseGitSha,
      targetSha256: targetBindingSha256(parsed)
    })).toThrow("CONFIRM_PROJECT_REF_MISMATCH");
  });
});
