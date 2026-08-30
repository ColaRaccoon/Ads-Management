import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, randomBytes, scryptSync, sign, verify } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REQUIRED_RECOVERY_PURPOSES = Object.freeze([
  "api-config", "runtime-config", "edge-signing-private-key", "edge-signing-public-key",
  "backup-receipt-private-key", "backup-receipt-public-key", "restore-receipt-private-key", "restore-receipt-public-key",
  "backup-integrity-key", "offline-ca-pfx", "offline-ca-pfx-password",
  "postgres-admin-pgpass", "postgres-migration-pgpass", "postgres-backup-pgpass",
  "postgres-restore-pgpass", "postgres-runtime-pgpass"
]);
const KEY_PAIR_PURPOSES=Object.freeze([
  ["edge-signing","edge-signing-private-key","edge-signing-public-key"],
  ["backup-receipt","backup-receipt-private-key","backup-receipt-public-key"],
  ["restore-receipt","restore-receipt-private-key","restore-receipt-public-key"]
]);
let args;
let passphrase;
if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  args = new Map(process.argv.slice(2).map((argument) => {
    const separator = argument.indexOf("=");
    if (!argument.startsWith("--") || separator < 3) fail("ARGUMENT_INVALID");
    return [argument.slice(2, separator), argument.slice(separator + 1)];
  }));
  const mode = args.get("mode");
  passphrase = await readPassphrase();
  try {
    if (mode === "create") createKit();
    else if (mode === "verify") verifyKit(false);
    else if (mode === "extract") verifyKit(true);
    else fail("MODE_INVALID");
  } finally { passphrase.fill(0); }
}

