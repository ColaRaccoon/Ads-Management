import { createHash, createPublicKey, verify } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";

const [publicKeyPath, evidencePath, expectedType] = process.argv.slice(2);
if (!publicKeyPath || !evidencePath || !new Set(["backup-latest", "backup-signer-authorization", "backup-schedule-authorization", "restore-verification", "release-compatibility", "legacy-quiesce", "database-rollback", "edge-drain"]).has(expectedType)) fail();

try {
  for (const candidate of [publicKeyPath, evidencePath]) {
    const stat = lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) fail();
  }
  const keyBytes = readFileSync(publicKeyPath);
  const evidenceBytes = readFileSync(evidencePath);
  if (keyBytes.length < 32 || keyBytes.length > 16_384 || evidenceBytes.length === 0 || evidenceBytes.length > 1_048_576) fail();
  const evidence = JSON.parse(evidenceBytes.toString("utf8"));
  if (!plainObject(evidence) || evidence.attestationType !== expectedType ||
      !/^[0-9a-f]{64}$/.test(evidence.signingKeyId ?? "") ||
      !/^[A-Za-z0-9_-]{80,128}$/.test(evidence.attestationSignature ?? "")) fail();
  const publicKey = createPublicKey(keyBytes);
  if (publicKey.asymmetricKeyType !== "ed25519") fail();
  const publicDer = publicKey.export({ type: "spki", format: "der" });
  if (createHash("sha256").update(publicDer).digest("hex") !== evidence.signingKeyId) fail();
  const unsigned = { ...evidence };
  delete unsigned.signingKeyId;
  delete unsigned.attestationSignature;
  if (!verify(null, Buffer.from(canonicalJson(unsigned), "utf8"), publicKey, Buffer.from(evidence.attestationSignature, "base64url"))) fail();
  process.stdout.write('{"result":"PASS"}\n');
} catch {
  fail();
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (plainObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function plainObject(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
function fail() { process.stderr.write('{"result":"FAIL"}\n'); process.exit(1); }
