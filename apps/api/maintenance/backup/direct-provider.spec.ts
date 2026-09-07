import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { canonicalJson, canonicalSha256, sha256Hex } from "../shared/strict-json";
import { CloudTargetBinding, targetBindingSha256 } from "../shared/target-binding";
import { BackupDestination, runConsistentBackupCut } from "./cut-manifest";
import { backupExecutionPlanSha256, runBackupCli } from "./backup.cli";
import {
  BACKUP_ENCRYPTION_KEY_VERSION,
  BACKUP_MAX_BOUNDED_PROVIDER_BODY_ALLOCATION_BYTES,
  BACKUP_MAX_DATABASE_INDEX_BYTES,
  BACKUP_MAX_DATABASE_PARTS,
  BACKUP_MAX_R2_ENVELOPE_BYTES,
  BACKUP_MAX_SOURCE_ENVELOPE_BYTES,
  BACKUP_PG_DUMP_FREE_SPACE_RESERVE_BYTES,
  BACKUP_PG_DUMP_LINUX_LIMIT_EXECUTABLE,
  BACKUP_MAX_SOURCE_OBJECT_BYTES,
  createCloudflareR2BackupAdapter,
  DatabaseChunkIndex,
  decryptBackupEnvelope,
  encryptBackupEnvelope,
  mapReportExportReferences,
  maximumR2EnvelopeBytesForLocator,
  parseDatabaseChunkIndex,
  R2_PROVIDER_BINDING_VERSION,
  R2ObjectIo,
  restoreDatabaseDumpFromChunkIndex,
  readBoundedProviderBody,
  readBoundedR2GetResponse,
  readDefaultSupabaseSourceBody,
  runDefaultPgDump,
  terminatePgDumpProcessTree,
  WRITE_BLOCK_RECEIPT_VERSION
} from "./direct-provider";

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
  issuedAt: "2026-09-02T00:00:00.000Z",
  expiresAt: "2026-09-03T00:00:00.000Z"
} satisfies CloudTargetBinding;
const cutId = "22222222-2222-4222-8222-222222222222";
const planDigestSha256 = "1".repeat(64);

