import assert from "node:assert/strict";
import test from "node:test";
import { createHash, createPublicKey, generateKeyPairSync } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { REQUIRED_RECOVERY_PURPOSES } from "./recovery-kit.mjs";

const password = "N7!pQ2@vL9#xR4$kT8%wY3&cF6*mS1^z";
test("recovery kit authenticates, binds config, and restores the exact required inventory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "recovery-kit-")), files = [];
  const pairs=new Map();
  for(const purpose of ["edge-signing","backup-receipt","restore-receipt"]){const pair=generateKeyPairSync("ed25519");pairs.set(`${purpose}-private-key`,pair.privateKey.export({type:"pkcs8",format:"pem"}));pairs.set(`${purpose}-public-key`,pair.publicKey.export({type:"spki",format:"pem"}))}
  for (const [index, purpose] of REQUIRED_RECOVERY_PURPOSES.entries()) {
    const itemPath = path.join(root, `secret-${index}.bin`), bytes = Buffer.from(pairs.get(purpose)??Buffer.alloc(64, index + 1)); await writeFile(itemPath, bytes);
    files.push({ purpose, name: `secret-${index}.bin`, path: itemPath, sha256: hash(bytes) });
  }
  const runtime = files.find((entry) => entry.purpose === "runtime-config"), manifest = path.join(root, "manifest.json"),
    kit = path.join(root, "kit.enc"), output = path.join(root, "output");
  const keyPairs=["edge-signing","backup-receipt","restore-receipt"].map((purpose)=>{const publicEntry=files.find((entry)=>entry.purpose===`${purpose}-public-key`),publicKey=createPublicKey(pairs.get(`${purpose}-public-key`));return{purpose,publicKeySha256:publicEntry.sha256,signingKeyId:hash(publicKey.export({type:"spki",format:"der"}))}});
  await writeFile(manifest, JSON.stringify({ version: 3, installId: "install-test-0001", runtimeConfigSha256: runtime.sha256, keyPairs, files }));
  const tool = path.join(import.meta.dirname, "recovery-kit.mjs");
  let run = spawnSync(process.execPath, [tool, "--mode=create", `--manifest=${manifest}`, `--output=${kit}`], { input: password, encoding: "utf8" }); assert.equal(run.status, 0, run.stderr);
  const created=JSON.parse(run.stdout);assert.equal(created.manifestSha256,hash(await readFile(manifest)));assert.equal(created.signingKeyPairsVerified,true);assert.equal(created.keyPairs.length,3);
  const corrupted=files.find((entry)=>entry.purpose==="edge-signing-private-key"),bad=Buffer.alloc(64,7);await writeFile(corrupted.path,bad);corrupted.sha256=hash(bad);const corruptManifest=path.join(root,"manifest-corrupt.json"),corruptKit=path.join(root,"kit-corrupt.enc");await writeFile(corruptManifest,JSON.stringify({version:3,installId:"install-test-0001",runtimeConfigSha256:runtime.sha256,keyPairs,files}));const rejected=spawnSync(process.execPath,[tool,"--mode=create",`--manifest=${corruptManifest}`,`--output=${corruptKit}`],{input:password,encoding:"utf8"});assert.notEqual(rejected.status,0);assert.match(rejected.stderr,/KIT_KEY_PAIR_INVALID/);
  await rm(manifest);for(const entry of files)await rm(entry.path);
  run = spawnSync(process.execPath, [tool, "--mode=verify", `--kit=${kit}`], { input: password, encoding: "utf8" }); assert.equal(run.status, 0, run.stderr);
  const verified=JSON.parse(run.stdout);assert.equal(verified.manifestSha256,created.manifestSha256);assert.equal(verified.signingKeyPairsVerified,true);assert.equal(verified.files.length,REQUIRED_RECOVERY_PURPOSES.length);assert.ok(verified.files.every((entry)=>!Object.hasOwn(entry,"path")&&Object.keys(entry).sort().join("|")==="name|purpose|sha256"));
  await mkdir(output); run = spawnSync(process.execPath, [tool, "--mode=extract", `--kit=${kit}`, `--output-root=${output}`], { input: password, encoding: "utf8" }); assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(await readFile(path.join(output, "secret-1.bin")), Buffer.alloc(64, 2));
  run = spawnSync(process.execPath, [tool, "--mode=verify", `--kit=${kit}`], { input: "wrong-passphrase-with-many-unique-characters-123!", encoding: "utf8" }); assert.notEqual(run.status, 0);
});
test("recovery kit rejects incomplete inventory and low-diversity passphrases", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "recovery-kit-invalid-")), manifest = path.join(root, "manifest.json"), kit = path.join(root, "kit.enc");
  await writeFile(manifest, JSON.stringify({ version: 3, installId: "install-test-0002", runtimeConfigSha256: "0".repeat(64), keyPairs:[], files: [] }));
  const tool = path.join(import.meta.dirname, "recovery-kit.mjs");
  let run = spawnSync(process.execPath, [tool, "--mode=create", `--manifest=${manifest}`, `--output=${kit}`], { input: password, encoding: "utf8" }); assert.notEqual(run.status, 0);
  run = spawnSync(process.execPath, [tool, "--mode=create", `--manifest=${manifest}`, `--output=${kit}`], { input: "a".repeat(64), encoding: "utf8" }); assert.notEqual(run.status, 0);
});
test("recovery kit rejects an oversized sparse envelope before reading it",async()=>{
  const root=await mkdtemp(path.join(tmpdir(),"recovery-kit-oversized-")),kit=path.join(root,"kit.enc");await writeFile(kit,"");await truncate(kit,16*1024*1024+1);
  const run=spawnSync(process.execPath,[path.join(import.meta.dirname,"recovery-kit.mjs"),"--mode=verify",`--kit=${kit}`],{input:password,encoding:"utf8"});assert.notEqual(run.status,0);assert.match(run.stderr,/KIT_SIZE_INVALID/);
});
function hash(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
