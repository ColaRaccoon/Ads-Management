import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadBootstrapMutationAuthorization } from "./bootstrap-authorization";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("local bootstrap authorization", () => {
  it("binds exact evidence and consumes a signed instance atomically without recording the username", async () => {
    const fixture = await authorizationFixture();
    const loaded = loadBootstrapMutationAuthorization(fixture.input);
    expect(loaded.username).toBe("local.admin");
    loaded.consume();

    await expect(readFile(fixture.requestPath)).rejects.toMatchObject({ code: "ENOENT" });
    const ledger = await readFile(fixture.ledgerPath, "utf8");
    expect(ledger).not.toContain("local.admin");
    expect(JSON.parse(ledger)).toMatchObject({
      authorizationType: "local-bootstrap-authorization",
      mode: "bootstrap",
      usernameSha256: sha256(Buffer.from("local.admin"))
    });
    expect(() => loaded.consume()).toThrow("BOOTSTRAP_AUTHORIZATION_REPLAY_REJECTED");

    await writeFile(fixture.requestPath, JSON.stringify({ version: 1, username: "local.admin" }), { flag: "wx", mode: 0o600 });
    const replay = loadBootstrapMutationAuthorization(fixture.input);
    expect(() => replay.consume()).toThrow("BOOTSTRAP_AUTHORIZATION_REPLAY_REJECTED");
  });

  it("rejects expiry and any runtime/filesystem/evidence drift before mutation", async () => {
    const expired = await authorizationFixture({ issuedAt: Date.now() - 20 * 60_000, expiresAt: Date.now() - 10 * 60_000 });
    expect(() => loadBootstrapMutationAuthorization(expired.input)).toThrow("BOOTSTRAP_AUTHORIZATION_EXPIRED");

    const drifted = await authorizationFixture();
    await writeFile(drifted.filesystemPath, `${await readFile(drifted.filesystemPath, "utf8")} `);
    expect(() => loadBootstrapMutationAuthorization(drifted.input)).toThrow("BOOTSTRAP_FILESYSTEM_EVIDENCE_INVALID");
  });

  it("removes username argv support from the production bootstrap CLI", async () => {
    const cli = await readFile(path.join(__dirname, "bootstrap-local-super-admin.cli.ts"), "utf8");
    expect(cli).not.toContain('requiredArgument(args, "username")');
    expect(cli).toContain('name === "username"');
    expect(cli).toContain("BOOTSTRAP_USERNAME_ARGV_FORBIDDEN");
    expect(cli).toContain('requiredArgument(args, "bootstrap-request-file")');
    expect(cli).toContain("loadBootstrapMutationAuthorization");
  });
});