describe("Cloudflare R2 direct backup provider", () => {
  it("encrypts with cut/locator/hash AAD and rejects tampering", () => {
    const key = Buffer.alloc(32, 7);
    const envelope = encryptBackupEnvelope({
      plaintext: Buffer.from("synthetic backup"), key, keyId: "user-key-v1", cutId,
      locator: "r2-backup/cut/database.dump", nonce: Buffer.alloc(12, 9)
    });
    expect(decryptBackupEnvelope({ envelope, key, expectedKeyId: "user-key-v1" }).toString()).toBe("synthetic backup");
    const value = JSON.parse(envelope.toString("utf8"));
    value.locator = "r2-backup/cut/tampered.dump";
    expect(() => decryptBackupEnvelope({ envelope: Buffer.from(JSON.stringify(value)), key, expectedKeyId: "user-key-v1" }))
      .toThrow(/BACKUP_ENVELOPE_(AAD_MISMATCH|AUTHENTICATION_FAILED)/);
    expect(envelope.includes(key)).toBe(false);
  });

  it("streams Supabase GET bodies without arrayBuffer and rejects missing/lying/overflowing lengths", async () => {
    const request = { target, bucket: "private", key: "uploads/synthetic.csv", token: "synthetic-token" };
    const missingLength = fakeWebBody([Buffer.from("ab"), Buffer.from("c")]);
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
    const missingFetch = vi.fn(async () => ({
      status: 200,
      headers: { get: () => null },
      body: missingLength.body,
      arrayBuffer
    } as unknown as Response)) as unknown as typeof fetch;
    await expect(readDefaultSupabaseSourceBody(request, { fetchImpl: missingFetch }))
      .resolves.toEqual(Buffer.from("abc"));
    expect(arrayBuffer).not.toHaveBeenCalled();

    const lyingLength = fakeWebBody([Buffer.from("abc")]);
    const lyingFetch = (async () => ({
      status: 200,
      headers: { get: () => "2" },
      body: lyingLength.body,
      arrayBuffer
    } as unknown as Response)) as typeof fetch;
    await expect(readDefaultSupabaseSourceBody(request, { fetchImpl: lyingFetch }))
      .rejects.toThrow("BACKUP_SOURCE_CONTENT_LENGTH_MISMATCH");
    expect(lyingLength.cancel).toHaveBeenCalledTimes(1);

    const truncatedLength = fakeWebBody([Buffer.from("abc")]);
    const truncatedFetch = (async () => ({
      status: 200,
      headers: { get: () => "4" },
      body: truncatedLength.body,
      arrayBuffer
    } as unknown as Response)) as typeof fetch;
    await expect(readDefaultSupabaseSourceBody(request, { fetchImpl: truncatedFetch }))
      .rejects.toThrow("BACKUP_SOURCE_CONTENT_LENGTH_MISMATCH");
    expect(truncatedLength.cancel).toHaveBeenCalledTimes(1);

    const declaredOverflow = fakeWebBody([Buffer.from("never-read")]);
    const overflowFetch = (async () => ({
      status: 200,
      headers: { get: () => String(BACKUP_MAX_SOURCE_OBJECT_BYTES + 1) },
      body: declaredOverflow.body,
      arrayBuffer
    } as unknown as Response)) as typeof fetch;
    await expect(readDefaultSupabaseSourceBody(request, { fetchImpl: overflowFetch }))
      .rejects.toThrow("BACKUP_SOURCE_BODY_TOO_LARGE");
    expect(declaredOverflow.cancel).toHaveBeenCalledTimes(1);
    expect(arrayBuffer).not.toHaveBeenCalled();

    const chunkedOverflow = fakeWebBody([Buffer.from("abc"), Buffer.from("def")]);
    await expect(readBoundedProviderBody({
      body: chunkedOverflow.body,
      maximumBytes: 5,
      errorPrefix: "BACKUP_SOURCE"
    })).rejects.toThrow("BACKUP_SOURCE_BODY_TOO_LARGE");
    expect(chunkedOverflow.cancel).toHaveBeenCalledTimes(1);

    for (const invalidChunk of [new Uint8Array(0), "not-bytes"] as unknown[]) {
      const invalid = fakeWebBody([invalidChunk as Uint8Array]);
      await expect(readBoundedProviderBody({
        body: invalid.body,
        maximumBytes: 5,
        errorPrefix: "BACKUP_SOURCE"
      })).rejects.toThrow("BACKUP_SOURCE_BODY_CHUNK_INVALID");
      expect(invalid.cancel).toHaveBeenCalledTimes(1);
    }
  });

  it("copies many tiny chunks into one exact preallocation without retaining per-chunk buffers", async () => {
    const totalBytes = 100_000;
    const singleton = Uint8Array.of(97);
    let emitted = 0;
    const body = {
      [Symbol.asyncIterator]: () => ({
        next: async () => emitted++ < totalBytes
          ? { done: false as const, value: singleton }
          : { done: true as const, value: undefined }
      })
    };
    const allocations: number[] = [];
    const result = await readBoundedProviderBody({
      body,
      contentLength: totalBytes,
      maximumBytes: totalBytes,
      errorPrefix: "BACKUP_SOURCE",
      allocateBuffer: (bytes) => {
        allocations.push(bytes);
        return Buffer.allocUnsafe(bytes);
      }
    });
    expect(allocations).toEqual([totalBytes]);
    expect(result).toEqual(Buffer.alloc(totalBytes, 97));
    expect(BACKUP_MAX_BOUNDED_PROVIDER_BODY_ALLOCATION_BYTES).toBe(2 * BACKUP_MAX_R2_ENVELOPE_BYTES);
  });

  it("bounds R2 async iterable bodies and rejects transformer-only or oversized response seams", async () => {
    const objectKey = `independent-r2-backup/${cutId}/objects/supabase/uploads/synthetic.csv.envelope.json`;
    const missingLength = fakeAsyncBody([Buffer.from("ab"), Buffer.from("c")]);
    await expect(readBoundedR2GetResponse({ Body: missingLength.body }, objectKey)).resolves.toEqual(Buffer.from("abc"));

    const lyingLength = fakeAsyncBody([Buffer.from("abc")]);
    await expect(readBoundedR2GetResponse({ Body: lyingLength.body, ContentLength: 2 }, objectKey))
      .rejects.toThrow("BACKUP_R2_GET_CONTENT_LENGTH_MISMATCH");
    expect(lyingLength.returnIterator).toHaveBeenCalledTimes(1);
    expect(lyingLength.destroy).toHaveBeenCalledTimes(1);

    const oversizedChunk = new Uint8Array(1);
    Object.defineProperty(oversizedChunk, "byteLength", {
      value: maximumR2EnvelopeBytesForLocator(objectKey) + 1
    });
    const iteratorOverflow = fakeAsyncBody([oversizedChunk]);
    await expect(readBoundedR2GetResponse({ Body: iteratorOverflow.body }, objectKey))
      .rejects.toThrow("BACKUP_R2_GET_BODY_TOO_LARGE");
    expect(iteratorOverflow.returnIterator).toHaveBeenCalledTimes(1);
    expect(iteratorOverflow.destroy).toHaveBeenCalledTimes(1);

    const transformer = vi.fn(async () => Buffer.from("unbounded"));
    await expect(readBoundedR2GetResponse({
      Body: { transformToByteArray: transformer }, ContentLength: 9
    }, objectKey)).rejects.toThrow("BACKUP_R2_GET_BODY_STREAM_INVALID");
    expect(transformer).not.toHaveBeenCalled();

    const declaredOverflow = fakeAsyncBody([Buffer.from("never-read")]);
    await expect(readBoundedR2GetResponse({
      Body: declaredOverflow.body,
      ContentLength: maximumR2EnvelopeBytesForLocator(objectKey) + 1
    }, objectKey)).rejects.toThrow("BACKUP_R2_GET_BODY_TOO_LARGE");
    expect(declaredOverflow.destroy).toHaveBeenCalledTimes(1);
  });

  it("bounds database index/envelope contracts to 512 parts before JSON parsing", () => {
    expect(BACKUP_MAX_DATABASE_PARTS).toBe(512);
    expect(BACKUP_MAX_DATABASE_INDEX_BYTES).toBeLessThan(BACKUP_MAX_SOURCE_OBJECT_BYTES);
    expect(BACKUP_MAX_SOURCE_ENVELOPE_BYTES).toBe(BACKUP_MAX_R2_ENVELOPE_BYTES);
    expect(maximumR2EnvelopeBytesForLocator(
      `independent-r2-backup/${cutId}/database/index.envelope.json`
    )).toBeLessThan(BACKUP_MAX_R2_ENVELOPE_BYTES);
    expect(() => decryptBackupEnvelope({
      envelope: { byteLength: BACKUP_MAX_R2_ENVELOPE_BYTES + 1 } as Uint8Array,
      key: Buffer.alloc(32),
      expectedKeyId: "user-key-v1"
    })).toThrow("BACKUP_ENVELOPE_TOO_LARGE");
    expect(() => parseDatabaseChunkIndex({
      version: "backup-database-chunk-index/v1",
      cutId,
      indexLocator: `independent-r2-backup/${cutId}/database/index.envelope.json`,
      chunkBytes: 1,
      partCount: BACKUP_MAX_DATABASE_PARTS + 1,
      totalPlaintextBytes: BACKUP_MAX_DATABASE_PARTS + 1,
      dumpHashSha256: "a".repeat(64),
      parts: Array.from({ length: BACKUP_MAX_DATABASE_PARTS + 1 }, () => ({}))
    })).toThrow("BACKUP_DATABASE_INDEX_INVALID");
  });

  it("returns FAIL without a manifest when bounded default source or R2 response validation rejects", async () => {
    const sourceFixture = artifacts();
    const sourceCounters = { prisma: 0, source: 0, dump: 0, r2: 0 };
    const sourceInput = directInput(sourceFixture, sourceCounters);
    const sourceOverflow = fakeWebBody([Buffer.from("never-read")]);
    const sourceFetch = (async () => ({
      status: 200,
      headers: { get: () => String(BACKUP_MAX_SOURCE_OBJECT_BYTES + 1) },
      body: sourceOverflow.body
    } as unknown as Response)) as typeof fetch;
    const sourceDependencies = sourceInput.dependencies as unknown as Record<string, unknown>;
    sourceDependencies.readSourceBody = undefined;
    sourceDependencies.fetchSource = sourceFetch;
    await expect(runConsistentBackupCut({
      target, bucket: "private", destination: destination(), cutId,
      adapter: (await createCloudflareR2BackupAdapter(sourceInput)).adapter
    })).resolves.toMatchObject({ result: "FAIL", code: "BACKUP_SOURCE_BODY_TOO_LARGE" });
    expect(sourceOverflow.cancel).toHaveBeenCalledTimes(1);

    const r2Fixture = artifacts();
    const r2Counters = { prisma: 0, source: 0, dump: 0, r2: 0 };
    const r2Input = directInput(r2Fixture, r2Counters);
    let destroyedBodies = 0;
    r2Input.dependencies.createR2Io = async () => ({
      inspect: async () => "MISSING" as const,
      putNoOverwrite: async () => { r2Counters.r2 += 1; },
      read: async (key) => {
        const boundedBody = fakeAsyncBody([Buffer.from("never-read")]);
        boundedBody.destroy.mockImplementation(() => { destroyedBodies += 1; });
        return readBoundedR2GetResponse({
          Body: boundedBody.body,
          ContentLength: maximumR2EnvelopeBytesForLocator(key) + 1
        }, key);
      }
    });
    await expect(runConsistentBackupCut({
      target, bucket: "private", destination: destination(), cutId,
      adapter: (await createCloudflareR2BackupAdapter(r2Input)).adapter
    })).resolves.toMatchObject({ result: "FAIL", code: "BACKUP_R2_GET_BODY_TOO_LARGE" });
    expect(destroyedBodies).toBe(1);
  });

  it("fails all artifact and credential validation before Prisma, source, pg_dump, or R2", async () => {
    const fixture = artifacts();
    const cases: Array<{ change: (input: ReturnType<typeof directInput>) => void; code: string }> = [
      {
        change: (input) => { (input as unknown as Record<string, unknown>).providerBinding = undefined; },
        code: "BACKUP_PROVIDER_BINDING_REQUIRED"
      },
      { change: (input) => { input.confirmProviderBindingSha256 = "0".repeat(64); }, code: "BACKUP_PROVIDER_CONFIRMATION_MISMATCH" },
      {
        change: (input) => { (input as unknown as Record<string, unknown>).encryptionKeyArtifact = undefined; },
        code: "BACKUP_ENCRYPTION_KEY_REQUIRED"
      },
      { change: (input) => { input.confirmEncryptionKeySha256 = "0".repeat(64); }, code: "BACKUP_ENCRYPTION_KEY_CONFIRMATION_MISMATCH" },
      {
        change: (input) => { (input as unknown as Record<string, unknown>).writeBlockReceipt = undefined; },
        code: "BACKUP_WRITE_BLOCK_RECEIPT_REQUIRED"
      },
      { change: (input) => { input.confirmWriteBlockReceiptSha256 = "0".repeat(64); }, code: "BACKUP_WRITE_BLOCK_RECEIPT_CONFIRMATION_MISMATCH" },
      { change: (input) => { input.sourceToken = "wrong"; }, code: "BACKUP_SOURCE_CREDENTIAL_MISMATCH" },
      { change: (input) => { input.r2AccessKeyId = "wrong"; }, code: "BACKUP_R2_CREDENTIAL_MISMATCH" }
    ];
    for (const item of cases) {
      const counters = { prisma: 0, source: 0, dump: 0, r2: 0 };
      const input = directInput(fixture, counters);
      item.change(input);
      await expect(createCloudflareR2BackupAdapter(input)).rejects.toThrow(item.code);
      expect(counters).toEqual({ prisma: 0, source: 0, dump: 0, r2: 0 });
    }
  });

  it("fails a missing S3 module before DB/provider operations", async () => {
    const fixture = artifacts();
    const counters = { prisma: 0, source: 0, dump: 0, r2: 0 };
    const input = directInput(fixture, counters);
    const dependencies = input.dependencies as unknown as Record<string, unknown>;
    dependencies.createR2Io = undefined;
    dependencies.loadR2Module = async () => { throw new Error("synthetic missing module"); };
    dependencies.createPrismaIo = async () => {
      counters.prisma += 1;
      return prismaIo(counters);
    };
    await expect(createCloudflareR2BackupAdapter(input)).rejects.toThrow("BACKUP_R2_MODULE_UNAVAILABLE");
    expect(counters.prisma).toBe(0);
    expect(counters.source).toBe(0);
    expect(counters.dump).toBe(0);
    expect(counters.r2).toBe(0);
  });

  it("rejects invalid injected S3 module shapes and accepts the exact four-constructor contract", async () => {
    class FakeCommand { constructor(readonly input: unknown) {} }
    const invalidModules: unknown[] = [
      null,
      {},
      { S3Client: class {}, HeadObjectCommand: FakeCommand, PutObjectCommand: FakeCommand, GetObjectCommand: FakeCommand }
    ];
    for (const loaded of invalidModules) {
      const fixture = artifacts();
      const counters = { prisma: 0, source: 0, dump: 0, r2: 0 };
      const input = directInput(fixture, counters);
      const dependencies = input.dependencies as unknown as Record<string, unknown>;
      dependencies.createR2Io = undefined;
      dependencies.loadR2Module = async () => loaded;
      await expect(createCloudflareR2BackupAdapter(input)).rejects.toThrow("BACKUP_R2_MODULE_INVALID");
      expect(counters).toEqual({ prisma: 0, source: 0, dump: 0, r2: 0 });
    }

    const fixture = artifacts();
    const counters = { prisma: 0, source: 0, dump: 0, r2: 0 };
    const input = directInput(fixture, counters);
    const dependencies = input.dependencies as unknown as Record<string, unknown>;
    dependencies.createR2Io = undefined;
    dependencies.loadR2Module = async () => ({
      S3Client: class { send = async () => ({}); },
      HeadObjectCommand: FakeCommand,
      PutObjectCommand: FakeCommand,
      GetObjectCommand: FakeCommand
    });
    await expect(createCloudflareR2BackupAdapter(input)).resolves.toHaveProperty("adapter");
    expect(counters).toEqual({ prisma: 1, source: 0, dump: 0, r2: 0 });
  });

  it("writes encrypted DB/object envelopes no-overwrite, persists manifest exclusively, and emits only a release request", async () => {
    const fixture = artifacts();
    const counters = { prisma: 0, source: 0, dump: 0, r2: 0 };
    const composition = await createCloudflareR2BackupAdapter(directInput(fixture, counters));
    const result = await runConsistentBackupCut({
      target, bucket: "private", destination: destination(), cutId, adapter: composition.adapter
    });
    expect(result.result).toBe("PASS");
    if (result.result !== "PASS") throw new Error("test invariant");
    composition.persistManifest(result.manifest);
    expect(counters).toMatchObject({ source: 1, dump: 1, r2: 6 });
    expect(result.manifest.databaseCut.backupId).toBe(
      `${destination().destinationId}/${cutId}/database/index.envelope.json`
    );
    const root = path.join(fixture.outputRoot, `backup-cut-${cutId}`);
    const manifestFile = path.join(root, "backup-cut-manifest.json");
    const releaseFile = path.join(root, "release-writes-request.json");
    expect(existsSync(manifestFile)).toBe(true);
    expect(JSON.parse(readFileSync(releaseFile, "utf8"))).toMatchObject({
      action: "RELEASE_WRITES_REQUESTED", externalResult: "NOT_RUN"
    });
    expect(() => composition.persistManifest(result.manifest)).toThrow();
    if (process.platform !== "win32") expect(statSync(manifestFile).mode & 0o077).toBe(0);
  });

  it("fails closed on an existing destination, target drift, and pg_dump failure while preserving the release boundary", async () => {
    const existing = artifacts();
    const existingCounters = { prisma: 0, source: 0, dump: 0, r2: 0 };
    const existingInput = directInput(existing, existingCounters, { alwaysFound: true });
    const existingComposition = await createCloudflareR2BackupAdapter(existingInput);
    await expect(runConsistentBackupCut({
      target, bucket: "private", destination: destination(), cutId, adapter: existingComposition.adapter
    })).resolves.toMatchObject({ result: "FAIL", code: "BACKUP_R2_NO_OVERWRITE_VIOLATION" });
    expect(existingCounters.r2).toBe(0);

    const driftTarget = { ...target, environmentId: "staging-two" };
    await expect(existingComposition.adapter.verifyExternalWriteBlock(driftTarget)).rejects.toThrow("BACKUP_PROVIDER_TARGET_DRIFT");

    const failed = artifacts();
    const failedCounters = { prisma: 0, source: 0, dump: 0, r2: 0 };
    const failedInput = directInput(failed, failedCounters);
    failedInput.dependencies = {
      ...failedInput.dependencies,
      runPgDump: async () => { failedCounters.dump += 1; throw new Error("BACKUP_PG_DUMP_FAILED"); }
    };
    const failedComposition = await createCloudflareR2BackupAdapter(failedInput);
    await expect(runConsistentBackupCut({
      target, bucket: "private", destination: destination(), cutId, adapter: failedComposition.adapter
    })).resolves.toMatchObject({ result: "FAIL", code: "BACKUP_PG_DUMP_FAILED" });
    expect(failedCounters.r2).toBe(0);
    expect(existsSync(path.join(failed.outputRoot, `backup-cut-${cutId}`, "release-writes-request.json"))).toBe(true);
  });

  it("uses the concrete default CLI composition and returns only redacted digest evidence", async () => {
    const actualPlanDigest = backupExecutionPlanSha256({ target, bucket: "private", destination: destination(), cutId });
    const fixture = artifacts(actualPlanDigest, Date.parse(target.issuedAt));
    const counters = { prisma: 0, source: 0, dump: 0, r2: 0 };
    const direct = directInput(fixture, counters);
    const directory = mkdtempSync(path.join(os.tmpdir(), "r2-backup-cli-"));
    const files = {
      manifest: path.join(directory, "manifest.json"),
      binding: path.join(directory, "provider-binding.json"),
      key: path.join(directory, "encryption-key.json"),
      receipt: path.join(directory, "write-block-receipt.json"),
      publicKey: path.join(directory, "write-block-public-key.json")
    };
    writeFileSync(files.manifest, JSON.stringify({
      target,
      confirmation: { projectRef: target.projectRef, releaseGitSha: target.releaseGitSha, targetSha256: targetBindingSha256(target) },
      bucket: "private",
      destination: destination(),
      cutId
    }));
    writeFileSync(files.binding, JSON.stringify(fixture.providerBinding));
    writeFileSync(files.key, JSON.stringify(fixture.encryptionKeyArtifact));
    writeFileSync(files.receipt, JSON.stringify(fixture.writeBlockReceipt));
    writeFileSync(files.publicKey, JSON.stringify({
      version: "backup-write-block-public-key/v1",
      publicKeyPem: fixture.publicKeyPem.trim(),
      publicKeySha256: fixture.publicKeySha256
    }));
    const cliInput = {
      argv: [
        `--manifest=${files.manifest}`,
        `--provider-binding=${files.binding}`,
        `--encryption-key=${files.key}`,
        `--write-block-receipt=${files.receipt}`,
        `--write-block-public-key=${files.publicKey}`,
        "--execute",
        `--confirm-plan-sha256=${actualPlanDigest}`,
        `--confirm-provider-binding-sha256=${canonicalSha256(fixture.providerBinding)}`,
        `--confirm-encryption-key-sha256=${canonicalSha256(fixture.encryptionKeyArtifact)}`,
        `--confirm-write-block-receipt-sha256=${fixture.writeBlockReceipt.receiptDigestSha256}`,
        `--confirm-write-block-public-key-sha256=${fixture.publicKeySha256}`
      ],
      env: {
        BACKUP_DATABASE_URL: direct.databaseUrl,
        BACKUP_PG_DUMP_EXECUTABLE: direct.pgDumpExecutable,
        BACKUP_OUTPUT_ROOT: direct.outputRoot,
        BACKUP_SUPABASE_STORAGE_READ_TOKEN: direct.sourceToken,
        BACKUP_R2_ACCESS_KEY_ID: direct.r2AccessKeyId,
        BACKUP_R2_SECRET_ACCESS_KEY: direct.r2SecretAccessKey
      },
      directDependencies: direct.dependencies
    };
    // Freeze only Date for this synthetic approval; keep I/O and timeout timers real.
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(target.issuedAt) });
    try {
      const output = await runBackupCli(cliInput);
      expect(JSON.parse(output)).toMatchObject({
        result: "PASS", retentionDays: 30, retentionApproval: "NOT_APPROVED", releaseResult: "NOT_RUN"
      });
      expect(output).not.toContain(fixture.sourceToken);
      expect(output).not.toContain(fixture.r2SecretAccessKey);

      const countersBeforeExpiryCheck = { ...counters };
      vi.setSystemTime(new Date(target.expiresAt));
      await expect(runBackupCli(cliInput)).rejects.toThrow("TARGET_BINDING_EXPIRED_OR_FUTURE");
      expect(counters).toEqual(countersBeforeExpiryCheck);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed instead of omitting an asymmetric ReportExport file reference as a zero-reference PASS", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const hash = "a".repeat(64);
    const invalidRows = [
      { id, filePath: "reports/export.xlsx", fileHashSha256: null, status: "READY" },
      { id, filePath: null, fileHashSha256: hash, status: "READY" },
      { id, filePath: "reports/export.xlsx", fileHashSha256: "invalid", status: "READY" },
      { id, filePath: "", fileHashSha256: hash, status: "READY" }
    ];
    for (const row of invalidRows) {
      expect(() => mapReportExportReferences([row])).toThrow("BACKUP_PRISMA_REPORT_EXPORT_REFERENCE_INVALID");
    }
    expect(mapReportExportReferences([{ id, filePath: null, fileHashSha256: null, status: "PENDING" }])).toEqual([]);
    expect(mapReportExportReferences([{
      id, filePath: "reports/export.xlsx", fileHashSha256: hash, status: "READY"
    }])).toEqual([{
      model: "ReportExport", recordId: id, field: "filePath", key: "reports/export.xlsx",
      hashSha256: hash, state: "READY"
    }]);
  });

  it("supervises pg_dump timeout, size, stderr and final output without launching a real child", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pg-dump-supervisor-"));
    const insufficientFile = path.join(directory, "insufficient.dump");
    writeFileSync(insufficientFile, "");
    const preflightSpawn = vi.fn() as unknown as typeof spawn;
    await expect(runDefaultPgDump(pgDumpInput(insufficientFile), {
      spawnProcess: preflightSpawn,
      maximumDumpBytes: 1_024,
      availableFilesystemBytes: () => BigInt(BACKUP_PG_DUMP_FREE_SPACE_RESERVE_BYTES + 1_023)
    })).rejects.toThrow("BACKUP_PG_DUMP_FREE_SPACE_INSUFFICIENT");
    expect(preflightSpawn).not.toHaveBeenCalled();

    const timeoutFile = path.join(directory, "timeout.dump");
    writeFileSync(timeoutFile, "");
    let timeoutTerminations = 0;
    await expect(runDefaultPgDump(pgDumpInput(timeoutFile), {
      spawnProcess: fakeSpawn(() => undefined),
      terminateProcessTree: (child) => {
        timeoutTerminations += 1;
        queueMicrotask(() => child.emit("exit", null, "SIGKILL"));
      },
      timeoutMs: 5,
      pollIntervalMs: 1,
      maximumDumpBytes: 1024,
      availableFilesystemBytes: () => BigInt(BACKUP_PG_DUMP_FREE_SPACE_RESERVE_BYTES + 2_048)
    })).rejects.toThrow("BACKUP_PG_DUMP_TIMEOUT");
    expect(timeoutTerminations).toBe(1);

    const oversizeFile = path.join(directory, "oversize.dump");
    writeFileSync(oversizeFile, Buffer.alloc(2_048));
    let sizeTerminations = 0;
    await expect(runDefaultPgDump(pgDumpInput(oversizeFile), {
      spawnProcess: fakeSpawn(() => undefined),
      terminateProcessTree: (child) => {
        sizeTerminations += 1;
        queueMicrotask(() => child.emit("exit", null, "SIGKILL"));
      },
      timeoutMs: 1_000,
      pollIntervalMs: 1,
      maximumDumpBytes: 1_024,
      availableFilesystemBytes: () => BigInt(BACKUP_PG_DUMP_FREE_SPACE_RESERVE_BYTES + 2_048)
    })).rejects.toThrow("BACKUP_PG_DUMP_SIZE_LIMIT");
    expect(sizeTerminations).toBe(1);

    const successFile = path.join(directory, "success.dump");
    writeFileSync(successFile, "");
    const forbiddenEnvironment = {
      BACKUP_R2_ACCESS_KEY_ID: "must-not-leak",
      BACKUP_R2_SECRET_ACCESS_KEY: "must-not-leak",
      BACKUP_SUPABASE_STORAGE_READ_TOKEN: "must-not-leak",
      AWS_ACCESS_KEY_ID: "must-not-leak",
      AWS_SECRET_ACCESS_KEY: "must-not-leak",
      SUPABASE_ACCESS_TOKEN: "must-not-leak",
      SUPABASE_SERVICE_ROLE_KEY: "must-not-leak",
      DATABASE_URL: "postgresql://must-not-leak",
      HOME: "/must-not-leak",
      PGPASSFILE: "/must-not-leak/pgpass",
      PGSERVICE: "must-not-leak",
      PGUSER: "must-not-leak",
      PGHOST: "must-not-leak"
    };
    for (const [name, value] of Object.entries(forbiddenEnvironment)) vi.stubEnv(name, value);
    let observedCommand = "";
    let observedArgs: readonly string[] = [];
    let observedOptions: { shell?: boolean; detached?: boolean; env?: NodeJS.ProcessEnv } | undefined;
    try {
      await expect(runDefaultPgDump(pgDumpInput(successFile), {
        spawnProcess: fakeSpawn((child, command, args, options) => {
          observedCommand = command;
          observedArgs = args;
          observedOptions = options as { shell?: boolean; detached?: boolean; env?: NodeJS.ProcessEnv };
          child.stderr!.write(Buffer.alloc(128 * 1024, 65));
          writeFileSync(successFile, "bounded synthetic dump");
          queueMicrotask(() => child.emit("exit", 0, null));
        }),
        timeoutMs: 1_000,
        pollIntervalMs: 1,
        maximumDumpBytes: 1_024,
        platform: "linux",
        availableFilesystemBytes: () => BigInt(BACKUP_PG_DUMP_FREE_SPACE_RESERVE_BYTES + 2_048)
      })).resolves.toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
    expect(observedCommand).toBe(BACKUP_PG_DUMP_LINUX_LIMIT_EXECUTABLE);
    expect(observedArgs.slice(0, 3)).toEqual(["--fsize=1024:1024", "--", pgDumpInput(successFile).executable]);
    expect(observedOptions?.shell).toBe(false);
    const childEnvironment = observedOptions?.env ?? {};
    expect(childEnvironment.PGPASSWORD).toBe("synthetic-password");
    expect(childEnvironment.PGSSLMODE).toBe("verify-full");
    expect(Object.keys(childEnvironment).every((name) => [
      "PATH", "LANG", "LC_ALL", "TZ", "SSL_CERT_FILE", "SSL_CERT_DIR",
      "SystemRoot", "WINDIR", "TEMP", "TMP", "PGPASSWORD", "PGSSLMODE"
    ].includes(name))).toBe(true);
    expect(Object.keys(forbiddenEnvironment).filter((name) => name in childEnvironment)).toEqual([]);
  });

  it("cancels delayed Linux group SIGKILL after child exit so a reused pgid is not signaled", async () => {
    vi.useFakeTimers();
    try {
      const child = new EventEmitter() as ChildProcess;
      Object.assign(child, { pid: 4242, kill: vi.fn(() => true) });
      const killProcess = vi.fn((_pid: number, _signal: NodeJS.Signals) => true);
      terminatePgDumpProcessTree(child, { platform: "linux", killProcess });
      expect(killProcess).toHaveBeenCalledTimes(1);
      expect(killProcess).toHaveBeenLastCalledWith(-4242, "SIGTERM");
      child.emit("exit", 0, null);
      await vi.advanceTimersByTimeAsync(2_500);
      expect(killProcess).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses HEAD inventory and rejects oversized source metadata before object body GET", async () => {
    const fixture = artifacts();
    const counters = { prisma: 0, source: 0, dump: 0, r2: 0 };
    const input = directInput(fixture, counters);
    input.dependencies = {
      ...input.dependencies,
      inspectSourceObject: async () => ({ byteSize: BACKUP_MAX_SOURCE_OBJECT_BYTES + 1 })
    };
    const composition = await createCloudflareR2BackupAdapter(input);
    await expect(runConsistentBackupCut({
      target, bucket: "private", destination: destination(), cutId, adapter: composition.adapter
    })).resolves.toMatchObject({ result: "FAIL", code: "BACKUP_SOURCE_BODY_TOO_LARGE" });
    expect(counters.source).toBe(0);
  });

  it("restores ordered chunks incrementally and rejects part tamper, reordering, and overall digest drift", async () => {
    const key = Buffer.alloc(32, 4);
    const keyId = "restore-key-v1";
    const prefix = `backup/${cutId}/database/`;
    const indexLocator = `${prefix}index.envelope.json`;
    const chunks = [Buffer.from("abc"), Buffer.from("def"), Buffer.from("gh")];
    const envelopes = new Map<string, Buffer>();
    const parts: DatabaseChunkIndex["parts"] = chunks.map((chunk, index) => {
      const locator = `${prefix}part-${String(index).padStart(6, "0")}.envelope.json`;
      const envelope = encryptBackupEnvelope({
        plaintext: chunk, key, keyId, cutId, locator, nonce: Buffer.alloc(12, index + 1)
      });
      envelopes.set(locator, envelope);
      return {
        index, locator, plaintextBytes: chunk.byteLength, plaintextSha256: sha256Hex(chunk),
        envelopeBytes: envelope.byteLength, envelopeSha256: sha256Hex(envelope)
      };
    });
    const dumpHashSha256 = sha256Hex(Buffer.concat(chunks));
    const index: DatabaseChunkIndex = {
      version: "backup-database-chunk-index/v1", cutId, indexLocator, chunkBytes: 3, partCount: parts.length,
      totalPlaintextBytes: chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0), dumpHashSha256, parts
    };
    const indexEnvelope = (value: DatabaseChunkIndex, nonce: number) => encryptBackupEnvelope({
      plaintext: Buffer.from(canonicalJson(value)), key, keyId, cutId, locator: indexLocator, nonce: Buffer.alloc(12, nonce)
    });
    const received: string[] = [];
    await expect(restoreDatabaseDumpFromChunkIndex({
      indexEnvelope: indexEnvelope(index, 9), indexLocator, expectedCutId: cutId, expectedDumpHashSha256: dumpHashSha256,
      key, keyId, readPartEnvelope: async (locator) => envelopes.get(locator)!,
      onChunk: (chunk) => { expect(chunk.byteLength).toBeLessThanOrEqual(3); received.push(Buffer.from(chunk).toString()); }
    })).resolves.toMatchObject({ partCount: 3, totalPlaintextBytes: 8, dumpHashSha256 });
    expect(received).toEqual(["abc", "def", "gh"]);

    const firstLocator = parts[0].locator;
    const original = envelopes.get(firstLocator)!;
    const tampered = Buffer.from(original);
    tampered[tampered.length - 2] ^= 1;
    envelopes.set(firstLocator, tampered);
    await expect(restoreDatabaseDumpFromChunkIndex({
      indexEnvelope: indexEnvelope(index, 10), indexLocator, expectedCutId: cutId, expectedDumpHashSha256: dumpHashSha256,
      key, keyId, readPartEnvelope: async (locator) => envelopes.get(locator)!, onChunk: () => undefined
    })).rejects.toThrow("BACKUP_DATABASE_PART_ENVELOPE_MISMATCH");
    envelopes.set(firstLocator, original);

    const reordered = { ...index, parts: [parts[1], parts[0], parts[2]] } as DatabaseChunkIndex;
    await expect(restoreDatabaseDumpFromChunkIndex({
      indexEnvelope: indexEnvelope(reordered, 11), indexLocator, expectedCutId: cutId, expectedDumpHashSha256: dumpHashSha256,
      key, keyId, readPartEnvelope: async (locator) => envelopes.get(locator)!, onChunk: () => undefined
    })).rejects.toThrow(/BACKUP_DATABASE_(PART_INDEX|INDEX_ORDER)_INVALID/);

    const drifted = { ...index, dumpHashSha256: "0".repeat(64) };
    await expect(restoreDatabaseDumpFromChunkIndex({
      indexEnvelope: indexEnvelope(drifted, 12), indexLocator, expectedCutId: cutId, expectedDumpHashSha256: "0".repeat(64),
      key, keyId, readPartEnvelope: async (locator) => envelopes.get(locator)!, onChunk: () => undefined
    })).rejects.toThrow("BACKUP_DATABASE_OVERALL_DIGEST_MISMATCH");
  });
});

