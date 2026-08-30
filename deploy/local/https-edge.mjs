import { createSecureContext } from "node:tls";
import { createServer } from "node:https";
import { createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { isIP } from "node:net";
import path from "node:path";
import { createHash, createPrivateKey, createPublicKey, randomUUID, sign, X509Certificate } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { validateLocalRuntimeConfig } from "./runtime-config.mjs";

export function createLocalHttpsEdge(rawConfig, options = {}) {
  const config = validateLocalRuntimeConfig(rawConfig, options);
  if(!/^[0-9a-f]{64}$/.test(options.runtimeConfigSha256??""))throw new Error("RUNTIME_CONFIG_HASH_REQUIRED");
  if (!config.network.lanReady) throw new Error("LAN_NOT_READY");
  if (!config.readiness.operationalReady) throw new Error("OPERATIONAL_READINESS_REQUIRED");
  const hostname = config.lan.hostname.toLowerCase();
  const certificate = readFileSync(config.tls.serverCertificatePath);
  const privateKey = readFileSync(config.tls.serverPrivateKeyPath);
  verifyCertificateMaterial(certificate, privateKey, readFileSync(config.tls.caCertificatePath), hostname, options.clientTrustEvidence);
  const secureContext = createSecureContext({ cert: certificate, key: privateKey, minVersion: "TLSv1.2" });
  const edgeSigningKey = createPrivateKey(readFileSync(config.hostSecurity.edgeSigningPrivateKeyPath));
  if (edgeSigningKey.asymmetricKeyType !== "ed25519") throw new Error("EDGE_SIGNING_PRIVATE_KEY_INVALID");
  const configuredEdgePublic = createPublicKey(readFileSync(config.hostSecurity.edgeSigningPublicKeyPath));
  const derivedEdgePublic = createPublicKey(edgeSigningKey);
  if (configuredEdgePublic.asymmetricKeyType !== "ed25519" ||
      !configuredEdgePublic.export({ type: "spki", format: "der" }).equals(derivedEdgePublic.export({ type: "spki", format: "der" }))) {
    throw new Error("EDGE_SIGNING_KEY_PAIR_MISMATCH");
  }
  const edgeSigningKeyId=createHash("sha256").update(configuredEdgePublic.export({type:"spki",format:"der"})).digest("hex");
  const nodeExecutableSha256=createHash("sha256").update(readFileSync(process.execPath)).digest("hex");
  const frozenEdgeConfig = edgeImmutableFingerprint(rawConfig);
  const startupRuntimeConfigSha256 = options.runtimeConfigSha256;
  const maintenanceFlag = path.join(config.data.root, "runtime-control", "maintenance.enabled");
  const drainStatePath = path.join(config.data.root, "logs", "edge", "drain-state.json");
  const requestSpoolRoot = path.join(config.data.root, "logs", "edge", "request-spool");
  prepareRequestSpool(requestSpoolRoot);
  try{if(existsSync(drainStatePath))unlinkSync(drainStatePath)}catch{throw new Error("STALE_DRAIN_STATE_REMOVE_FAILED")}
  let activeRequests = 0;
  let activeRequestBodies = 0;
  const requestsByClient = new Map();
  const socketsByClient = new Map();
  const requestBuckets = new Map();
  let globalBucket = { tokens: 120, at: Date.now() };
  let readinessCache = { expiresAt: 0, result: false };
  const handshakeTimers = new WeakMap();
  const server = createServer({
    cert: certificate,
    key: privateKey,
    minVersion: "TLSv1.2",
    handshakeTimeout: 5_000,
    SNICallback(servername, callback) {
      if (servername.toLowerCase() !== hostname) return callback(new Error("TLS_SERVER_NAME_REJECTED"));
      callback(null, secureContext);
    }
  }, (incoming, outgoing) => {
    if (incoming.socket.servername?.toLowerCase() !== hostname) return reject(outgoing, 421);
    if (!incoming.url || incoming.url.length > 8192 || !incoming.url.startsWith("/") || incoming.url.startsWith("//") || /[\r\n\0]/.test(incoming.url)) return reject(outgoing, 400);
    if (!new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]).has(incoming.method ?? "")) return reject(outgoing, 405);
    if (activeRequests >= 64) return reject(outgoing, 503);
    const remoteAddress = normalizeRemoteAddress(incoming.socket.remoteAddress);
    if (!remoteAddress || !config.lan.allowedCidrs.some((cidr) => ipv4InCidr(remoteAddress, cidr))) {
      return reject(outgoing, 403);
    }
    if (normalizeHost(incoming.headers.host) !== hostname) return reject(outgoing, 421);
    if (!takePerClientToken(requestBuckets, remoteAddress, 30, 60) || !takeGlobalToken(globalBucket)) return reject(outgoing, 429);
    if (Date.now() >= readinessCache.expiresAt) {
      readinessCache = { result: currentReadiness(frozenEdgeConfig, startupRuntimeConfigSha256, options), expiresAt: Date.now() + 2_000 };
    }
    if (!readinessCache.result) return reject(outgoing, 503);
    if (existsSync(maintenanceFlag)) return reject(outgoing, 503, { "x-local-release-id": config.release.id });
    if ((requestsByClient.get(remoteAddress) ?? 0) >= 8) return reject(outgoing, 503);
    const contentLength = parseContentLength(incoming.headers["content-length"]);
    if (contentLength > 64 * 1024 * 1024) return reject(outgoing, 413);
    const hasRequestBody = contentLength > 0 || incoming.headers["transfer-encoding"] !== undefined;
    if (hasRequestBody && activeRequestBodies >= 16) return reject(outgoing, 503);
    const edgeTarget = apiTarget(incoming.url);
    const isApiRequest = incoming.url === "/backend-api" || incoming.url.startsWith("/backend-api/");
    const upstreamPort = isApiRequest ? config.internalPorts.api : config.internalPorts.web;
    const upstreamPath = isApiRequest ? edgeTarget : incoming.url;
    activeRequests += 1;
    if (hasRequestBody) activeRequestBodies += 1;
    requestsByClient.set(remoteAddress, (requestsByClient.get(remoteAddress) ?? 0) + 1);
    let finished = false;
    const finish = () => {
      if (!finished) {
        finished = true;
        activeRequests -= 1;
        if (hasRequestBody) activeRequestBodies -= 1;
        decrement(requestsByClient, remoteAddress);
      }
    };
    let upstream,bodyReader,spoolPath;
    outgoing.once("close", () => {
      if (!outgoing.writableEnded) {
        incoming.destroy();
        upstream?.destroy();
        bodyReader?.destroy();
      }
      removeSpool(spoolPath,requestSpoolRoot);
      finish();
    });
    void (async()=>{
      let body={sha256:createHash("sha256").digest("hex"),bytes:0,path:undefined};
      if(hasRequestBody){body=await spoolRequestBody(incoming,requestSpoolRoot);spoolPath=body.path}
      const headers=sanitizedHeaders(incoming.headers);const edgeTimestamp=String(Date.now());const edgeNonce=randomUUID();
      headers["x-forwarded-for"]=remoteAddress;headers["x-forwarded-proto"]="https";headers["x-local-client-ip"]=remoteAddress;
      headers["x-local-edge-timestamp"]=edgeTimestamp;headers["x-local-edge-nonce"]=edgeNonce;headers["x-local-edge-target"]=edgeTarget;
      headers["x-local-edge-body-sha256"]=body.sha256;headers["content-length"]=String(body.bytes);headers.host=`127.0.0.1:${upstreamPort}`;
      headers["x-local-edge-signature"]=sign(null,Buffer.from(`${remoteAddress}\0${edgeTimestamp}\0${edgeNonce}\0${incoming.method}\0${edgeTarget}\0${body.sha256}`,"utf8"),edgeSigningKey).toString("base64url");
      upstream=httpRequest({hostname:"127.0.0.1",port:upstreamPort,method:incoming.method,path:upstreamPath,headers,timeout:310_000},(response)=>{
        const responseHeaders=sanitizedHeaders(response.headers);delete responseHeaders["strict-transport-security"];
        if(config.tls.hstsEnabled)responseHeaders["strict-transport-security"]="max-age=300";
        outgoing.writeHead(response.statusCode??502,responseHeaders);response.pipe(outgoing);
      });
      upstream.on("timeout",()=>upstream.destroy(new Error("UPSTREAM_TIMEOUT")));
      upstream.on("error",()=>reject(outgoing,503));upstream.once("close",()=>{removeSpool(spoolPath,requestSpoolRoot);finish()});
      if(spoolPath){bodyReader=createReadStream(spoolPath);bodyReader.once("error",()=>upstream.destroy());bodyReader.pipe(upstream)}else upstream.end();
    })().catch((error)=>{removeSpool(spoolPath,requestSpoolRoot);const code=String(error?.message??error);reject(outgoing,code==="REQUEST_BODY_TOO_LARGE"?413:code.includes("REQUEST_BODY_")?408:503);finish()});
  });
  server.on("connection", (socket) => {
    const address = normalizeRemoteAddress(socket.remoteAddress);
    if (!address || !config.lan.allowedCidrs.some((cidr) => ipv4InCidr(address, cidr)) ||
        (socketsByClient.get(address) ?? 0) >= 12) return socket.destroy();
    socketsByClient.set(address, (socketsByClient.get(address) ?? 0) + 1);
    const timer = setTimeout(() => socket.destroy(), 5_000);
    timer.unref();
    handshakeTimers.set(socket, timer);
    socket.once("close", () => { clearTimeout(timer); handshakeTimers.delete(socket); decrement(socketsByClient, address); });
  });
  server.on("secureConnection", (socket) => {
    const timer = handshakeTimers.get(socket); if (timer) clearTimeout(timer); handshakeTimers.delete(socket);
    if (socket.servername?.toLowerCase() !== hostname) socket.destroy();
  });
  server.on("upgrade", (_request, socket) => socket.destroy());
  server.requestTimeout = 320_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 100;
  server.maxConnections = 96;
  server.maxRequestsPerSocket = 100;
  const drainTimer=setInterval(()=>publishDrainState(),250);drainTimer.unref();
  server.once("close",()=>{clearInterval(drainTimer);try{unlinkSync(drainStatePath)}catch{}});
  return { server, config };

  function publishDrainState(){
    try{
      if(!existsSync(maintenanceFlag)||activeRequests!==0){if(existsSync(drainStatePath))unlinkSync(drainStatePath);return;}
      if(existsSync(drainStatePath))return;
      const temporary=`${drainStatePath}.${process.pid}.pending`;
      const unsigned={attestationType:"edge-drain",version:2,result:"DRAINED",processId:process.pid,releaseId:config.release.id,runtimeConfigSha256:options.runtimeConfigSha256,nodeExecutableSha256,listenerAddress:config.lan.bindAddress,listenerPort:443,activeRequests:0,completedAt:new Date().toISOString()};
      const state={...unsigned,signingKeyId:edgeSigningKeyId,attestationSignature:sign(null,Buffer.from(canonicalJson(unsigned),"utf8"),edgeSigningKey).toString("base64url")};
      writeFileSync(temporary,JSON.stringify(state),{encoding:"utf8",flag:"w"});
      renameSync(temporary,drainStatePath);
    }catch{}
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key)=>`${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export function startLocalHttpsEdge(rawConfig, options = {}) {
  const { server, config } = createLocalHttpsEdge(rawConfig, options);
  return new Promise((resolve, rejectStart) => {
    server.once("error", rejectStart);
    server.listen(443, config.lan.bindAddress, () => {
      server.off("error", rejectStart);
      resolve({ server, address: config.lan.bindAddress, port: 443 });
    });
  });
}

function normalizeHost(value) {
  if (typeof value !== "string" || value.length > 255 || value.includes("@")) return null;
  try {
    const parsed = new URL(`https://${value}/`);
    if (parsed.port && parsed.port !== "443") return null;
    return parsed.hostname.toLowerCase();
  } catch { return null; }
}

