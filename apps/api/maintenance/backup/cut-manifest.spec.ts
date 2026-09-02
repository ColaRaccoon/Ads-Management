import { describe, expect, it } from "vitest";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CloudTargetBinding, targetBindingSha256 } from "../shared/target-binding";
import { canonicalSha256 } from "../shared/strict-json";
import {
  BackedUpObject,
  BackupCutAdapter,
  BackupReference,
  createBoundBackupObjectCopyAdapter,
  createPublicKeyRestoreReceiptVerifier,
  runConsistentBackupCut,
  verifyBackupRestore
} from "./cut-manifest";
import { backupExecutionPlanSha256, runBackupCli } from "./backup.cli";

const hash = "a".repeat(64);
const target = {
  version: "cloud-target-binding/v1",
  environmentId: "staging-one",
  environmentClass: "staging",
  projectRef: "abcdefghijklmnopqrst",
  supabaseOrigin: "https://abcdefghijklmnopqrst.supabase.co",
  database: {
    connectionMode: "direct", host: "db.abcdefghijklmnopqrst.supabase.co", port: 5432, name: "postgres", schema: "app_runtime",
    loginUser: "postgres", expectedCurrentUser: "postgres", requiredRole: "app_maintenance", sslMode: "verify-full",
    tlsServerName: "db.abcdefghijklmnopqrst.supabase.co"
  },
  releaseGitSha: "b".repeat(40),
  issuedAt: "2026-09-01T00:00:00.000Z",
  expiresAt: "2026-09-01T01:00:00.000Z"
} satisfies CloudTargetBinding;
const reference: BackupReference = {
  model: "UploadBatch", recordId: "11111111-1111-4111-8111-111111111111", field: "storedFilePath",
  provider: "supabase", key: "uploads/a", hashSha256: hash, byteSize: 3, state: "IMPORTED"
};
const object: BackedUpObject = { provider: "supabase", key: "uploads/a", hashSha256: hash, byteSize: 3, backupLocator: "vault/cut/a" };

