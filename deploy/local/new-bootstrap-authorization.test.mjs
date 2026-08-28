import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./new-bootstrap-authorization.mjs", import.meta.url));

test("bootstrap authorization producer signs exact digests without username argv or output", () => {
  const root = mkdtempSync(path.join(tmpdir(), "bootstrap-authorization-producer-"));
  try {
    const username = "local.operator";
    const request = file(root, "request.json", JSON.stringify({ version: 1, username }));
    const filesystem = file(root, "filesystem.json", JSON.stringify({
      result: "PASS", exactAcl: true, descriptorDigest: "a".repeat(64)
    }));
    const boundary = file(root, "boundary.json", JSON.stringify({ version: 6, result: "PASS" }));
    const runtime = file(root, "runtime.json", JSON.stringify({
      database: {
        provider: "supabase_postgres", projectRef: "abcdefghijklmnopqrst", connectionMode: "direct",
        host: "db.example.invalid", port: 5432, name: "postgres", schema: "public", boundaryEvidencePath: boundary
      },
      release: { id: "release-1" },
      hostSecurity: { filesystemEvidencePath: filesystem }
    }));
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const privateKeyPath = file(root, "authorization-private.pem", privateKey.export({ type: "pkcs8", format: "pem" }));
    const output = path.join(root, "authorization.json");
    const tokenOutput = path.join(root, "bootstrap-handoff", "token.json");
    const ledger = path.join(root, "ledger", "consumed.json");
    const argumentsList = [
      "--mode=bootstrap", `--request=${request}`, `--runtime-config=${runtime}`,
      `--filesystem-evidence=${filesystem}`, `--database-boundary-evidence=${boundary}`,
      `--setup-token-output=${tokenOutput}`, `--ledger=${ledger}`,
      `--private-key=${privateKeyPath}`, `--output=${output}`
    ];
    assert.equal(argumentsList.some((value) => value.startsWith("--username=")), false);
    const result = spawnSync(process.execPath, [script, ...argumentsList], { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout.includes(username), false);
    assert.equal(result.stdout.includes(root), false);

    const authorization = JSON.parse(readFileSync(output, "utf8"));
    assert.deepEqual(Object.keys(authorization).sort(), AUTHORIZATION_KEYS);
    assert.equal(authorization.usernameSha256, sha256(Buffer.from(username)));
    assert.equal(authorization.requestSha256, sha256(readFileSync(request)));
    assert.equal(authorization.runtimeConfigSha256, sha256(readFileSync(runtime)));
    assert.equal(authorization.filesystemEvidenceSha256, sha256(readFileSync(filesystem)));
    assert.equal(authorization.databaseBoundaryEvidenceSha256, sha256(readFileSync(boundary)));
    const signature = authorization.attestationSignature;
    delete authorization.attestationSignature;
    assert.equal(verify(null, Buffer.from(canonicalJson(authorization)), publicKey, Buffer.from(signature, "base64url")), true);
    assert.equal(
      authorization.signingKeyId,
      sha256(createPublicKey(createPrivateKey(readFileSync(privateKeyPath))).export({ type: "spki", format: "der" }))
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bootstrap authorization producer rejects username argv before reading files", () => {
  const marker = "forbidden.operator";
  const result = spawnSync(process.execPath, [script, `--username=${marker}`], { encoding: "utf8", windowsHide: true });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout.includes(marker), false);
  assert.equal(result.stderr.includes(marker), false);
});

function file(root, name, content) {
  const value = path.join(root, name);
  writeFileSync(value, content, { flag: "wx", mode: 0o600 });
  return value;
}

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const AUTHORIZATION_KEYS = [
  "attestationSignature", "attestationType", "authorizationExpiresAt", "authorizationInstanceId",
  "authorizationIssuedAt", "authorizationNonce", "databaseBoundaryEvidenceSha256", "databaseConnectionMode",
  "databaseHost", "databaseName", "databasePort", "databaseProjectRef", "databaseSchema", "drainEvidenceSha256",
  "filesystemDescriptorDigest", "filesystemEvidenceSha256", "ledgerPathSha256", "maintenanceEvidenceSha256",
  "mode", "prechangeBackupEvidenceSha256", "releaseId", "requestSha256", "result", "runtimeConfigPathSha256",
  "runtimeConfigSha256", "setupTokenOutputPathSha256", "signingKeyId", "usernameSha256", "version"
].sort();