function normalizeRemoteAddress(value) {
  if (!value) return null;
  const normalized = value.startsWith("::ffff:") ? value.slice(7) : value;
  return isIP(normalized) === 4 ? normalized : null;
}

function ipv4InCidr(address, cidr) {
  const [network, prefixText] = cidr.split("/");
  const prefix = Number(prefixText);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipv4Number(address) & mask) === (ipv4Number(network) & mask);
}
function sanitizedHeaders(source) {
  const result = { ...source };
  const connectionTokens = String(source.connection ?? "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
  for (const name of [
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer",
    "transfer-encoding", "upgrade", "forwarded", "x-forwarded-for", "x-forwarded-host",
    "x-forwarded-port", "x-forwarded-proto", "x-real-ip", "x-local-client-ip",
    "x-local-edge-timestamp", "x-local-edge-nonce", "x-local-edge-target", "x-local-edge-body-sha256", "x-local-edge-signature", ...connectionTokens
  ]) delete result[name];
  return result;
}
function parseContentLength(value) {
  if (value === undefined) return 0;
  const normalized = Array.isArray(value) ? value.join(",") : String(value);
  if (!/^\d+$/.test(normalized)) return Number.POSITIVE_INFINITY;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : Number.POSITIVE_INFINITY;
}
function verifyCertificateMaterial(certificatePem, privateKeyPem, caBytes, hostname, evidence) {
  const certificate = new X509Certificate(certificatePem);
  const ca = new X509Certificate(caBytes);
  if (!certificate.checkHost(hostname, { wildcards: false }) || !certificate.verify(ca.publicKey)) throw new Error("SERVER_CERTIFICATE_INVALID");
  const now = Date.now();
  if (Date.parse(certificate.validFrom) > now || Date.parse(certificate.validTo) <= now) throw new Error("SERVER_CERTIFICATE_EXPIRED");
  const certificateKey = certificate.publicKey.export({ type: "spki", format: "der" });
  const privatePublic = createPublicKey(createPrivateKey(privateKeyPem)).export({ type: "spki", format: "der" });
  if (!certificateKey.equals(privatePublic)) throw new Error("SERVER_PRIVATE_KEY_MISMATCH");
  const expected = String(evidence?.caThumbprint ?? "").replace(/:/g, "").toUpperCase();
  const actualSha1 = ca.fingerprint.replace(/:/g, "").toUpperCase();
  const actualSha256 = ca.fingerprint256.replace(/:/g, "").toUpperCase();
  if (expected !== actualSha1 && expected !== actualSha256) throw new Error("CA_EVIDENCE_MISMATCH");
  if (createHash("sha256").update(certificatePem).digest("hex") !== evidence?.serverCertificateSha256) {
    throw new Error("SERVER_CERTIFICATE_EVIDENCE_MISMATCH");
  }
}
function ipv4Number(value) { return value.split(".").reduce((total, part) => ((total << 8) | Number(part)) >>> 0, 0); }
function apiTarget(url) {
  if (url === "/backend-api") return "/api";
  if (url.startsWith("/backend-api/")) return `/api/${url.slice("/backend-api/".length)}`;
  return url;
}
function currentReadiness(frozenEdgeConfig, startupRuntimeConfigSha256, options) {
  try {
    if (typeof options.readinessProvider !== "function") return true;
    const current = options.readinessProvider();
    if (!current || !runtimeConfigIdentityMatches(frozenEdgeConfig,startupRuntimeConfigSha256,current.rawConfig,current.evidence?.runtimeConfigSha256)) return false;
    const checked = validateLocalRuntimeConfig(current.rawConfig, current.evidence);
    if (!checked.network.lanReady || !checked.readiness.operationalReady) return false;
    verifyCertificateMaterial(
      readFileSync(checked.tls.serverCertificatePath), readFileSync(checked.tls.serverPrivateKeyPath),
      readFileSync(checked.tls.caCertificatePath), checked.lan.hostname.toLowerCase(), current.evidence.clientTrustEvidence
    );
    return true;
  } catch { return false; }
}
function edgeImmutableFingerprint(rawConfig) {
  return JSON.stringify(rawConfig);
}
export function runtimeConfigIdentityMatches(frozenConfig,startupSha256,currentRawConfig,currentSha256){return /^[0-9a-f]{64}$/.test(startupSha256??"")&&currentSha256===startupSha256&&edgeImmutableFingerprint(currentRawConfig)===frozenConfig;}
function decrement(map, key) { const next=(map.get(key)??1)-1; if(next<=0)map.delete(key);else map.set(key,next); }
function prepareRequestSpool(root){
  mkdirSync(root,{recursive:true,mode:0o700});assertDirectoryChain(root);
  const now=Date.now();const entries=readdirSync(root,{withFileTypes:true});if(entries.length>1024)throw new Error("REQUEST_SPOOL_CARDINALITY_INVALID");
  for(const entry of entries){
    if(!/^request-[0-9a-f-]{36}\.body$/.test(entry.name)||!entry.isFile()||entry.isSymbolicLink())throw new Error("REQUEST_SPOOL_CONTENT_INVALID");
    const candidate=path.join(root,entry.name);const stat=lstatSync(candidate);if(now-stat.mtimeMs>10*60_000)unlinkSync(candidate);
  }
}
function assertDirectoryChain(value){
  const resolved=path.resolve(value);let cursor=path.parse(resolved).root;
  for(const segment of resolved.slice(cursor.length).split(path.sep).filter(Boolean)){cursor=path.join(cursor,segment);const stat=lstatSync(cursor);if(stat.isSymbolicLink()||!stat.isDirectory())throw new Error("REQUEST_SPOOL_REPARSE_REJECTED")}
}
async function spoolRequestBody(incoming,root){
  const spoolPath=path.join(root,`request-${randomUUID()}.body`);const hash=createHash("sha256");let bytes=0;
  const bodyWatchdog=createBodyIdleWatchdog(()=>incoming.destroy(new Error("REQUEST_BODY_IDLE_TIMEOUT")),15_000);
  const bodyBudget=createBodyTransferBudget(()=>incoming.destroy(new Error("REQUEST_BODY_RATE_OR_DEADLINE_EXCEEDED")));
  const meter=new Transform({transform(chunk,_encoding,callback){bytes+=chunk.length;bodyWatchdog.activity();bodyBudget.activity(chunk);if(bytes>64*1024*1024)callback(new Error("REQUEST_BODY_TOO_LARGE"));else{hash.update(chunk);callback(null,chunk)}}});
  bodyWatchdog.activity();
  try{await pipeline(incoming,meter,createWriteStream(spoolPath,{flags:"wx",mode:0o600}));return{sha256:hash.digest("hex"),bytes,path:spoolPath}}
  catch(error){removeSpool(spoolPath,root);throw error}
  finally{bodyWatchdog.complete();bodyBudget.complete()}
}
function removeSpool(value,root){
  if(!value)return;const full=path.resolve(value),boundary=path.resolve(root);if(path.dirname(full)!==boundary||!/^request-[0-9a-f-]{36}\.body$/.test(path.basename(full)))return;
  try{const stat=lstatSync(full);if(stat.isFile()&&!stat.isSymbolicLink())unlinkSync(full)}catch{}
}
export function createBodyIdleWatchdog(onIdle, timeoutMs = 15_000) {
  if (typeof onIdle !== "function" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("BODY_WATCHDOG_ARGUMENT_INVALID");
  let timer;
  let complete = false;
  const clear = () => { if (timer) clearTimeout(timer); timer = undefined; };
  return {
    activity() {
      if (complete) return;
      clear();
      timer = setTimeout(() => { timer = undefined; if (!complete) onIdle(); }, timeoutMs);
      timer.unref?.();
    },
    complete() { complete = true; clear(); }
  };
}
export function createBodyTransferBudget(
  onExceeded,
  { deadlineMs = 300_000, graceMs = 15_000, sampleMs = 5_000, minimumBytesPerSecond = 32 * 1024 } = {}
) {
  if (typeof onExceeded !== "function" || ![deadlineMs, graceMs, sampleMs, minimumBytesPerSecond].every(Number.isSafeInteger) ||
      deadlineMs < 1 || graceMs < 0 || sampleMs < 1 || minimumBytesPerSecond < 1 || graceMs >= deadlineMs) {
    throw new Error("BODY_TRANSFER_BUDGET_ARGUMENT_INVALID");
  }
  let bytes = 0;
  let completed = false;
  const startedAt = Date.now();
  const deadline = setTimeout(exceed, deadlineMs);
  deadline.unref?.();
  const sampler = setInterval(() => {
    const elapsedMs = Date.now() - startedAt;
    if (!completed && elapsedMs > graceMs && bytes * 1000 < minimumBytesPerSecond * elapsedMs) exceed();
  }, sampleMs);
  sampler.unref?.();
  function clear() { clearTimeout(deadline); clearInterval(sampler); }
  function exceed() { if (!completed) { completed = true; clear(); onExceeded(); } }
  return {
    activity(chunk) { if (!completed) bytes += Buffer.byteLength(chunk); },
    complete() { if (!completed) { completed = true; clear(); } }
  };
}
export function takePerClientToken(map,key,rate,burst,{now=Date.now(),maximumEntries=4096,staleAfterMs=10*60_000}={}){
  if(!(map instanceof Map)||typeof key!=="string"||!Number.isFinite(rate)||rate<=0||!Number.isFinite(burst)||burst<1||
      !Number.isSafeInteger(maximumEntries)||maximumEntries<1||!Number.isSafeInteger(staleAfterMs)||staleAfterMs<1) throw new Error("RATE_BUCKET_ARGUMENT_INVALID");
  let current=map.get(key);
  if(!current){
    if(map.size>=maximumEntries){
      for(const [candidate,value] of map){if(now-value.at>=staleAfterMs)map.delete(candidate)}
    }
    if(map.size>=maximumEntries)return false;
    current={tokens:burst,at:now};
  }
  current.tokens=Math.min(burst,current.tokens+(now-current.at)*rate/1000);current.at=now;
  if(current.tokens<1){map.set(key,current);return false}
  current.tokens-=1;map.set(key,current);return true
}
function takeGlobalToken(bucket){const now=Date.now();bucket.tokens=Math.min(120,bucket.tokens+(now-bucket.at)*60/1000);bucket.at=now;if(bucket.tokens<1)return false;bucket.tokens-=1;return true}
function reject(response, status, extraHeaders = {}) { if (!response.headersSent) response.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", connection: "close", ...extraHeaders }); response.end("Request rejected.\n"); }
