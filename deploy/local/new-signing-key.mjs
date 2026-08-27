import { generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";

const [privatePath, publicPath] = process.argv.slice(2);
if (!privatePath || !publicPath || privatePath === publicPath) throw new Error("SIGNING_KEY_TARGETS_REQUIRED");
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
writeFileSync(privatePath, privateKey.export({ type: "pkcs8", format: "pem" }), { flag: "wx", mode: 0o600 });
writeFileSync(publicPath, publicKey.export({ type: "spki", format: "pem" }), { flag: "wx", mode: 0o644 });
