import assert from "node:assert/strict";
import test from "node:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
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

test("edge drain accepts only its Edge key and rejects a cross-domain key",async()=>{
  const root=await mkdtemp(path.join(tmpdir(),"edge-drain-key-"));const verifier=path.join(import.meta.dirname,"verify-attestation.mjs");const edge=generateKeyPairSync("ed25519"),other=generateKeyPairSync("ed25519");
  const publicPath=path.join(root,"edge.public.pem"),otherPath=path.join(root,"other.public.pem"),evidencePath=path.join(root,"edge-drain.json");const publicDer=edge.publicKey.export({type:"spki",format:"der"});
  await writeFile(publicPath,edge.publicKey.export({type:"spki",format:"pem"}));await writeFile(otherPath,other.publicKey.export({type:"spki",format:"pem"}));
  const unsigned={attestationType:"edge-drain",version:2,result:"DRAINED",processId:1234,releaseId:"release-test",runtimeConfigSha256:"a".repeat(64),nodeExecutableSha256:"b".repeat(64),listenerAddress:"192.168.10.20",listenerPort:443,activeRequests:0,completedAt:"2026-08-28T00:00:00.000Z"};
  const evidence={...unsigned,signingKeyId:createHash("sha256").update(publicDer).digest("hex"),attestationSignature:sign(null,Buffer.from(canonicalJson(unsigned),"utf8"),edge.privateKey).toString("base64url")};await writeFile(evidencePath,JSON.stringify(evidence));
  assert.equal(spawnSync(process.execPath,[verifier,publicPath,evidencePath,"edge-drain"],{encoding:"utf8"}).status,0);assert.notEqual(spawnSync(process.execPath,[verifier,otherPath,evidencePath,"edge-drain"],{encoding:"utf8"}).status,0);
});

function canonicalJson(value){if(Array.isArray(value))return`[${value.map(canonicalJson).join(",")}]`;if(value&&typeof value==="object")return`{${Object.keys(value).sort().map((key)=>`${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;return JSON.stringify(value)}