describe("consistent backup cut", () => {
  it("orders write block, drain, DB cut, object copy and DB recheck, then releases writes", async () => {
    const calls: string[] = [];
    const adapter = mockAdapter(calls);
    const result = await runConsistentBackupCut({
      target, bucket: "private", destination: destination(), adapter,
      cutId: "22222222-2222-4222-8222-222222222222"
    });
    expect(result.result).toBe("PASS");
    expect(calls).toEqual(["verify-block", "drain", "db-cut", "references", "objects", "watermark", "references", "request-release"]);
    if (result.result !== "PASS") throw new Error("test invariant");
    expect(result.evidence.counts).toMatchObject({ reference_count: 1, object_count: 1, object_bytes: 3 });
    const receipts = restoreReceipts(result.manifest);
    await expect(verifyBackupRestore({
      manifest: result.manifest, databaseReceipt: receipts.database, objectReceipt: receipts.objects,
      approvedDatabaseReceiptSha256: receipts.database.receiptDigestSha256,
      approvedObjectReceiptSha256: receipts.objects.receiptDigestSha256,
      producerArtifactDigestSha256: "d".repeat(64), signatureVerifier: { verify: async () => true }
    })).resolves.toMatchObject({ result: "PASS" });
  });

  it("does not claim consistency on a nonzero drain or changed watermark", async () => {
    const busy = mockAdapter([], { drain: { inFlight: 1, pending: 0, creating: 0 } });
    await expect(runConsistentBackupCut({ target, bucket: "private", destination: destination(), adapter: busy }))
      .resolves.toMatchObject({ result: "FAIL", code: "BACKUP_DRAIN_NOT_ZERO" });
    const drift = mockAdapter([], { afterWatermark: "changed" });
    await expect(runConsistentBackupCut({ target, bucket: "private", destination: destination(), adapter: drift }))
      .resolves.toMatchObject({ result: "FAIL", code: "BACKUP_CROSS_SYSTEM_DRIFT" });
  });

  it("fails on missing/hash-mismatched payload coverage and still releases writes", async () => {
    const calls: string[] = [];
    const adapter = mockAdapter(calls, { objects: [{ ...object, hashSha256: "c".repeat(64) }] });
    await expect(runConsistentBackupCut({ target, bucket: "private", destination: destination(), adapter }))
      .resolves.toMatchObject({ result: "FAIL", code: "BACKUP_OBJECT_COVERAGE_MISMATCH" });
    expect(calls.at(-1)).toBe("request-release");
  });

  it("rejects tampered manifests and empty/self-echo restore receipts", async () => {
    const result = await runConsistentBackupCut({ target, bucket: "private", destination: destination(), adapter: mockAdapter([]) });
    if (result.result !== "PASS") throw new Error("test invariant");
    const receipts = restoreReceipts(result.manifest);
    await expect(verifyBackupRestore({
      manifest: { ...result.manifest, bucket: "tampered" }, databaseReceipt: receipts.database, objectReceipt: receipts.objects,
      approvedDatabaseReceiptSha256: receipts.database.receiptDigestSha256,
      approvedObjectReceiptSha256: receipts.objects.receiptDigestSha256,
      producerArtifactDigestSha256: "d".repeat(64), signatureVerifier: { verify: async () => true }
    })).rejects.toThrow("BACKUP_MANIFEST_DIGEST_MISMATCH");
    const empty = signed({ ...receipts.objects, entries: [], receiptDigestSha256: undefined });
    await expect(verifyBackupRestore({
      manifest: result.manifest, databaseReceipt: receipts.database, objectReceipt: empty,
      approvedDatabaseReceiptSha256: receipts.database.receiptDigestSha256,
      approvedObjectReceiptSha256: empty.receiptDigestSha256,
      producerArtifactDigestSha256: "d".repeat(64), signatureVerifier: { verify: async () => false }
    })).rejects.toThrow(/BACKUP_RESTORE_(RECEIPT_SIGNATURE_INVALID|OBJECT_RECEIPT_EMPTY)/);
  });

  it("uses injected provider I/O, hashes actual bodies, and refuses unbound credentials", async () => {
    const bytes = Buffer.from("abc");
    const actualReference = { ...reference, hashSha256: createHash("sha256").update(bytes).digest("hex") } as BackupReference;
    await expect(Promise.resolve().then(() => createBoundBackupObjectCopyAdapter({
      target, bucket: "private", destination: destination(), confirmTargetSha256: "0".repeat(64),
      sourceCredentialReference: "source", destinationCredentialReference: "destination",
      io: { readSourceBody: async () => bytes, inspectDestination: async () => "MISSING", putDestinationNoOverwrite: async () => undefined, readDestinationBody: async () => bytes }
    }))).rejects.toThrow("BACKUP_OBJECT_ADAPTER_BINDING_REQUIRED");
    const copy = createBoundBackupObjectCopyAdapter({
      target, bucket: "private", destination: destination(), confirmTargetSha256: resultTargetSha(),
      sourceCredentialReference: "source-credential", destinationCredentialReference: "destination-credential",
      io: { readSourceBody: async () => bytes, inspectDestination: async () => "MISSING", putDestinationNoOverwrite: async () => undefined, readDestinationBody: async () => bytes }
    });
    await expect(copy("22222222-2222-4222-8222-222222222222", [actualReference])).resolves.toMatchObject([{ byteSize: 3 }]);
  });

  it("pins a public receipt key and verifies producer signatures without accepting a signer", async () => {
    const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const publicKeyPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
    const publicKeyDigest = createHash("sha256").update(pair.publicKey.export({ type: "spki", format: "der" })).digest("hex");
    const verifier = createPublicKeyRestoreReceiptVerifier({ publicKeyPem, confirmPublicKeySha256: publicKeyDigest });
    const payload = "{\"receipt\":true}";
    const signature = sign("sha256", Buffer.from(payload), pair.privateKey).toString("base64url");
    await expect(verifier.verify({ kind: "database", canonicalPayload: payload, signature, producerArtifactDigestSha256: "a".repeat(64) }))
      .resolves.toBe(true);
    expect(() => createPublicKeyRestoreReceiptVerifier({ publicKeyPem, confirmPublicKeySha256: "0".repeat(64) }))
      .toThrow("BACKUP_RESTORE_PUBLIC_KEY_MISMATCH");
  });

  it("runs the direct backup CLI only through an independently confirmed provider factory", async () => {
    const now = Date.now();
    const binding = { ...target, issuedAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now + 60 * 60_000).toISOString() };
    const cutId = "22222222-2222-4222-8222-222222222222";
    const planDigestSha256 = backupExecutionPlanSha256({ target: binding, bucket: "private", destination: destination(), cutId });
    const directory = mkdtempSync(path.join(os.tmpdir(), "backup-cli-"));
    const file = path.join(directory, "manifest.json");
    writeFileSync(file, JSON.stringify({
      target: binding,
      confirmation: { projectRef: binding.projectRef, releaseGitSha: binding.releaseGitSha, targetSha256: targetBindingSha256(binding) },
      bucket: "private", destination: destination(), cutId
    }));
    const artifacts = ["provider.json", "key.json", "receipt.json"].map((name) => path.join(directory, name));
    for (const artifact of artifacts) writeFileSync(artifact, "{}");
    const publicKeyFile = path.join(directory, "public-key.json");
    writeFileSync(publicKeyFile, JSON.stringify({
      version: "backup-write-block-public-key/v1", publicKeyPem: "synthetic-public-key", publicKeySha256: "8".repeat(64)
    }));
    let factoryCalls = 0;
    const argv = [
      `--manifest=${file}`, `--provider-binding=${artifacts[0]}`, `--encryption-key=${artifacts[1]}`,
      `--write-block-receipt=${artifacts[2]}`, `--write-block-public-key=${publicKeyFile}`, "--execute",
      `--confirm-plan-sha256=${planDigestSha256}`, `--confirm-provider-binding-sha256=${"9".repeat(64)}`,
      `--confirm-encryption-key-sha256=${"7".repeat(64)}`, `--confirm-write-block-receipt-sha256=${"6".repeat(64)}`,
      `--confirm-write-block-public-key-sha256=${"8".repeat(64)}`
    ];
    await expect(runBackupCli({
      argv, env: {}, providerFactory: async () => {
        factoryCalls += 1;
        return { adapter: mockAdapter([]), persistManifest: () => undefined };
      }
    })).resolves.toContain('"result":"PASS"');
    expect(factoryCalls).toBe(1);
    await expect(runBackupCli({
      argv: argv.map((arg) => arg.startsWith("--confirm-plan") ? `--confirm-plan-sha256=${"0".repeat(64)}` : arg),
      env: {}, providerFactory: async () => { throw new Error("must not compose"); }
    })).rejects.toThrow("BACKUP_PLAN_CONFIRMATION_MISMATCH");
  });
});

