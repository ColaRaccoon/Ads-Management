import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const generator = path.join(import.meta.dirname, "new-backup-schedule-authorization.mjs");
const verifier = path.join(import.meta.dirname, "verify-attestation.mjs");

test("daily backup authorization v3 exactly binds secret, signer, and NAS helper fingerprints", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "backup-schedule-authorization-"));
  const pair = generateKeyPairSync("ed25519");
  const privatePath = path.join(root, "private.pem");
  const publicPath = path.join(root, "public.pem");
  const outputPath = path.join(root, "authorization.json");
  await writeFile(privatePath, pair.privateKey.export({ type:"pkcs8", format:"pem" }));
  await writeFile(publicPath, pair.publicKey.export({ type:"spki", format:"pem" }));
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.valueOf() + 30 * 86400_000);
  const values = ["1","2","3","4","5","6","7"].map((value) => value.repeat(64));
  const args = [privatePath,values[0],"Meta Ads Performance Daily Backup",issuedAt.toISOString(),expiresAt.toISOString(),"a".repeat(64),"12345678-1234-4123-8123-123456789abc",...values.slice(1),outputPath];
  const created = spawnSync(process.execPath, [generator,...args], { encoding:"utf8" });
  assert.equal(created.status, 0, created.stderr);
  const authorization = JSON.parse(await readFile(outputPath, "utf8"));
  assert.deepEqual(Object.keys(authorization).sort(), ["attestationSignature","attestationType","authorizationExpiresAt","authorizationInstanceId","authorizationIssuedAt","authorizationNonce","backupIntegrityKeySha256","backupReceiptPrivateKeySha256","contractSha256","nasIdentityHelperSha256","pgPassSha256","receiptPublisherSha256","result","semanticSignerSha256","signingKeyId","taskName","version"].sort());
  assert.equal(authorization.version, 3);
  assert.equal(authorization.pgPassSha256, values[1]);
  assert.equal(authorization.backupIntegrityKeySha256, values[2]);
  assert.equal(authorization.backupReceiptPrivateKeySha256, values[3]);
  assert.equal(authorization.receiptPublisherSha256, values[4]);
  assert.equal(authorization.semanticSignerSha256, values[5]);
  assert.equal(authorization.nasIdentityHelperSha256, values[6]);
  const verified = spawnSync(process.execPath, [verifier,publicPath,outputPath,"backup-schedule-authorization"], { encoding:"utf8" });
  assert.equal(verified.status, 0, verified.stderr);
});

test("daily backup authorization refuses an omitted pinned key fingerprint", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "backup-schedule-authorization-invalid-"));
  const pair = generateKeyPairSync("ed25519");
  const privatePath = path.join(root, "private.pem");
  await writeFile(privatePath, pair.privateKey.export({ type:"pkcs8", format:"pem" }));
  const now = new Date();
  const args = [privatePath,"1".repeat(64),"Meta Ads Performance Daily Backup",now.toISOString(),new Date(now.valueOf()+86400_000).toISOString(),"a".repeat(64),"12345678-1234-4123-8123-123456789abc","2".repeat(64),"3".repeat(64),"","5".repeat(64),"6".repeat(64),"7".repeat(64),path.join(root,"authorization.json")];
  const result = spawnSync(process.execPath, [generator,...args], { encoding:"utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SCHEDULE_AUTHORIZATION_ARGUMENTS_INVALID/);
});