function createKit() {
  const manifestPath = required("manifest"), output = required("output");
  const stat = lstatSync(manifestPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65_536) fail("KIT_MANIFEST_INVALID");
  const manifestBytes = readFileSync(manifestPath), manifest = parseJson(manifestBytes.toString("utf8"), "KIT_MANIFEST_INVALID");
  assertInventory(manifest, false);
  const names = new Set(); let total = 0;
  const files = manifest.files.map((entry) => {
    if (names.has(entry.name)) fail("KIT_ENTRY_DUPLICATE"); names.add(entry.name);
    assertCanonicalPath(entry.path);
    const item = lstatSync(entry.path);
    if (!item.isFile() || item.isSymbolicLink() || item.size < 1 || item.size > 1_048_576) fail("KIT_ENTRY_INVALID");
    const bytes = readFileSync(entry.path); total += bytes.length;
    if (total > 8_388_608) fail("KIT_SIZE_LIMIT");
    const digest = sha256(bytes); if (digest !== entry.sha256) fail("KIT_DECLARED_HASH_MISMATCH");
    return { purpose: entry.purpose, name: entry.name, sha256: digest, bytes: bytes.toString("base64") };
  });
  const keyPairs = recoveryKeyPairs(files);assertDeclaredKeyPairs(manifest.keyPairs,keyPairs,"KIT_MANIFEST_KEY_PAIR_INVALID");
  const payload = Buffer.from(JSON.stringify({ version: 3, installId: manifest.installId,
    runtimeConfigSha256: manifest.runtimeConfigSha256, manifestSha256: sha256(manifestBytes), keyPairs, createdAt: new Date().toISOString(), files }), "utf8");
  const salt = randomBytes(32), iv = randomBytes(12), key = deriveKey(salt);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
    const envelope = { version: 2, kdf: "scrypt-N65536-r8-p1", cipher: "aes-256-gcm",
      salt: salt.toString("base64url"), iv: iv.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"), ciphertext: ciphertext.toString("base64") };
    writeFileSync(output, JSON.stringify(envelope), { encoding: "utf8", flag: "wx", mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ event: "recovery-kit.created", fileCount: files.length,
      inventoryDigest: inventoryDigest(files), kitId: sha256(Buffer.from(JSON.stringify(envelope))),
      installId: manifest.installId, runtimeConfigSha256: manifest.runtimeConfigSha256,
      manifestSha256: sha256(manifestBytes), signingKeyPairInventoryDigest:keyPairDigest(keyPairs), signingKeyPairsVerified:true, keyPairs })}\n`);
  } finally { key.fill(0); payload.fill(0); }
}

function verifyKit(extract) {
  const kitPath = required("kit"), before=lstatSync(kitPath);
  if(!before.isFile()||before.isSymbolicLink()||before.size<256||before.size>16*1024*1024)fail("KIT_SIZE_INVALID");
  const bytes = readFileSync(kitPath), after=lstatSync(kitPath);
  if(bytes.length!==before.size||!after.isFile()||after.isSymbolicLink()||after.size!==before.size||after.mtimeMs!==before.mtimeMs)fail("KIT_SIZE_INVALID");
  const envelope = parseJson(bytes.toString("utf8"), "KIT_ENVELOPE_INVALID");
  if (envelope.version !== 2 || envelope.kdf !== "scrypt-N65536-r8-p1" || envelope.cipher !== "aes-256-gcm" ||
      !/^[A-Za-z0-9_-]{43}$/.test(envelope.salt ?? "") || !/^[A-Za-z0-9_-]{16}$/.test(envelope.iv ?? "") ||
      !/^[A-Za-z0-9_-]{22}$/.test(envelope.tag ?? "") || typeof envelope.ciphertext !== "string") fail("KIT_ENVELOPE_INVALID");
  const salt = Buffer.from(envelope.salt, "base64url"), iv = Buffer.from(envelope.iv, "base64url"),
    tag = Buffer.from(envelope.tag, "base64url"), ciphertext = strictBase64(envelope.ciphertext, "KIT_ENVELOPE_INVALID");
  const key = deriveKey(salt); let plaintext;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv); decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch { fail("KIT_AUTHENTICATION_FAILED"); } finally { key.fill(0); }
  try {
    const payload = parseJson(plaintext.toString("utf8"), "KIT_PAYLOAD_INVALID"); assertInventory(payload, true);
    const keyPairs=recoveryKeyPairs(payload.files);assertDeclaredKeyPairs(payload.keyPairs,keyPairs,"KIT_PAYLOAD_KEY_PAIR_INVALID");
    const outputRoot = extract ? path.resolve(required("output-root")) : null;
    if (extract) { const rootStat = lstatSync(outputRoot); if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail("KIT_OUTPUT_ROOT_INVALID"); }
    for (const entry of payload.files) {
      const content = strictBase64(entry.bytes, "KIT_PAYLOAD_INVALID");
      try {
        if (sha256(content) !== entry.sha256) fail("KIT_ENTRY_HASH_MISMATCH");
        if (extract) writeFileSync(path.join(outputRoot, entry.name), content, { flag: "wx", mode: 0o600 });
      } finally { content.fill(0); }
    }
    process.stdout.write(`${JSON.stringify({ event: extract ? "recovery-kit.extracted" : "recovery-kit.verified",
      fileCount: payload.files.length, inventoryDigest: inventoryDigest(payload.files), kitId: sha256(bytes), installId: payload.installId,
      runtimeConfigSha256: payload.runtimeConfigSha256, manifestSha256: payload.manifestSha256,
      signingKeyPairInventoryDigest: keyPairDigest(keyPairs), signingKeyPairsVerified: true, keyPairs,
      files: payload.files.map(({ purpose, name, sha256: digest }) => ({ purpose, name, sha256: digest })) })}\n`);
  } finally { plaintext.fill(0); }
}

function assertInventory(value, payload) {
  if (!value || value.version !== 3 || !/^[a-z0-9][a-z0-9-]{7,63}$/.test(value.installId ?? "") ||
      !/^[a-f0-9]{64}$/.test(value.runtimeConfigSha256 ?? "") || !Array.isArray(value.files) ||
      !Array.isArray(value.keyPairs) || value.keyPairs.length !== 3 ||
      value.files.length !== REQUIRED_RECOVERY_PURPOSES.length || (payload &&
        (Number.isNaN(Date.parse(value.createdAt)) || !/^[a-f0-9]{64}$/.test(value.manifestSha256 ?? "")))) fail(payload ? "KIT_PAYLOAD_INVALID" : "KIT_MANIFEST_INVALID");
  const purposes = new Set(), names = new Set();
  for (const entry of value.files) {
    const commonInvalid = !entry || !REQUIRED_RECOVERY_PURPOSES.includes(entry.purpose) || purposes.has(entry.purpose) || names.has(entry.name) ||
      !/^[-a-z0-9_.]{1,80}$/.test(entry.name ?? "") || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? "");
    const modeInvalid = payload ? typeof entry.bytes !== "string" : typeof entry.path !== "string" || !path.isAbsolute(entry.path);
    if (commonInvalid || modeInvalid) fail(payload ? "KIT_PAYLOAD_INVALID" : "KIT_ENTRY_INVALID");
    purposes.add(entry.purpose); names.add(entry.name);
    if (entry.purpose === "runtime-config" && entry.sha256 !== value.runtimeConfigSha256) fail("KIT_CONFIG_BINDING_MISMATCH");
  }
  if (REQUIRED_RECOVERY_PURPOSES.some((purpose) => !purposes.has(purpose))) fail("KIT_REQUIRED_PURPOSE_MISSING");
}

function recoveryKeyPairs(files){
  const result=[];
  for(const [purpose,privatePurpose,publicPurpose] of KEY_PAIR_PURPOSES){
    const privateEntry=files.find((entry)=>entry.purpose===privatePurpose),publicEntry=files.find((entry)=>entry.purpose===publicPurpose);
    if(!privateEntry||!publicEntry)fail("KIT_REQUIRED_KEY_PAIR_MISSING");
    const privateBytes=strictBase64(privateEntry.bytes,"KIT_KEY_PAIR_INVALID"),publicBytes=strictBase64(publicEntry.bytes,"KIT_KEY_PAIR_INVALID");
    try{
      const privateKey=createPrivateKey(privateBytes),publicKey=createPublicKey(publicBytes),derived=createPublicKey(privateKey);
      if(privateKey.asymmetricKeyType!=="ed25519"||publicKey.asymmetricKeyType!=="ed25519"||!publicKey.export({type:"spki",format:"der"}).equals(derived.export({type:"spki",format:"der"})))fail("KIT_KEY_PAIR_INVALID");
      const challenge=Buffer.from(`recovery-kit-key-pair-v1:${purpose}`,"utf8"),signature=sign(null,challenge,privateKey);
      try{if(!verify(null,challenge,publicKey,signature))fail("KIT_KEY_PAIR_ROUNDTRIP_FAILED")}finally{challenge.fill(0);signature.fill(0)}
      result.push({purpose,publicKeySha256:publicEntry.sha256,signingKeyId:sha256(publicKey.export({type:"spki",format:"der"}))});
    }catch(error){if(error?.message?.startsWith("KIT_"))throw error;fail("KIT_KEY_PAIR_INVALID")}finally{privateBytes.fill(0);publicBytes.fill(0)}
  }
  return result;
}
function assertDeclaredKeyPairs(declared,actual,code){
  if(!Array.isArray(declared)||declared.length!==actual.length)fail(code);
  const normalized=[...declared].sort((a,b)=>String(a?.purpose).localeCompare(String(b?.purpose))),expected=[...actual].sort((a,b)=>a.purpose.localeCompare(b.purpose));
  for(let index=0;index<expected.length;index++){const item=normalized[index],wanted=expected[index];if(!item||Object.keys(item).sort().join("|")!=="publicKeySha256|purpose|signingKeyId"||item.purpose!==wanted.purpose||item.publicKeySha256!==wanted.publicKeySha256||item.signingKeyId!==wanted.signingKeyId)fail(code)}
}
function keyPairDigest(keyPairs){return sha256(Buffer.from([...keyPairs].sort((a,b)=>a.purpose.localeCompare(b.purpose)).map((entry)=>`${entry.purpose}\0${entry.publicKeySha256}\0${entry.signingKeyId}`).join("\n"),"utf8"));}

function required(name) { const value = args.get(name); if (!value) fail("ARGUMENT_REQUIRED"); return path.resolve(value); }
async function readPassphrase() {
  const chunks = []; let total = 0;
  for await (const chunk of process.stdin) { const part = Buffer.from(chunk); chunks.push(part); total += part.length; if (total > 1024) fail("PASSPHRASE_INVALID"); }
  const bytes = Buffer.concat(chunks), normalized = Buffer.from(bytes.toString("utf8").replace(/[\r\n]+$/, ""), "utf8"); bytes.fill(0);
  const counts = new Map(); for (const byte of normalized) counts.set(byte, (counts.get(byte) ?? 0) + 1);
  const entropyBits = [...counts.values()].reduce((total, count) => { const probability = count / normalized.length; return total - probability * Math.log2(probability); }, 0) * normalized.length;
  let periodic = false;
  for (let period = 1; period <= Math.floor(normalized.length / 2); period += 1) {
    if (normalized.length % period === 0 && normalized.every((byte, index) => byte === normalized[index % period])) { periodic = true; break; }
  }
  if (normalized.length < 32 || counts.size < 12 || entropyBits < 160 || periodic || Math.max(0, ...counts.values()) * 4 > normalized.length) { normalized.fill(0); fail("PASSPHRASE_INVALID"); }
  return normalized;
}
function deriveKey(salt) { return scryptSync(passphrase, salt, 32, { N: 65_536, r: 8, p: 1, maxmem: 128 * 1024 * 1024 }); }
function assertCanonicalPath(value) { const resolved=path.resolve(value), real=realpathSync.native(resolved); const comparable=(item)=>process.platform==="win32"?item.toLowerCase():item; if(comparable(resolved)!==comparable(real)) fail("KIT_ENTRY_PATH_INDIRECTION_REJECTED"); let cursor=resolved; while(true){if(lstatSync(cursor).isSymbolicLink())fail("KIT_ENTRY_PATH_INDIRECTION_REJECTED");const parent=path.dirname(cursor);if(parent===cursor)break;cursor=parent;} }
function inventoryDigest(files) { return sha256(Buffer.from([...files].sort((a,b)=>a.purpose.localeCompare(b.purpose)).map((entry)=>`${entry.purpose}\0${entry.name}\0${entry.sha256}`).join("\n"),"utf8")); }
function strictBase64(value, code) { if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail(code); return Buffer.from(value, "base64"); }
function parseJson(value, code) { try { return JSON.parse(value); } catch { fail(code); } }
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function fail(code) { throw new Error(code); }