function destination() {
  return {
    provider: "CLOUDFLARE_R2" as const,
    destinationId: "independent-vault",
    accountId: "a".repeat(32),
    bucket: "private-backup",
    endpoint: `https://${"a".repeat(32)}.r2.cloudflarestorage.com`,
    region: "auto" as const,
    publicAccess: "PRIVATE" as const,
    residencyGuarantee: "NONE" as const,
    encryption: "CUSTOMER_MANAGED" as const,
    keyCustodyReference: "user-held-key-v1",
    retentionUntil: "2026-10-01T00:00:00.000Z",
    retentionDays: 30 as const,
    retentionApproval: "NOT_APPROVED" as const,
    independentFromSourceProject: true as const
  };
}

function mockAdapter(calls: string[], overrides: {
  drain?: { inFlight: number; pending: number; creating: number };
  afterWatermark?: string;
  objects?: BackedUpObject[];
} = {}): BackupCutAdapter {
  return {
    verifyExternalWriteBlock: async () => { calls.push("verify-block"); return { receiptDigestSha256: "9".repeat(64) }; },
    requestExternalWriteRelease: async () => { calls.push("request-release"); },
    readDrainState: async () => { calls.push("drain"); return overrides.drain ?? { inFlight: 0, pending: 0, creating: 0 }; },
    captureDatabaseCut: async () => {
      calls.push("db-cut");
      return { backupId: "db-backup", watermark: "lsn-1", dumpHashSha256: hash, migrationHistoryDigestSha256: "e".repeat(64), kpiDigestSha256: "f".repeat(64) };
    },
    listReferences: async () => { calls.push("references"); return [reference]; },
    copyObjectsNoOverwrite: async () => { calls.push("objects"); return overrides.objects ?? [object]; },
    readDatabaseWatermark: async () => { calls.push("watermark"); return overrides.afterWatermark ?? "lsn-1"; }
  };
}

function restoreReceipts(manifest: Extract<Awaited<ReturnType<typeof runConsistentBackupCut>>, { result: "PASS" }>["manifest"]) {
  const database = signed({
    version: "backup-database-restore-receipt/v1", manifestDigestSha256: manifest.manifestDigestSha256,
    sourceProjectRef: manifest.sourceProjectRef, isolatedProjectRef: "zzzzzzzzzzzzzzzzzzzz", isolatedSchema: "restore_verify",
    restoredDumpHashSha256: manifest.databaseCut.dumpHashSha256,
    migrationHistoryDigestSha256: manifest.databaseCut.migrationHistoryDigestSha256, watermark: manifest.databaseCut.watermark,
    referenceDigestSha256: manifest.referenceDigestBeforeSha256, kpiDigestSha256: manifest.databaseCut.kpiDigestSha256,
    producerArtifactDigestSha256: "d".repeat(64), signature: "s".repeat(64)
  });
  const objects = signed({
    version: "backup-object-restore-receipt/v1", manifestDigestSha256: manifest.manifestDigestSha256,
    isolatedDestinationId: manifest.destination.destinationId, isolatedPrefix: "restore/verify",
    entries: manifest.objects.map(({ provider, key, byteSize, hashSha256 }) => ({ provider, key, byteSize, bodyHashSha256: hashSha256 })),
    producerArtifactDigestSha256: "d".repeat(64), signature: "s".repeat(64)
  });
  return { database, objects };
}

function signed<T extends object>(value: T) {
  const cleaned = Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
  return { ...cleaned, receiptDigestSha256: canonicalSha256(cleaned) } as T & { receiptDigestSha256: string };
}

function resultTargetSha() {
  return targetBindingSha256(target);
}
