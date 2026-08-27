import { createPrivateKey, createPublicKey, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";

const [caPath, certificatePath, keyPath, hostname] = process.argv.slice(2);
if (!caPath || !certificatePath || !keyPath || !hostname) throw new Error("TLS_VERIFY_ARGUMENTS_REQUIRED");
const ca = new X509Certificate(readFileSync(caPath));
const certificate = new X509Certificate(readFileSync(certificatePath));
const privateKey = createPrivateKey(readFileSync(keyPath));
if (!ca.ca || certificate.ca || !certificate.checkHost(hostname, { wildcards: false }) || !certificate.verify(ca.publicKey)) throw new Error("TLS_CERTIFICATE_CHAIN_INVALID");
if (Date.parse(certificate.validFrom) > Date.now() || Date.parse(certificate.validTo) < Date.now() + 30 * 24 * 3600_000) throw new Error("TLS_CERTIFICATE_LIFETIME_INVALID");
const publicDer = certificate.publicKey.export({ type: "spki", format: "der" });
const privatePublicDer = createPublicKey(privateKey).export({ type: "spki", format: "der" });
if (!publicDer.equals(privatePublicDer)) throw new Error("TLS_PRIVATE_KEY_MISMATCH");
process.stdout.write(`${JSON.stringify({ result: "PASS", hostnameMatched: true, chainVerified: true, privateKeyMatched: true })}\n`);
