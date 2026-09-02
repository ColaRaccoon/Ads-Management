import { describe, expect, it } from "vitest";
import { createRedactedEvidence, serializeRedactedEvidence } from "./redacted-evidence";
import { parseCloudTargetBinding } from "./target-binding";

const target = parseCloudTargetBinding({
  version: "cloud-target-binding/v1",
  environmentId: "staging-seoul",
  environmentClass: "staging",
  projectRef: "ehnfrrmbkvlsbpvqcvkr",
  supabaseOrigin: "https://ehnfrrmbkvlsbpvqcvkr.supabase.co",
  database: {
    connectionMode: "direct",
    host: "db.ehnfrrmbkvlsbpvqcvkr.supabase.co",
    port: 5432,
    name: "postgres",
    schema: "app",
    loginUser: "meta_ads_readonly",
    expectedCurrentUser: "meta_ads_readonly",
    requiredRole: "meta_ads_readonly",
    sslMode: "verify-full",
    tlsServerName: "db.ehnfrrmbkvlsbpvqcvkr.supabase.co"
  },
  releaseGitSha: "023eed5000000000000000000000000000000000",
  issuedAt: "2026-09-01T07:55:00.000Z",
  expiresAt: "2026-09-01T09:00:00.000Z"
}, new Date("2026-09-01T08:00:00.000Z"));

describe("redacted cloud evidence", () => {
  it("emits only the bounded allow-list shape", () => {
    const evidence = createRedactedEvidence({
      target,
      kind: "migration.inspect",
      result: "BLOCKED",
      counts: { blockers: 1, relations: 21 },
      codes: ["LEGACY_COLLISION_BLOCKED"],
      evidenceId: "0f93df70-afb3-4c20-99c4-0760220b66df",
      generatedAt: new Date("2026-09-01T08:01:00.000Z")
    });
    const serialized = serializeRedactedEvidence(evidence);
    expect(JSON.parse(serialized)).toEqual(evidence);
    expect(serialized).not.toContain("db.ehnfrrmbkvlsbpvqcvkr.supabase.co");
  });

  it("rejects redaction canaries in keys and values", () => {
    expect(() => serializeRedactedEvidence({ ...createRedactedEvidence({
      target, kind: "auth.plan", result: "PASS"
    }), email: "redaction-canary@example.invalid" } as never)).toThrow("EVIDENCE_FORBIDDEN_KEY");
    expect(() => serializeRedactedEvidence({ ...createRedactedEvidence({
      target, kind: "auth.plan", result: "PASS"
    }), codes: ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature"] })).toThrow("EVIDENCE_SENSITIVE_VALUE");
  });
});