async function authorizationFixture(time: { issuedAt?: number; expiresAt?: number } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "bootstrap-auth-")); roots.push(root);
  const dataRoot = path.join(root, "data"), adminRoot = path.join(dataRoot, "bootstrap-handoff"), sharedRoot = path.join(root, "shared");
  await mkdir(adminRoot, { recursive: true }); await mkdir(sharedRoot, { recursive: true });
  const requestPath = path.join(adminRoot, "request.json"), tokenPath = path.join(adminRoot, "token.json");
  const authorizationPath = path.join(adminRoot, "authorization.json"), ledgerPath = path.join(adminRoot, "authorization.consumed");
  const publicKeyPath = path.join(sharedRoot, "bootstrap-authorization-public.pem");
  const runtimePath = path.join(root, "runtime.json"), filesystemPath = path.join(root, "filesystem.json"), boundaryPath = path.join(root, "boundary.json");
  const requestBytes = Buffer.from(JSON.stringify({ version: 1, username: "local.admin" }));
  await writeFile(requestPath, requestBytes, { mode: 0o600 });
  const filesystem = {
    result: "PASS", exactAcl: true, dataRoot, descriptorDigest: "d".repeat(64),
    classRoots: { ADMIN_ONLY: [adminRoot], SHARED_RUNTIME: [sharedRoot] }, completedAt: new Date().toISOString()
  };
  const filesystemBytes = Buffer.from(JSON.stringify(filesystem)); await writeFile(filesystemPath, filesystemBytes);
  const runtime = {
    database: { provider: "supabase_postgres", projectRef: "abcdefghijklmnopqrst", connectionMode: "direct", host: "db.abcdefghijklmnopqrst.supabase.co", port: 5432, name: "postgres", schema: "public", boundaryEvidencePath: boundaryPath },
    data: { root: dataRoot }, release: { id: "release-20260828" }, hostSecurity: { filesystemEvidencePath: filesystemPath }
  };
  const runtimeBytes = Buffer.from(JSON.stringify(runtime)); await writeFile(runtimePath, runtimeBytes);
  const boundaryBytes = Buffer.from(JSON.stringify({ version: 6, result: "PASS" })); await writeFile(boundaryPath, boundaryBytes);
  const pair = generateKeyPairSync("ed25519");
  const publicBytes = pair.publicKey.export({ type: "spki", format: "pem" }); await writeFile(publicKeyPath, publicBytes);
  const issuedAt = time.issuedAt ?? Date.now() - 1_000, expiresAt = time.expiresAt ?? Date.now() + 9 * 60_000;
  const unsigned = {
    attestationType: "local-bootstrap-authorization", version: 1, result: "APPROVED", mode: "bootstrap",
    usernameSha256: sha256(Buffer.from("local.admin")), requestSha256: sha256(requestBytes),
    runtimeConfigPathSha256: pathSha256(runtimePath), runtimeConfigSha256: sha256(runtimeBytes),
    filesystemEvidenceSha256: sha256(filesystemBytes), filesystemDescriptorDigest: filesystem.descriptorDigest,
    databaseBoundaryEvidenceSha256: sha256(boundaryBytes), databaseProjectRef: runtime.database.projectRef,
    databaseConnectionMode: runtime.database.connectionMode, databaseHost: runtime.database.host, databasePort: 5432,
    databaseName: runtime.database.name, databaseSchema: runtime.database.schema, releaseId: runtime.release.id,
    setupTokenOutputPathSha256: pathSha256(tokenPath), ledgerPathSha256: pathSha256(ledgerPath),
    maintenanceEvidenceSha256: null, drainEvidenceSha256: null, prechangeBackupEvidenceSha256: null,
    authorizationNonce: "a".repeat(64), authorizationInstanceId: "12345678-1234-4123-8123-123456789abc",
    authorizationIssuedAt: new Date(issuedAt).toISOString(), authorizationExpiresAt: new Date(expiresAt).toISOString(),
    signingKeyId: sha256(pair.publicKey.export({ type: "spki", format: "der" }))
  };
  const authorizationBytes = Buffer.from(JSON.stringify({ ...unsigned, attestationSignature: sign(null, Buffer.from(canonicalJson(unsigned)), pair.privateKey).toString("base64url") }));
  await writeFile(authorizationPath, authorizationBytes, { mode: 0o600 });
  return {
    requestPath, ledgerPath, filesystemPath,
    input: {
      mode: "bootstrap" as const, requestPath, expectedRequestSha256: sha256(requestBytes), authorizationPath,
      expectedAuthorizationSha256: sha256(authorizationBytes), authorizationPublicKeyPath: publicKeyPath,
      expectedAuthorizationPublicKeySha256: sha256(Buffer.from(publicBytes)), ledgerPath, runtimeConfigPath: runtimePath,
      expectedRuntimeConfigSha256: sha256(runtimeBytes), filesystemEvidencePath: filesystemPath,
      expectedFilesystemEvidenceSha256: sha256(filesystemBytes), expectedFilesystemDescriptorDigest: filesystem.descriptorDigest,
      databaseBoundaryEvidencePath: boundaryPath, expectedDatabaseBoundaryEvidenceSha256: sha256(boundaryBytes),
      setupTokenOutputPath: tokenPath, maintenanceEvidenceSha256: null, drainEvidenceSha256: null,
      prechangeBackupEvidenceSha256: null, database: { projectRef: runtime.database.projectRef, connectionMode: "direct" as const,
        host: runtime.database.host, port: 5432, name: runtime.database.name, schema: runtime.database.schema },
      releaseId: runtime.release.id, dataRoot
    }
  };
}

function pathSha256(value: string) { const normalized = path.resolve(value).replace(/[\\/]+$/, ""); return sha256(Buffer.from(process.platform === "win32" ? normalized.toLowerCase() : normalized)); }
function sha256(value: Buffer) { return createHash("sha256").update(value).digest("hex"); }
function canonicalJson(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`; if (value && typeof value === "object") { const object = value as Record<string, unknown>; return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`; } return JSON.stringify(value) ?? "null"; }