function artifacts(planDigest = planDigestSha256, now = Date.now()) {
  const sourceToken = "synthetic-source-read-token";
  const r2AccessKeyId = "synthetic-r2-access-id";
  const r2SecretAccessKey = "synthetic-r2-secret";
  const key = Buffer.alloc(32, 5);
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const publicKeyPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const publicKeySha256 = sha256Hex(pair.publicKey.export({ type: "spki", format: "der" }));
  const providerBinding = {
    version: R2_PROVIDER_BINDING_VERSION,
    targetSha256: targetBindingSha256(target),
    planDigestSha256: planDigest,
    projectRef: target.projectRef,
    source: {
      origin: target.supabaseOrigin, bucket: "private", credentialKind: "supabase-private-storage-read-token/v1",
      tokenSha256: sha256Hex(sourceToken)
    },
    destination: destination(),
    r2Credential: {
      kind: "r2-bucket-object-read-write/v1", bucket: destination().bucket,
      permissions: ["object_read", "object_write"], accessKeyIdSha256: sha256Hex(r2AccessKeyId),
      secretAccessKeySha256: sha256Hex(r2SecretAccessKey)
    },
    encryption: { mode: "CUSTOMER_MANAGED", algorithm: "AES-256-GCM", keyId: "user-key-v1", keySha256: sha256Hex(key) },
    koyeb: {
      serviceId: "service_123", revisionId: "revision_123", producerArtifactDigestSha256: "8".repeat(64),
      signerPublicKeySha256: publicKeySha256
    },
    issuedAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now + 30 * 60_000).toISOString()
  };
  const providerBindingSha256 = canonicalSha256(providerBinding);
  const encryptionKeyArtifact = {
    version: BACKUP_ENCRYPTION_KEY_VERSION,
    targetSha256: targetBindingSha256(target), providerBindingSha256, keyId: "user-key-v1",
    keyMaterialBase64: key.toString("base64"), keySha256: sha256Hex(key),
    issuedAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now + 60 * 60_000).toISOString()
  };
  const payload = {
    version: WRITE_BLOCK_RECEIPT_VERSION,
    environmentId: target.environmentId, projectRef: target.projectRef, targetSha256: targetBindingSha256(target),
    releaseGitSha: target.releaseGitSha, koyebServiceId: "service_123", koyebRevisionId: "revision_123",
    traffic: "BLOCKED", writes: "BLOCKED", inFlight: 0, pending: 0, creating: 0,
    issuedAt: new Date(now - 10_000).toISOString(), expiresAt: new Date(now + 5 * 60_000).toISOString(),
    producerArtifactDigestSha256: "8".repeat(64), signerPublicKeySha256: publicKeySha256
  };
  const signature = sign("sha256", Buffer.from(canonicalJson(payload)), pair.privateKey).toString("base64url");
  const signed = { ...payload, signature };
  const writeBlockReceipt = { ...signed, receiptDigestSha256: canonicalSha256(signed) };
  return {
    providerBinding, encryptionKeyArtifact, writeBlockReceipt, publicKeyPem, publicKeySha256,
    sourceToken, r2AccessKeyId, r2SecretAccessKey,
    outputRoot: mkdtempSync(path.join(os.tmpdir(), "r2-backup-direct-"))
  };
}

