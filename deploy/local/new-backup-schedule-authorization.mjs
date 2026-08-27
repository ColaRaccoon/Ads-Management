import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const [privateKeyPath, contractSha256, taskName, issuedText, expiresText, outputPath] = process.argv.slice(2);
if (!privateKeyPath || !/^[0-9a-f]{64}$/.test(contractSha256 ?? "") || taskName !== "Meta Ads Performance Daily Backup" || !outputPath) fail("SCHEDULE_AUTHORIZATION_ARGUMENTS_INVALID");
const issued = new Date(issuedText), expires = new Date(expiresText), now = new Date();
if (!Number.isFinite(issued.valueOf()) || !Number.isFinite(expires.valueOf()) || expires <= issued || expires - issued > 31 * 86400_000 || issued > new Date(now.valueOf() + 5 * 60_000)) fail("SCHEDULE_AUTHORIZATION_WINDOW_INVALID");
const privateKey = createPrivateKey(readFileSync(privateKeyPath));
if (privateKey.asymmetricKeyType !== "ed25519") fail("SCHEDULE_AUTHORIZATION_PRIVATE_KEY_INVALID");
const value = { attestationType: "backup-schedule-authorization", version: 1, result: "APPROVED", taskName, contractSha256, authorizationIssuedAt: issued.toISOString(), authorizationExpiresAt: expires.toISOString() };
const signingKeyId = createHash("sha256").update(createPublicKey(privateKey).export({type:"spki",format:"der"})).digest("hex");
const attestationSignature = sign(null, Buffer.from(canonicalJson(value),"utf8"),privateKey).toString("base64url");
writeFileSync(outputPath,JSON.stringify({...value,signingKeyId,attestationSignature}),{flag:"wx",mode:0o600});
function canonicalJson(value){if(Array.isArray(value))return`[${value.map(canonicalJson).join(",")}]`;if(value&&typeof value==="object")return`{${Object.keys(value).sort().map((key)=>`${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;return JSON.stringify(value)}
function fail(code){throw new Error(code)}
