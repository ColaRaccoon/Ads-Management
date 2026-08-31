import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const [privateKeyPath, inputPath, outputPath] = process.argv.slice(2);
if (!privateKeyPath || !inputPath || !outputPath) throw new Error("ATTESTATION_SIGNER_ARGUMENTS_REQUIRED");
const inputBytes = readFileSync(inputPath);
if (inputBytes.length === 0 || inputBytes.length > 1_048_576) throw new Error("ATTESTATION_INPUT_SIZE_INVALID");
const value = JSON.parse(inputBytes.toString("utf8"));
if (!plainObject(value) || "signingKeyId" in value || "attestationSignature" in value ||
    !new Set(["backup-signer-authorization", "backup-schedule-authorization", "restore-verification", "release-compatibility", "legacy-quiesce", "database-rollback"]).has(value.attestationType)) {
  throw new Error("ATTESTATION_INPUT_INVALID");
}
const privateKey = createPrivateKey(readFileSync(privateKeyPath));
if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("ATTESTATION_PRIVATE_KEY_INVALID");
const publicDer = createPublicKey(privateKey).export({ type: "spki", format: "der" });
const signingKeyId = createHash("sha256").update(publicDer).digest("hex");
const canonical = canonicalJson(value);
const attestationSignature = sign(null, Buffer.from(canonical, "utf8"), privateKey).toString("base64url");
writeFileSync(outputPath, JSON.stringify({ ...value, signingKeyId, attestationSignature }), { flag: "wx", mode: 0o600 });

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (plainObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function plainObject(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