function directInput(
  fixture: ReturnType<typeof artifacts>,
  counters: { prisma: number; source: number; dump: number; r2: number },
  options: { alwaysFound?: boolean } = {}
) {
  const objects = new Map<string, Uint8Array>();
  let nonceCounter = 0;
  const r2: R2ObjectIo = {
    inspect: async (key) => options.alwaysFound || objects.has(key) ? "FOUND" : "MISSING",
    putNoOverwrite: async (key, body) => {
      if (objects.has(key)) throw new Error("BACKUP_R2_NO_OVERWRITE_VIOLATION");
      counters.r2 += 1;
      objects.set(key, Buffer.from(body));
    },
    read: async (key) => Buffer.from(objects.get(key) ?? [])
  };
  return {
    target,
    cutId,
    bucket: "private",
    destination: destination(),
    planDigestSha256: fixture.providerBinding.planDigestSha256,
    providerBinding: fixture.providerBinding,
    confirmProviderBindingSha256: canonicalSha256(fixture.providerBinding),
    encryptionKeyArtifact: fixture.encryptionKeyArtifact,
    confirmEncryptionKeySha256: canonicalSha256(fixture.encryptionKeyArtifact),
    writeBlockReceipt: fixture.writeBlockReceipt,
    confirmWriteBlockReceiptSha256: fixture.writeBlockReceipt.receiptDigestSha256,
    writeBlockPublicKeyPem: fixture.publicKeyPem,
    confirmWriteBlockPublicKeySha256: fixture.publicKeySha256,
    databaseUrl: `postgresql://postgres:synthetic@${target.database.host}:5432/postgres?sslmode=verify-full`,
    pgDumpExecutable: process.platform === "win32" ? "C:\\tools\\pg_dump.exe" : "/usr/bin/pg_dump",
    outputRoot: fixture.outputRoot,
    sourceToken: fixture.sourceToken,
    r2AccessKeyId: fixture.r2AccessKeyId,
    r2SecretAccessKey: fixture.r2SecretAccessKey,
    dependencies: {
      createPrismaIo: async () => { counters.prisma += 1; return prismaIo(counters); },
      databaseChunkBytes: 4,
      createR2Io: async () => r2,
      inspectSourceObject: async () => ({ byteSize: 3 }),
      readSourceBody: async () => { counters.source += 1; return Buffer.from("abc"); },
      runPgDump: async ({ outputFile }: { outputFile: string }) => { counters.dump += 1; writeFileSync(outputFile, "synthetic dump"); },
      randomBytes: () => {
        nonceCounter += 1;
        const value = Buffer.alloc(12);
        value.writeUInt32BE(nonceCounter, 8);
        return value;
      }
    }
  };
}

