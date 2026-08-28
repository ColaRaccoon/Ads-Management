import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("backup, restore, and quiesce attestations accept only their distinct pinned public key",async()=>{
  const root=await mkdtemp(path.join(tmpdir(),"attestation-keys-"));
  const signer=path.join(import.meta.dirname,"sign-attestation.mjs");const verifier=path.join(import.meta.dirname,"verify-attestation.mjs");
  const domains=["backup-signer-authorization","backup-schedule-authorization","restore-verification","legacy-quiesce"];
  const keys=[];
  for(const domain of domains){
    const pair=generateKeyPairSync("ed25519");const privatePath=path.join(root,`${domain}.private.pem`);const publicPath=path.join(root,`${domain}.public.pem`);const unsignedPath=path.join(root,`${domain}.unsigned.json`);const signedPath=path.join(root,`${domain}.signed.json`);
    await writeFile(privatePath,pair.privateKey.export({type:"pkcs8",format:"pem"}));await writeFile(publicPath,pair.publicKey.export({type:"spki",format:"pem"}));await writeFile(unsignedPath,JSON.stringify({attestationType:domain,version:1,result:"PASS"}));
    const signed=spawnSync(process.execPath,[signer,privatePath,unsignedPath,signedPath],{encoding:"utf8"});assert.equal(signed.status,0,signed.stderr);keys.push({domain,publicPath,signedPath});
  }
  for(let index=0;index<keys.length;index++){
    const own=spawnSync(process.execPath,[verifier,keys[index].publicPath,keys[index].signedPath,keys[index].domain],{encoding:"utf8"});assert.equal(own.status,0,own.stderr);
    const cross=spawnSync(process.execPath,[verifier,keys[(index+1)%keys.length].publicPath,keys[index].signedPath,keys[index].domain],{encoding:"utf8"});assert.notEqual(cross.status,0);assert.match(cross.stderr,/"result":"FAIL"/);
  }
});