function pgDumpInput(outputFile: string) {
  return {
    executable: process.platform === "win32" ? "C:\\tools\\pg_dump.exe" : "/usr/bin/pg_dump",
    target,
    password: "synthetic-password",
    outputFile
  };
}

function fakeWebBody(chunks: Uint8Array[]) {
  let cursor = 0;
  const cancel = vi.fn(async () => undefined);
  const releaseLock = vi.fn();
  return {
    cancel,
    body: {
      cancel,
      getReader: () => ({
        read: async () => cursor < chunks.length
          ? { done: false as const, value: chunks[cursor++] }
          : { done: true as const, value: undefined },
        cancel,
        releaseLock
      })
    }
  };
}

function fakeAsyncBody(chunks: Uint8Array[]) {
  let cursor = 0;
  const returnIterator = vi.fn(async () => ({ done: true as const, value: undefined }));
  const destroy = vi.fn();
  return {
    returnIterator,
    destroy,
    body: {
      destroy,
      [Symbol.asyncIterator]: () => ({
        next: async () => cursor < chunks.length
          ? { done: false as const, value: chunks[cursor++] }
          : { done: true as const, value: undefined },
        return: returnIterator
      })
    }
  };
}

function fakeSpawn(
  onSpawn: (
    child: ChildProcess,
    command: string,
    args: readonly string[],
    options: Record<string, unknown>
  ) => void
): typeof spawn {
  return ((command: string, args: readonly string[], options: Record<string, unknown>) => {
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, {
      pid: 4242,
      stderr: new PassThrough(),
      kill: vi.fn(() => true)
    });
    queueMicrotask(() => onSpawn(child, command, args, options));
    return child;
  }) as unknown as typeof spawn;
}

function prismaIo(_counters: { prisma: number }) {
  const body = Buffer.from("abc");
  return {
    assertIdentity: async () => undefined,
    databaseState: async () => ({
      watermark: "0/123", migrationHistoryDigestSha256: "d".repeat(64), kpiDigestSha256: "e".repeat(64)
    }),
    listReferenceRows: async () => [{
      model: "UploadBatch" as const,
      recordId: "11111111-1111-4111-8111-111111111111",
      field: "storedFilePath" as const,
      key: "uploads/synthetic.csv",
      hashSha256: createHash("sha256").update(body).digest("hex"),
      state: "IMPORTED"
    }],
    disconnect: async () => undefined
  };
}

function destination(): BackupDestination {
  const accountId = "a".repeat(32);
  return {
    provider: "CLOUDFLARE_R2", destinationId: "independent-r2-backup", accountId, bucket: "private-backup",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`, region: "auto", publicAccess: "PRIVATE",
    residencyGuarantee: "NONE", encryption: "CUSTOMER_MANAGED", keyCustodyReference: "user-key-v1",
    retentionUntil: "2026-10-02T00:00:00.000Z", retentionDays: 30, retentionApproval: "NOT_APPROVED",
    independentFromSourceProject: true
  };
}
